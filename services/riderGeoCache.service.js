/**
 * Redis GEO index for online riders — fast nearby lookup at order dispatch.
 * MongoDB remains source of truth for rider eligibility (isOnline, activeOrderId, etc.).
 */
const { isRedisReady, getRedisClient } = require('../config/redis');

const GEO_KEY = 'riders:online';
const META_KEY = 'riders:online:meta';

function riderId(userId) {
  return String(userId);
}

function isAvailable() {
  return isRedisReady();
}

async function upsertRiderLocation(userId, lng, lat, lastLocationAt = new Date()) {
  if (!isAvailable()) return;
  const id = riderId(userId);
  try {
    const client = getRedisClient();
    await client.geoadd(GEO_KEY, lng, lat, id);
    await client.hset(
      META_KEY,
      id,
      JSON.stringify({ lastLocationAt: new Date(lastLocationAt).toISOString() })
    );
  } catch {
    /* non-fatal */
  }
}

async function removeRider(userId) {
  if (!isAvailable()) return;
  const id = riderId(userId);
  try {
    const client = getRedisClient();
    await client.zrem(GEO_KEY, id);
    await client.hdel(META_KEY, id);
  } catch {
    /* non-fatal */
  }
}

async function removeRiders(userIds) {
  if (!isAvailable() || !userIds?.length) return;
  const ids = userIds.map(riderId);
  try {
    const client = getRedisClient();
    if (ids.length === 1) {
      await client.zrem(GEO_KEY, ids[0]);
      await client.hdel(META_KEY, ids[0]);
    } else {
      await client.zrem(GEO_KEY, ...ids);
      await client.hdel(META_KEY, ...ids);
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * @returns {Promise<string[]>} rider userIds within radius (meters)
 */
async function findNearbyUserIds(lng, lat, radiusM) {
  if (!isAvailable()) return [];
  try {
    const client = getRedisClient();
    const members = await client.georadius(GEO_KEY, lng, lat, radiusM, 'm');
    return (members || []).map(String);
  } catch {
    return [];
  }
}

/** Sync geo index from a rider document after duty/location changes. */
async function syncFromRider(rider) {
  if (!rider?.userId) return;
  const coords = rider.currentLocation?.coordinates;
  if (rider.isOnline && Array.isArray(coords) && coords.length >= 2) {
    await upsertRiderLocation(
      rider.userId,
      coords[0],
      coords[1],
      rider.lastLocationAt || new Date()
    );
  } else {
    await removeRider(rider.userId);
  }
}

module.exports = {
  GEO_KEY,
  isAvailable,
  upsertRiderLocation,
  removeRider,
  removeRiders,
  findNearbyUserIds,
  syncFromRider,
};
