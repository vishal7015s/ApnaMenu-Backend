const { cacheGet, cacheSet, cacheDel } = require('./cacheHelper.service');

const NAMESPACE = 'wallet';
const TTL_MS = 15 * 1000; // 15 sec

function walletKey(userId, role) {
  return `wallet:${userId}:${role}`;
}

async function get(userId, role) {
  return cacheGet(NAMESPACE, walletKey(userId, role));
}

async function set(userId, role, walletDoc) {
  return cacheSet(NAMESPACE, walletKey(userId, role), walletDoc, TTL_MS);
}

async function invalidate(userId, role) {
  if (userId == null) {
    const { cacheInvalidateNamespace } = require('./cacheHelper.service');
    return cacheInvalidateNamespace(NAMESPACE);
  }
  if (role) {
    return cacheDel(NAMESPACE, walletKey(String(userId), role));
  }
  return Promise.all([
    cacheDel(NAMESPACE, walletKey(String(userId), 'kitchen')),
    cacheDel(NAMESPACE, walletKey(String(userId), 'rider')),
  ]);
}

module.exports = { get, set, invalidate, TTL_MS };
