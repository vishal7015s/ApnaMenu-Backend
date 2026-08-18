/**
 * Shared rider on/off-duty application — used by toggle-duty API and failsafe crons.
 * Keeps Mongo isOnline, dutyStartedAt, and Redis GEO in sync.
 */
const Rider = require('../models/Rider');
const riderGeo = require('./riderGeoCache.service');
const { sendPushNotification, sendDataOnlyPush } = require('../config/firebase');

/**
 * Apply absolute online/offline (not a flip).
 * @param {import('mongoose').Document|object|string} riderOrId - Rider doc, _id, or userId lookup via find
 * @param {boolean} isOnline
 * @param {{ io?: object, findBy?: 'id'|'userId' }} [opts]
 */
async function applyRiderOnlineState(riderOrId, isOnline, { io, findBy = 'id' } = {}) {
  let rider = riderOrId;
  if (!rider || typeof rider.save !== 'function') {
    if (findBy === 'userId') {
      rider = await Rider.findOne({ userId: riderOrId });
    } else {
      rider = await Rider.findById(riderOrId?._id || riderOrId);
    }
  }
  if (!rider) {
    return { rider: null, changed: false };
  }

  const next = !!isOnline;
  if (rider.isOnline === next) {
    // Still sync clocks / GEO if already offline but dutyStartedAt stale
    if (!next && rider.dutyStartedAt) {
      rider.dutyStartedAt = null;
      await rider.save();
      await riderGeo.syncFromRider(rider);
    }
    return { rider, changed: false };
  }

  rider.isOnline = next;
  if (next) {
    rider.dutyStartedAt = new Date();
  } else {
    rider.dutyStartedAt = null;
  }
  await rider.save();
  await riderGeo.syncFromRider(rider);

  return { rider, changed: true };
}

/**
 * Atomic claim offline for a rider matching query conditions (prevents double FCM).
 * Returns updated doc or null if already offline / not matching.
 */
async function claimRiderOffline(riderId, extraFilter = {}) {
  const updated = await Rider.findOneAndUpdate(
    {
      _id: riderId,
      isOnline: true,
      ...extraFilter,
    },
    {
      $set: {
        isOnline: false,
        dutyStartedAt: null,
      },
    },
    { new: true }
  );
  if (updated) {
    await riderGeo.syncFromRider(updated);
  }
  return updated;
}

/**
 * Notify rider they were forced offline (high-priority tray by default).
 * @param {object} rider
 * @param {{ title: string, body: string, type: string, silent?: boolean, io?: object, reason: string }} opts
 */
async function notifyRiderForcedOffline(rider, opts) {
  const {
    title,
    body,
    type,
    silent = false,
    io,
    reason,
  } = opts;

  const userId = rider.userId?.toString?.() || String(rider.userId);

  if (io && userId) {
    try {
      io.to(`rider_${userId}`).emit('rider:kicked_offline', {
        reason,
        message: body,
        type,
      });
      io.to(`rider_${userId}`).emit('rider:dutyUpdate', {
        isOnline: false,
        reason,
      });
    } catch (_) {}
  }

  const token = rider.expoPushToken;
  if (!token) return;

  try {
    if (silent) {
      await sendDataOnlyPush(token, {
        type,
        reason,
        title,
        body,
        isOnline: 'false',
      });
    } else {
      await sendPushNotification(token, title, body, {
        type,
        reason,
        isOnline: 'false',
      });
    }
  } catch (err) {
    console.error('[riderDuty] FCM failed:', err?.message || err);
  }
}

/**
 * Force offline one rider by document (atomic if still online).
 */
async function forceRiderOffline(rider, { title, body, type, silent, io, reason, extraFilter }) {
  const id = rider._id;
  const updated = await claimRiderOffline(id, extraFilter || {});
  if (!updated) {
    return { offline: false, rider };
  }
  await notifyRiderForcedOffline(updated, {
    title,
    body,
    type,
    silent,
    io,
    reason,
  });
  return { offline: true, rider: updated };
}

module.exports = {
  applyRiderOnlineState,
  claimRiderOffline,
  notifyRiderForcedOffline,
  forceRiderOffline,
};
