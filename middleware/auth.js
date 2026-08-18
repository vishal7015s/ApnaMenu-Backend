// ====================================
// JWT Authentication Middleware
// ====================================

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { tokenVersionMatches } = require('../utils/authTokens');
const authCache = require('../services/authCache.service');

const AUTH_CACHE_TTL_MS = authCache.TTL_MS;
const memoryAuthCache = new Map();

function normalizeUser(user) {
  if (!user) return user;
  const plain = typeof user.toObject === 'function' ? user.toObject({ virtuals: true }) : { ...user };
  if (!plain.id && plain._id) {
    plain.id = plain._id.toString();
  }
  return plain;
}

function getCachedAuth(userId) {
  const entry = memoryAuthCache.get(String(userId));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryAuthCache.delete(String(userId));
    return null;
  }
  return entry;
}

function setMemoryAuth(userId, user, kitchenId) {
  if (memoryAuthCache.size > 2000) {
    const firstKey = memoryAuthCache.keys().next().value;
    memoryAuthCache.delete(firstKey);
  }
  memoryAuthCache.set(String(userId), {
    user,
    kitchenId,
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
  });
}

async function getCachedAuthAsync(userId) {
  const mem = getCachedAuth(userId);
  if (mem) return mem;

  const redisEntry = await authCache.get(userId);
  if (!redisEntry) return null;

  const user = normalizeUser(redisEntry.user);
  setMemoryAuth(userId, user, redisEntry.kitchenId);
  return { user, kitchenId: redisEntry.kitchenId };
}

async function setCachedAuth(userId, user, kitchenId) {
  const plainUser = normalizeUser(user);
  setMemoryAuth(userId, plainUser, kitchenId);
  await authCache.set(userId, { user: plainUser, kitchenId });
}

async function clearAuthCache(userId) {
  if (userId == null) {
    memoryAuthCache.clear();
    await authCache.invalidate(null);
    return;
  }
  memoryAuthCache.delete(String(userId));
  await authCache.invalidate(userId);
}

const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized — no token provided',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const cached = await getCachedAuthAsync(decoded.id);

    if (cached) {
      if (cached.user.accountStatus === 'suspended') {
        return res.status(403).json({
          success: false,
          message: 'Your account has been suspended. Contact support.',
        });
      }
      if (cached.user.accountStatus === 'deleted') {
        return res.status(403).json({
          success: false,
          message: 'This account has been deleted.',
        });
      }
      if (!tokenVersionMatches(decoded, cached.user)) {
        await clearAuthCache(decoded.id);
        return res.status(401).json({
          success: false,
          message: 'Session expired — please log in again',
        });
      }
      req.user = cached.user;
      if (cached.kitchenId) req.user.kitchenId = cached.kitchenId;
      return next();
    }

    const user = await User.findById(decoded.id).select('-__v');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found',
      });
    }

    // Suspend/deleted must win over session revoke so the client can show Blocked UI
    if (user.accountStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended. Contact support.',
      });
    }

    if (user.accountStatus === 'deleted') {
      return res.status(403).json({
        success: false,
        message: 'This account has been deleted.',
      });
    }

    if (!tokenVersionMatches(decoded, user)) {
      return res.status(401).json({
        success: false,
        message: 'Session expired — please log in again',
      });
    }

    req.user = user;

    let kitchenId = null;
    if (user.role !== 'rider') {
      // Self-heal: a Kitchen document owned by this user is the source of truth.
      // If role/activeRole never got flipped to 'kitchen' (e.g. a past crash right
      // after Kitchen.create() interrupted the save), correct it here so the
      // account doesn't stay stuck as 'customer' forever.
      const Kitchen = require('../models/Kitchen');
      const kitchen = await Kitchen.findOne({ ownerId: user._id }).select('_id');
      if (kitchen) {
        kitchenId = kitchen._id;
        req.user.kitchenId = kitchenId;
        if (user.role !== 'kitchen' || user.activeRole !== 'kitchen') {
          user.role = 'kitchen';
          user.activeRole = 'kitchen';
          user.signupIntent = null;
          await user.save();
          req.user = user;
        }
      }
    }

    await setCachedAuth(decoded.id, user, kitchenId);
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized — invalid token',
    });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.activeRole) && !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Role '${req.user.activeRole}' is not authorized for this route`,
      });
    }
    next();
  };
};

module.exports = { protect, authorize, clearAuthCache };
