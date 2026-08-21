const Rider = require('../models/Rider');
const Kitchen = require('../models/Kitchen');
const User = require('../models/User');

function normalizePayload(notification) {
  return notification?.toObject ? notification.toObject() : { ...notification };
}

async function collectFcmTokens(targetRole) {
  const tokenSet = new Set();

  if (targetRole === 'rider' || targetRole === 'all') {
    const riders = await Rider.find({ expoPushToken: { $nin: [null, ''] } }).select('expoPushToken');
    riders.forEach((rider) => {
      if (rider.expoPushToken) tokenSet.add(rider.expoPushToken);
    });
    const riderUsers = await User.find({
      fcmToken: { $nin: [null, ''] },
      $or: [{ role: 'rider' }, { activeRole: 'rider' }],
    }).select('fcmToken');
    riderUsers.forEach((u) => {
      if (u.fcmToken) tokenSet.add(u.fcmToken);
    });
  }

  if (targetRole === 'kitchen' || targetRole === 'all') {
    const kitchens = await Kitchen.find({}).select('expoPushTokens ownerId').lean();
    for (const kitchen of kitchens) {
      if (kitchen.expoPushTokens && kitchen.expoPushTokens.length > 0) {
        kitchen.expoPushTokens.forEach(t => tokenSet.add(t));
      }
      if (kitchen.ownerId) {
        const user = await User.findById(kitchen.ownerId).select('fcmToken').lean();
        if (user?.fcmToken) tokenSet.add(user.fcmToken);
      }
    }
    const kitchenUsers = await User.find({
      fcmToken: { $nin: [null, ''] },
      $or: [{ role: 'kitchen' }, { activeRole: 'kitchen' }],
    }).select('fcmToken');
    kitchenUsers.forEach((u) => {
      if (u.fcmToken) tokenSet.add(u.fcmToken);
    });
  }

  if (targetRole === 'user' || targetRole === 'all') {
    const users = await User.find({
      fcmToken: { $nin: [null, ''] },
      $or: [{ role: 'customer' }, { activeRole: 'customer' }, { role: { $exists: false } }],
    }).select('fcmToken');
    users.forEach((user) => {
      if (user.fcmToken) tokenSet.add(user.fcmToken);
    });
  }

  if (targetRole === 'all') {
    const allUsers = await User.find({ fcmToken: { $nin: [null, ''] } }).select('fcmToken');
    allUsers.forEach((user) => {
      if (user.fcmToken) tokenSet.add(user.fcmToken);
    });
  }

  return tokenSet;
}

/**
 * Fetch FCM/Expo token for a SINGLE specific recipient.
 * Used when admin sends notification to an individual user/rider/kitchen.
 */
async function collectFcmTokensForRecipient(targetRole, recipientId) {
  const tokenSet = new Set();
  if (!recipientId) return tokenSet;

  const idStr = String(recipientId);
  const mongoose = require('mongoose');
  const isValidId = mongoose.Types.ObjectId.isValid(idStr);

  try {
    if (isValidId) {
      // 1. Check User collection
      const user = await User.findById(idStr).select('fcmToken').lean();
      if (user?.fcmToken) tokenSet.add(user.fcmToken);

      // 2. Check Rider collection (by rider _id or rider.userId)
      const rider = await Rider.findOne({
        $or: [{ _id: idStr }, { userId: idStr }],
      }).select('expoPushToken userId').lean();
      if (rider?.expoPushToken) tokenSet.add(rider.expoPushToken);
      if (rider?.userId) {
        const riderUser = await User.findById(rider.userId).select('fcmToken').lean();
        if (riderUser?.fcmToken) tokenSet.add(riderUser.fcmToken);
      }

      // 3. Check Kitchen collection (by kitchen _id or kitchen.ownerId)
      const kitchen = await Kitchen.findOne({
        $or: [{ _id: idStr }, { ownerId: idStr }],
      }).select('expoPushTokens ownerId').lean();
      if (kitchen?.expoPushTokens && kitchen.expoPushTokens.length > 0) {
        kitchen.expoPushTokens.forEach((t) => tokenSet.add(t));
      }
      if (kitchen?.ownerId) {
        const ownerUser = await User.findById(kitchen.ownerId).select('fcmToken').lean();
        if (ownerUser?.fcmToken) tokenSet.add(ownerUser.fcmToken);
      }
    }
  } catch (e) {
    console.error('[notificationBroadcast] collectFcmTokensForRecipient error:', e.message);
  }

  return tokenSet;
}

async function emitNotificationToTargets(io, notification) {
  if (!io || !notification) return;

  const payload = normalizePayload(notification);
  const { targetRole, recipientId } = payload;
  const mongoose = require('mongoose');

  if (recipientId) {
    const recipientKey = String(recipientId);
    const isValidId = mongoose.Types.ObjectId.isValid(recipientKey);

    io.to(`user_${recipientKey}`).emit('notification:new', payload);
    io.to(`kitchen_${recipientKey}`).emit('notification:new', payload);
    io.to(`rider_${recipientKey}`).emit('notification:new', payload);

    if (isValidId) {
      try {
        const [kitchen, rider] = await Promise.all([
          Kitchen.findOne({ $or: [{ _id: recipientKey }, { ownerId: recipientKey }] }).select('_id ownerId').lean(),
          Rider.findOne({ $or: [{ _id: recipientKey }, { userId: recipientKey }] }).select('_id userId').lean(),
        ]);

        if (kitchen) {
          io.to(`kitchen_${kitchen._id}`).emit('notification:new', payload);
          if (kitchen.ownerId) io.to(`user_${kitchen.ownerId}`).emit('notification:new', payload);
        }
        if (rider) {
          io.to(`rider_${rider._id}`).emit('notification:new', payload);
          if (rider.userId) {
            io.to(`rider_${rider.userId}`).emit('notification:new', payload);
            io.to(`user_${rider.userId}`).emit('notification:new', payload);
          }
        }
      } catch (e) {}
    }
    return;
  }

  if (targetRole === 'kitchen' || targetRole === 'all') {
    const kitchens = await Kitchen.find({}).select('_id ownerId').lean();
    kitchens.forEach((kitchen) => {
      io.to(`kitchen_${kitchen._id}`).emit('notification:new', payload);
      if (kitchen.ownerId) io.to(`user_${kitchen.ownerId}`).emit('notification:new', payload);
    });
  }

  if (targetRole === 'rider' || targetRole === 'all') {
    const riders = await Rider.find({}).select('_id userId').lean();
    riders.forEach((rider) => {
      if (rider.userId) io.to(`rider_${rider.userId}`).emit('notification:new', payload);
      io.to(`rider_${rider._id}`).emit('notification:new', payload);
      if (rider.userId) io.to(`user_${rider.userId}`).emit('notification:new', payload);
    });
  }

  if (targetRole === 'user' || targetRole === 'all') {
    const users = await User.find({ role: 'customer' }).select('_id').lean();
    users.forEach((user) => {
      io.to(`user_${user._id}`).emit('notification:new', payload);
    });
  }
}

module.exports = {
  collectFcmTokens,
  collectFcmTokensForRecipient,
  emitNotificationToTargets,
  normalizePayload,
};
