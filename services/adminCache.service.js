const { cacheGet, cacheSet, cacheDel } = require('./cacheHelper.service');

const NAMESPACE = 'admin';
const STATS_KEY = 'admin:dashboard:stats';
const TTL_MS = 60 * 1000; // 1 min — admin-only, low write frequency

async function getDashboardStats() {
  return cacheGet(NAMESPACE, STATS_KEY);
}

async function setDashboardStats(data) {
  return cacheSet(NAMESPACE, STATS_KEY, data, TTL_MS);
}

async function invalidateDashboardStats() {
  return cacheDel(NAMESPACE, STATS_KEY);
}

module.exports = {
  getDashboardStats,
  setDashboardStats,
  invalidateDashboardStats,
  TTL_MS,
};
