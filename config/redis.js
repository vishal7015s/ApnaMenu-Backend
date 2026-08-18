/**
 * Shared Redis client — single connection for cache, timers, Socket.io adapter.
 * Falls back gracefully when REDIS_URL is unset or Redis is down.
 */
const logger = require('../utils/logger');

let redisClient = null;
let redisReady = false;
let initPromise = null;

async function initRedis() {
  if (initPromise) return initPromise;
  if (!process.env.REDIS_URL) {
    initPromise = Promise.resolve(false);
    return initPromise;
  }

  initPromise = (async () => {
    try {
      const Redis = require('ioredis');
      redisClient = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      await redisClient.connect();
      redisClient.on('error', () => {
        redisReady = false;
      });
      redisClient.on('connect', () => {
        redisReady = true;
      });
      redisReady = true;
      logger.info('Redis connected');
      return true;
    } catch (err) {
      logger.warn({ err: err.message }, 'Redis unavailable — using in-memory fallbacks');
      redisClient = null;
      redisReady = false;
      return false;
    }
  })();

  return initPromise;
}

function getRedisClient() {
  return redisClient;
}

function isRedisReady() {
  return Boolean(redisReady && redisClient);
}

/** Duplicate client for Socket.io pub/sub (adapter needs two connections). */
function duplicateClient() {
  if (!redisClient) return null;
  return redisClient.duplicate();
}

initRedis().catch(() => {});

module.exports = {
  initRedis,
  getRedisClient,
  isRedisReady,
  duplicateClient,
};
