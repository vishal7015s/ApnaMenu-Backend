const { cacheGet, cacheSet, cacheDel } = require('./cacheHelper.service');

const NAMESPACE = 'dishReview';
const TTL_MS = 30 * 60 * 1000; // 30 min

function reviewStatsKey(dishId) {
  return `dish:${dishId}:reviewStats`;
}

async function get(dishId) {
  return cacheGet(NAMESPACE, reviewStatsKey(dishId));
}

async function set(dishId, reviewStats) {
  return cacheSet(NAMESPACE, reviewStatsKey(dishId), reviewStats, TTL_MS);
}

async function invalidate(dishId) {
  return cacheDel(NAMESPACE, reviewStatsKey(String(dishId)));
}

module.exports = { get, set, invalidate, TTL_MS };
