const Order = require('../models/Order');
const Rider = require('../models/Rider');
const { sendDataOnlyPush } = require('../config/firebase');
const riderGeo = require('./riderGeoCache.service');

const RIDER_BROADCAST_RADIUS_M = 7000;
const RIDER_SEARCH_TIMEOUT_MS = 40 * 1000;
/**
 * Riders whose last GPS push is older than this are "stale".
 * Must be > rider-app push interval (3 min) with headroom for missed pushes.
 */
const RIDER_LOCATION_STALE_MS = 15 * 60 * 1000;
/** Online with no usable GPS for this long → treat as ghost and force offline */
const RIDER_ONLINE_GHOST_MS = 2 * 60 * 60 * 1000;
const activeRiderSearchTimers = new Map();

function isValidCoordinates(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return false;
  const [lng, lat] = coords;
  if (lng == null || lat == null || Number.isNaN(lng) || Number.isNaN(lat)) return false;
  if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function isFreshLocation(rider, now = Date.now()) {
  if (!rider?.lastLocationAt) return false;
  const ts = new Date(rider.lastLocationAt).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts <= RIDER_LOCATION_STALE_MS;
}

/**
 * Logout/re-login leaves old Rider rows stuck isOnline=true with no GPS/socket.
 * Demote those ghosts so they don't steal broadcasts from the live account.
 */
async function demoteGhostOnlineRiders() {
  const ghostBefore = new Date(Date.now() - RIDER_ONLINE_GHOST_MS);
  const ghostQuery = {
    isOnline: true,
    activeOrderId: null,
    $or: [
      { lastLocationAt: null, updatedAt: { $lt: ghostBefore } },
      { lastLocationAt: { $lt: ghostBefore } },
    ],
  };

  const ghosts = await Rider.find(ghostQuery).select('userId').lean();
  if (!ghosts.length) return 0;

  const result = await Rider.updateMany(ghostQuery, {
    $set: { isOnline: false, dutyStartedAt: null },
  });
  await riderGeo.removeRiders(ghosts.map((g) => g.userId));

  const n = result.modifiedCount ?? result.nModified ?? 0;
  if (n > 0) {
    console.log(`[RIDER SEARCH] Demoted ${n} ghost online rider(s) (stale/missing GPS)`);
  }
  return n;
}

async function findEligibleRidersNearKitchen(kitchenCoords) {
  if (!isValidCoordinates(kitchenCoords)) return [];

  await demoteGhostOnlineRiders();

  const [lng, lat] = kitchenCoords;
  let riders = [];

  const geoUserIds = await riderGeo.findNearbyUserIds(lng, lat, RIDER_BROADCAST_RADIUS_M);

  if (geoUserIds.length > 0) {
    riders = await Rider.find({
      userId: { $in: geoUserIds },
      isOnline: true,
      accountStatus: 'active',
      activeOrderId: null,
    });
    console.log(`[RIDER SEARCH] Redis GEO candidates: ${geoUserIds.length}, Mongo eligible: ${riders.length}`);
  }

  if (riders.length === 0) {
    riders = await Rider.find({
      isOnline: true,
      accountStatus: 'active',
      activeOrderId: null,
      currentLocation: {
        $near: {
          $geometry: { type: 'Point', coordinates: kitchenCoords },
          $maxDistance: RIDER_BROADCAST_RADIUS_M,
        },
      },
    });
    console.log(`[RIDER SEARCH] Mongo $near fallback: ${riders.length} rider(s)`);
  }

  console.log(`[RIDER SEARCH] Kitchen coords: ${JSON.stringify(kitchenCoords)}`);
  console.log(`[RIDER SEARCH] Online riders in radius (isOnline+active+noOrder): ${riders.length}`);
  riders.forEach((r) => {
    console.log(
      `  -> userId: ${r.userId}, lastLocationAt: ${r.lastLocationAt}, hasPush: ${!!r.expoPushToken}, coords: ${JSON.stringify(r.currentLocation?.coordinates)}`
    );
  });

  const now = Date.now();
  const withValidCoords = riders.filter((r) => isValidCoordinates(r.currentLocation?.coordinates));

  // Only riders with a recent GPS stamp count as "fresh".
  // (null lastLocationAt is NOT fresh — that was letting ghost accounts steal the broadcast.)
  const fresh = withValidCoords.filter((r) => isFreshLocation(r, now));
  if (fresh.length > 0) {
    console.log(`[RIDER SEARCH] Eligible fresh GPS: ${fresh.length}`);
    return fresh;
  }

  // Fallback: online nearby with valid coords, excluding long-dead ghosts without push
  const fallback = withValidCoords.filter(
    (r) => !!r.expoPushToken || !!r.lastLocationAt
  );
  console.log(
    `[RIDER SEARCH] No fresh GPS — falling back to ${fallback.length} online-in-radius rider(s)`
  );
  return fallback;
}

async function emitRiderStatusToKitchen(io, order, riderStatus, populatedOrder) {
  if (!io || !order?.kitchenId) return;
  const kitchenId = order.kitchenId._id?.toString() || order.kitchenId.toString();
  const orderId = order._id?.toString() || order._id;
  const payload = {
    orderId,
    riderStatus,
    ...(populatedOrder ? { order: populatedOrder } : {}),
  };
  io.to(`kitchen_${kitchenId}`).emit('order:rider_status_update', payload);
  io.to(`order_${orderId}`).emit('order:rider_status_update', payload);
}

async function revokeBroadcastToRiders(io, order, reason = 'Order no longer available') {
  if (!io || !order) return;
  const orderId = order._id?.toString() || String(order._id);
  const riderUserIds = (order.riderBroadcasts || []).map((id) => id.toString());
  if (!riderUserIds.length) return;

  const riders = await Rider.find({ userId: { $in: riderUserIds } })
    .select('userId expoPushToken')
    .lean();
  const tokenByUser = new Map(riders.map((r) => [r.userId.toString(), r.expoPushToken]));

  for (const uid of riderUserIds) {
    io.to(`rider_${uid}`).emit('rider:orderRevoked', orderId);
    const token = tokenByUser.get(uid);
    if (token) {
      sendDataOnlyPush(token, {
        type: 'order_revoked',
        orderId,
        reason,
      });
    }
  }
}

function clearRiderSearchExpiry(orderId) {
  const key = `rider_search_${orderId}`;
  const existing = activeRiderSearchTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    activeRiderSearchTimers.delete(key);
  }
}

