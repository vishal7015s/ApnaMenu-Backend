// ====================================
// Socket.io Service
// ====================================

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Kitchen = require('../models/Kitchen');
const Order = require('../models/Order');
const { tokenVersionMatches } = require('../utils/authTokens');

const kitchenIdCache = new Map();

async function attachKitchenId(user) {
  if (!user) return user;
  const uid = user._id?.toString() || user.id?.toString();
  if (uid && kitchenIdCache.has(uid)) {
    user.kitchenId = kitchenIdCache.get(uid);
    return user;
  }
  try {
    const kitchen = await Kitchen.findOne({ ownerId: user._id }).select('_id').lean();
    if (kitchen) {
      user.kitchenId = kitchen._id;
      if (uid) kitchenIdCache.set(uid, kitchen._id);
    }
  } catch (err) {
    console.error('attachKitchenId error:', err.message);
  }
  return user;
}

function userIdStr(user) {
  return user?._id?.toString() || user?.id?.toString();
}

const initializeSocket = (io) => {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('Authentication required'));
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-__v').lean();
      if (!user || user.accountStatus === 'suspended' || user.accountStatus === 'deleted') {
        return next(new Error('Unauthorized'));
      }
      if (!tokenVersionMatches(decoded, user)) {
        return next(new Error('Session expired'));
      }
      socket.user = await attachKitchenId(user);
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const uid = userIdStr(socket.user);
    console.log(`🔌 Client connected: ${socket.id} (user: ${uid}, role: ${socket.user?.role}, kitchen: ${socket.user?.kitchenId || 'none'})`);

    // Auto-join user room on connection
    if (uid) {
      socket.join(`user_${uid}`);
    }
    // Auto-join kitchen room if user owns a kitchen
    if (socket.user?.kitchenId) {
      socket.join(`kitchen_${socket.user.kitchenId}`);
    }

    socket.on('joinOrderRoom', (orderId) => {
      try {
        if (!orderId) return;
        const oId = String(orderId);
        socket.join(`order_${oId}`);
        console.log(`📦 Socket ${socket.id} joined room: order_${oId}`);
      } catch (err) {
        console.error('joinOrderRoom error:', err.message);
      }
    });

    socket.on('joinKitchenRoom', async (kitchenId) => {
      try {
        if (!kitchenId) return;
        const kId = String(kitchenId);
        socket.join(`kitchen_${kId}`);
        console.log(`🍳 Socket ${socket.id} joined room: kitchen_${kId}`);
      } catch (err) {
        console.error('joinKitchenRoom error:', err.message);
      }
    });

    socket.on('joinUserRoom', (userId) => {
      try {
        if (!userId) return;
        const uId = String(userId);
        socket.join(`user_${uId}`);
        console.log(`👤 Socket ${socket.id} joined room: user_${uId}`);
      } catch (err) {
        console.error('joinUserRoom error:', err.message);
      }
    });

    socket.on('joinRiderRoom', (riderId) => {
      try {
        if (!riderId) return;
        const rId = String(riderId);
        socket.join(`rider_${rId}`);
        console.log(`🛵 Socket ${socket.id} joined room: rider_${rId}`);
      } catch (err) {
        console.error('joinRiderRoom error:', err.message);
      }
    });

    socket.on('leaveUserRoom', (userId) => {
      if (userId) socket.leave(`user_${userId}`);
    });

    socket.on('leaveRiderRoom', (riderId) => {
      if (riderId) socket.leave(`rider_${riderId}`);
    });

    socket.on('leaveOrderRoom', (orderId) => {
      if (orderId) socket.leave(`order_${orderId}`);
    });

    socket.on('leaveKitchenRoom', (kitchenId) => {
      if (kitchenId) socket.leave(`kitchen_${kitchenId}`);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });
};

module.exports = { initializeSocket };
