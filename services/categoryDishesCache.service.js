const { geoCacheKey, getAffectedGridCells } = require('../utils/geohash');
const { cacheGet, cacheSet, cacheInvalidateByPrefixes } = require('./cacheHelper.service');

const NAMESPACE = 'category';
/** Category lists change with menu/stock; slightly longer than nearby open/close. */
const TTL_MS = 3 * 60 * 1000; // 3 min

function poolCacheKey(lat, lng, categoryId) {
  return `${geoCacheKey(lat, lng)}:cat:${String(categoryId)}:pool`;
}

async function getPool(lat, lng, categoryId) {
  return cacheGet(NAMESPACE, poolCacheKey(lat, lng, categoryId));
}

async function setPool(lat, lng, categoryId, value, ttlMs = TTL_MS) {
  return cacheSet(NAMESPACE, poolCacheKey(lat, lng, categoryId), value, ttlMs);
}

/**
 * Clear all category pools for geohash cells around a kitchen.
 * Prefix `nearby:{lat}:{lng}:cat:` drops every category in that cell — other cities untouched.
 */
async function invalidateAround(lat, lng, radiusKm) {
  const cells = getAffectedGridCells(lat, lng, radiusKm);
  if (!cells.length) return { cellsCleared: 0 };

  const prefixes = cells.map(
    ({ gridLat, gridLng }) => `${geoCacheKey(gridLat, gridLng)}:cat:`,
  );
  await cacheInvalidateByPrefixes(NAMESPACE, prefixes);

  return { cellsCleared: cells.length };
}

module.exports = {
  getPool,
  setPool,
  invalidateAround,
  TTL_MS,
  NAMESPACE,
};
