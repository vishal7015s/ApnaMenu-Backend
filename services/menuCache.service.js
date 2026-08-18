const { cacheGet, cacheSet, cacheDel } = require('./cacheHelper.service');

const NAMESPACE = 'menu';
const TTL_MS = 5 * 60 * 1000; // 5 min safety net; writes invalidate immediately

function menuKey(kitchenId) {
  return `menu:kitchen:${kitchenId}`;
}

async function get(kitchenId) {
  return cacheGet(NAMESPACE, menuKey(kitchenId));
}

async function set(kitchenId, payload) {
  return cacheSet(NAMESPACE, menuKey(kitchenId), payload, TTL_MS);
}

async function invalidate(kitchenId) {
  return cacheDel(NAMESPACE, menuKey(String(kitchenId)));
}

module.exports = { get, set, invalidate, TTL_MS };
