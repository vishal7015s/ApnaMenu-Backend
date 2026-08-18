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
  }

  if (targetRole === 'kitchen' || targetRole === 'all') {
    const kitchens = await Kitchen.find({}).select('expoPushToken ownerId').lean();
    for (const kitchen of kitchens) {
      if (kitchen.expoPushToken) {
        tokenSet.add(kitchen.expoPushToken);
      } else if (kitchen.ownerId) {
        const user = await User.findById(kitchen.ownerId).select('fcmToken').lean();
        if (user?.fcmToken) tokenSet.add(user.fcmToken);
      }
    }
  }

  if (targetRole === 'user' || targetRole === 'all') {
    const users = await User.find({
      fcmToken: { $nin: [null, ''] },
      role: 'customer',
    }).select('fcmToken');
    users.forEach((user) => {
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

  if (targetRole === 'user') {
    const user = await User.findById(recipientId).select('fcmToken').lean();
    if (user?.fcmToken) tokenSet.add(user.fcmToken);
  } else if (targetRole === 'rider') {
    const rider = await Rider.findById(recipientId).select('expoPushToken userId').lean();
    if (rider?.expoPushToken) {
      tokenSet.add(rider.expoPushToken);
    } else if (rider?.userId) {
      const user = await User.findById(rider.userId).select('fcmToken').lean();
      if (user?.fcmToken) tokenSet.add(user.fcmToken);
    }
  } else if (targetRole === 'kitchen') {
    const kitchen = await Kitchen.findById(recipientId).select('expoPushToken ownerId').lean();
    if (kitchen?.expoPushToken) {
      tokenSet.add(kitchen.expoPushToken);
    } else if (kitchen?.ownerId) {
      const user = await User.findById(kitchen.ownerId).select('fcmToken').lean();
      if (user?.fcmToken) tokenSet.add(user.fcmToken);
    }

    if (tokenSet.size === 0) {
      const kitchenByOwner = await Kitchen.findOne({ ownerId: recipientId }).select('expoPushToken').lean();
      if (kitchenByOwner?.expoPushToken) tokenSet.add(kitchenByOwner.expoPushToken);
      const user = await User.findById(recipientId).select('fcmToken').lean();
      if (user?.fcmToken) tokenSet.add(user.fcmToken);
    }
  } else {
    // Fallback: try all three collections
    const [user, rider, kitchen] = await Promise.all([
      User.findById(recipientId).select('fcmToken').lean(),
      Rider.findById(recipientId).select('expoPushToken userId').lean(),
      Kitchen.findById(recipientId).select('expoPushToken ownerId').lean(),
    ]);
    if (user?.fcmToken) tokenSet.add(user.fcmToken);
    if (rider?.expoPushToken) tokenSet.add(rider.expoPushToken);
    if (kitchen?.expoPushToken) tokenSet.add(kitchen.expoPushToken);
    if (kitchen?.ownerId && !kitchen?.expoPushToken) {
      const ownerUser = await User.findById(kitchen.ownerId).select('fcmToken').lean();
      if (ownerUser?.fcmToken) tokenSet.add(ownerUser.fcmToken);
    }
  }

  return tokenSet;
}

async function emitNotificationToTargets(io, notification) {
  if (!io || !notification) return;

  const payload = normalizePayload(notification);
  const { targetRole, recipientId } = payload;

  if (recipientId) {
    const recipientKey = String(recipientId);

    if (targetRole === 'kitchen') {
      io.to(`kitchen_${recipientKey}`).emit('notification:new', payload);
      return;
    }

    if (targetRole === 'rider') {
      const rider = await Rider.findById(recipientId).select('userId').lean();
      const riderUserId = rider?.userId ? String(rider.userId) : recipientKey;
      io.to(`rider_${riderUserId}`).emit('notification:new', payload);
      io.to(`rider_${recipientKey}`).emit('notification:new', payload);
      return;
    }

    if (targetRole === 'user') {
      io.to(`user_${recipientKey}`).emit('notification:new', payload);
      return;
    }

    io.to(`kitchen_${recipientKey}`).emit('notification:new', payload);
    io.to(`user_${recipientKey}`).emit('notification:new', payload);
    const rider = await Rider.findById(recipientId).select('userId').lean();
    const riderUserId = rider?.userId ? String(rider.userId) : recipientKey;
    io.to(`rider_${riderUserId}`).emit('notification:new', payload);
    io.to(`rider_${recipientKey}`).emit('notification:new', payload);
    return;
  }

  if (targetRole === 'kitchen' || targetRole === 'all') {
    const kitchens = await Kitchen.find({}).select('_id').lean();
    kitchens.forEach((kitchen) => {
      io.to(`kitchen_${kitchen._id}`).emit('notification:new', payload);
    });
  }

  if (targetRole === 'rider' || targetRole === 'all') {
    const riders = await Rider.find({}).select('_id userId').lean();
    riders.forEach((rider) => {
      if (rider.userId) io.to(`rider_${rider.userId}`).emit('notification:new', payload);
      io.to(`rider_${rider._id}`).emit('notification:new', payload);
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
