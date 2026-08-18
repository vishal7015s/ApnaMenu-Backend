const { cacheGet, cacheSet, cacheDel } = require('./cacheHelper.service');

const NAMESPACE = 'auth';
const TTL_MS = 5 * 60 * 1000;

function authKey(userId) {
  return `auth:user:${userId}`;
}

async function get(userId) {
  return cacheGet(NAMESPACE, authKey(userId));
}

async function set(userId, payload) {
  return cacheSet(NAMESPACE, authKey(userId), payload, TTL_MS);
}

async function invalidate(userId) {
  if (userId == null) {
    const { cacheInvalidateNamespace } = require('./cacheHelper.service');
    return cacheInvalidateNamespace(NAMESPACE);
  }
  return cacheDel(NAMESPACE, authKey(String(userId)));
}

module.exports = { get, set, invalidate, TTL_MS };
