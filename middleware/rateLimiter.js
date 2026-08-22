// ====================================
// Rate Limiter Middleware
// ====================================

const rateLimit = require('express-rate-limit');
const { isRedisReady, getRedisClient } = require('../config/redis');

function buildStore(prefix) {
  if (!isRedisReady()) return undefined;
  try {
    const { RedisStore } = require('rate-limit-redis');
    return new RedisStore({
      sendCommand: (...args) => getRedisClient().call(...args),
      prefix: `apnamenu:${prefix}:`,
    });
  } catch {
    return undefined;
  }
}

function createLimiter({ windowMs, max, message, prefix, keyGenerator }) {
  const options = {
    windowMs,
    max,
    message,
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (keyGenerator) options.keyGenerator = keyGenerator;
  const store = buildStore(prefix);
  if (store) options.store = store;
  return rateLimit(options);
}

/**
 * Firebase verify-otp endpoint — max 5 attempts per IP per 15 minutes.
 * Uses Redis store when available (persists across PM2 restarts / multi-instance).
 */
const otpRateLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  prefix: 'rl:verify-otp',
  message: {
    success: false,
    message: 'Too many login attempts. Please try again after 15 minutes.',
    message_hi: 'बहुत ज़्यादा लॉगिन प्रयास। कृपया 15 मिनट बाद प्रयास करें।',
  },
});

const apiRateLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 500,
  prefix: 'rl:api',
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
});

const adminLoginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10, // max 10 login attempts per 15 minutes per IP
  prefix: 'rl:admin-login',
  message: {
    success: false,
    message: 'Too many login attempts. Please try again after 15 minutes.',
  },
});

const webhookRateLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 200,
  prefix: 'rl:webhook',
  message: {
    success: false,
    message: 'Too many webhook requests.',
  },
});

module.exports = { otpRateLimiter, apiRateLimiter, webhookRateLimiter, adminLoginLimiter };