function scheduleRiderSearchExpiry(orderId, io) {
  const key = `rider_search_${orderId}`;
  clearRiderSearchExpiry(orderId);

  const timerId = setTimeout(async () => {
    activeRiderSearchTimers.delete(key);
    try {
      const updated = await Order.findOneAndUpdate(
        {
          _id: orderId,
          deliveryMethod: 'rider',
          riderStatus: 'pending',
          riderId: null,
          status: 'ready',
        },
        { $set: { riderStatus: 'ignored_all' } },
        { new: true }
      );
      if (updated) {
        await emitRiderStatusToKitchen(io, updated, 'ignored_all', updated);
      }
    } catch (err) {
      console.error('[RIDER SEARCH TIMEOUT ERROR]', err);
    }
  }, RIDER_SEARCH_TIMEOUT_MS);

  activeRiderSearchTimers.set(key, timerId);
}

async function expireStaleRiderSearches(kitchenId, io) {
  const cutoff = new Date(Date.now() - RIDER_SEARCH_TIMEOUT_MS);
  const query = {
    deliveryMethod: 'rider',
    riderStatus: 'pending',
    riderId: null,
    status: 'ready',
    riderSearchStartedAt: { $lt: cutoff },
  };
  if (kitchenId) query.kitchenId = kitchenId;

  const stale = await Order.find(query).select('_id kitchenId');
  if (!stale.length) return;

  await Order.updateMany(
    { _id: { $in: stale.map((o) => o._id) } },
    { $set: { riderStatus: 'ignored_all' } }
  );

  if (io) {
    for (const o of stale) {
      clearRiderSearchExpiry(o._id);
      await emitRiderStatusToKitchen(io, o, 'ignored_all');
    }
  }
}

function startRiderSearchExpiryJob(io) {
  // Run immediately on server start to recover stale orders from before restart
  expireStaleRiderSearches(null, io).catch((err) => {
    console.error('[RIDER SEARCH STARTUP RECOVERY ERROR]', err);
  });

  // Then run every 15 seconds as a periodic sweep
  setInterval(() => {
    expireStaleRiderSearches(null, io).catch((err) => {
      console.error('[RIDER SEARCH EXPIRY JOB ERROR]', err);
    });
  }, 15000);
}

module.exports = {
  RIDER_BROADCAST_RADIUS_M,
  RIDER_SEARCH_TIMEOUT_MS,
  RIDER_LOCATION_STALE_MS,
  isValidCoordinates,
  isFreshLocation,
  demoteGhostOnlineRiders,
  findEligibleRidersNearKitchen,
  emitRiderStatusToKitchen,
  revokeBroadcastToRiders,
  scheduleRiderSearchExpiry,
  clearRiderSearchExpiry,
  expireStaleRiderSearches,
  startRiderSearchExpiryJob,
};
