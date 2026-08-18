const { geoCacheKey, geoPageCacheKey, getAffectedGridCells } = require('../utils/geohash');
const { cacheGet, cacheSet, cacheInvalidateByPrefixes } = require('./cacheHelper.service');

const NAMESPACE = 'nearby';
const TTL_MS = 2 * 60 * 1000; // 2 min — seller open/close invalidates immediately

async function get(lat, lng, { page = 1, limit = 10, suffix = '' } = {}) {
  const key = geoPageCacheKey(lat, lng, page, limit, suffix);
  return cacheGet(NAMESPACE, key);
}

async function set(lat, lng, value, { page = 1, limit = 10, suffix = '', ttlMs = TTL_MS } = {}) {
  const key = geoPageCacheKey(lat, lng, page, limit, suffix);
  return cacheSet(NAMESPACE, key, value, ttlMs);
}

/** Legacy home-feed cache (page 1, limit 10, menu preview). */
async function getHomeFeed(lat, lng) {
  return get(lat, lng, { page: 1, limit: 10, suffix: 'menu' });
}

async function setHomeFeed(lat, lng, value, ttlMs = TTL_MS) {
  return set(lat, lng, value, { page: 1, limit: 10, suffix: 'menu', ttlMs });
}

/**
 * Clear nearby cache keys for geohash cells that could surface this kitchen.
 * Only touches localized prefixes — other city areas stay cached.
 */
async function invalidateAround(lat, lng, radiusKm) {
  const cells = getAffectedGridCells(lat, lng, radiusKm);
  if (!cells.length) return { cellsCleared: 0 };

  const prefixes = cells.map(({ gridLat, gridLng }) => `nearby:${gridLat}:${gridLng}`);
  await cacheInvalidateByPrefixes(NAMESPACE, prefixes);

  return { cellsCleared: cells.length };
}

module.exports = {
  get,
  set,
  getHomeFeed,
  setHomeFeed,
  invalidateAround,
  TTL_MS,
  geoCacheKey,
};
