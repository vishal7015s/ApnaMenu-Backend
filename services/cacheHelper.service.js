/**
 * Generic cache layer — Redis when available, in-memory Map fallback.
 * Tracks keys per index for safe bulk invalidation (no Redis KEYS command).
 */
const { isRedisReady, getRedisClient } = require('../config/redis');

const MEMORY_MAX = 500;
const memoryByNamespace = new Map();

function getMemoryStore(namespace) {
  if (!memoryByNamespace.has(namespace)) {
    memoryByNamespace.set(namespace, new Map());
  }
  return memoryByNamespace.get(namespace);
}

function indexKey(namespace) {
  return `cache:index:${namespace}`;
}

function memoryGet(namespace, key) {
  const store = getMemoryStore(namespace);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

function memorySet(namespace, key, value, ttlMs) {
  const store = getMemoryStore(namespace);
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (store.size > MEMORY_MAX) {
    const firstKey = store.keys().next().value;
    store.delete(firstKey);
  }
}

function memoryDel(namespace, key) {
  getMemoryStore(namespace).delete(key);
}

function memoryClearNamespace(namespace) {
  getMemoryStore(namespace).clear();
}

async function trackKey(namespace, key, ttlSec) {
  const client = getRedisClient();
  if (!isRedisReady() || !client) return;
  const idx = indexKey(namespace);
  try {
    await client.sadd(idx, key);
    const idxTtl = Math.max(ttlSec * 2, 86400);
    await client.expire(idx, idxTtl);
  } catch {
    /* non-fatal */
  }
}

async function untrackKey(namespace, key) {
  const client = getRedisClient();
  if (!isRedisReady() || !client) return;
  try {
    await client.srem(indexKey(namespace), key);
  } catch {
    /* non-fatal */
  }
}

/**
 * @param {string} namespace - logical group e.g. 'menu', 'banner'
 * @param {string} key - full redis key
 * @param {number} ttlMs
 */
async function cacheGet(namespace, key) {
  if (isRedisReady()) {
    try {
      const raw = await getRedisClient().get(key);
      if (raw) return JSON.parse(raw);
      // Redis miss is authoritative across instances — drop local L1 so a
      // later Redis outage cannot serve stale data invalidated elsewhere.
      memoryDel(namespace, key);
      return null;
    } catch {
      /* Redis error — local memory is last-resort only */
    }
  }
  return memoryGet(namespace, key);
}

async function cacheSet(namespace, key, value, ttlMs) {
  memorySet(namespace, key, value, ttlMs);
  if (isRedisReady()) {
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    try {
      await getRedisClient().set(key, JSON.stringify(value), 'EX', ttlSec);
      await trackKey(namespace, key, ttlSec);
    } catch {
      /* memory cache already set */
    }
  }
}

async function cacheDel(namespace, key) {
  memoryDel(namespace, key);
  if (isRedisReady()) {
    try {
      await getRedisClient().del(key);
      await untrackKey(namespace, key);
    } catch {
      /* non-fatal */
    }
  }
}

/** Delete all keys tracked under a namespace index + clear memory store. */
async function cacheInvalidateNamespace(namespace) {
  memoryClearNamespace(namespace);
  if (isRedisReady()) {
    try {
      const client = getRedisClient();
      const idx = indexKey(namespace);
      const keys = await client.smembers(idx);
      if (keys.length > 0) {
        await client.del(...keys, idx);
      } else {
        await client.del(idx);
      }
    } catch {
      /* memory already cleared */
    }
  }
}

/**
 * Delete keys in a namespace whose full key starts with prefix (memory + Redis index).
 * Avoids Redis KEYS — uses the tracked index set only.
 */
async function cacheInvalidateByPrefix(namespace, prefix) {
  return cacheInvalidateByPrefixes(namespace, [prefix]);
}

/**
 * Delete keys matching any prefix in one index scan (efficient for geo bulk invalidation).
 */
async function cacheInvalidateByPrefixes(namespace, prefixes) {
  if (!prefixes.length) return;

  const store = getMemoryStore(namespace);
  for (const key of [...store.keys()]) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      store.delete(key);
    }
  }

  if (isRedisReady()) {
    try {
      const client = getRedisClient();
      const idx = indexKey(namespace);
      const keys = await client.smembers(idx);
      const toDelete = keys.filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
      if (toDelete.length > 0) {
        await client.del(...toDelete);
        await client.srem(idx, ...toDelete);
      }
    } catch {
      /* memory already cleared for matching keys */
    }
  }
}

module.exports = {
  cacheGet,
  cacheSet,
  cacheDel,
  cacheInvalidateNamespace,
  cacheInvalidateByPrefix,
  cacheInvalidateByPrefixes,
};
