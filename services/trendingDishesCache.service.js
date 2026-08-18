const { geoCacheKey, getAffectedGridCells } = require('../utils/geohash');
const { cacheGet, cacheSet, cacheInvalidateByPrefixes } = require('./cacheHelper.service');

const NAMESPACE = 'trending';
const TTL_MS = 5 * 60 * 1000; // 5 min — order counts change slowly

function poolCacheKey(lat, lng) {
  return `${geoCacheKey(lat, lng)}:pool50`;
}

/** @deprecated limit-scoped keys — use pool cache */
function cacheKey(lat, lng, limit) {
  return `${geoCacheKey(lat, lng)}:l${limit}`;
}

async function getPool(lat, lng) {
  return cacheGet(NAMESPACE, poolCacheKey(lat, lng));
}

async function setPool(lat, lng, pool, ttlMs = TTL_MS) {
  return cacheSet(NAMESPACE, poolCacheKey(lat, lng), pool, ttlMs);
}

async function get(lat, lng, limit) {
  return cacheGet(NAMESPACE, cacheKey(lat, lng, limit));
}

async function set(lat, lng, limit, value, ttlMs = TTL_MS) {
  return cacheSet(NAMESPACE, cacheKey(lat, lng, limit), value, ttlMs);
}

/** Clear trending cache for geohash cells around a kitchen location. */
async function invalidateAround(lat, lng, radiusKm) {
  const cells = getAffectedGridCells(lat, lng, radiusKm);
  if (!cells.length) return { cellsCleared: 0 };

  const prefixes = cells.map(({ gridLat, gridLng }) => `${geoCacheKey(gridLat, gridLng)}:`);
  await cacheInvalidateByPrefixes(NAMESPACE, prefixes);

  return { cellsCleared: cells.length };
}

module.exports = {
  getPool,
  setPool,
  get,
  set,
  invalidateAround,
  TTL_MS,
};
