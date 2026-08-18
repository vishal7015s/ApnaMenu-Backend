// ====================================
// Notification Controller
// ====================================

const Notification = require('../models/Notification');
const NotificationRead = require('../models/NotificationRead');
const Warning = require('../models/Warning');
const Rider = require('../models/Rider');
const { sendPushNotification } = require('../config/firebase');
const { collectFcmTokens, collectFcmTokensForRecipient, emitNotificationToTargets } = require('../utils/notificationBroadcast');

function buildTargetConditions(req, riderProfile) {
  const userId = req.user._id;
  const activeRole = req.user.activeRole || req.user.role || 'customer';

  const targetConditions = [
    { targetRole: 'all' },
    { recipientId: userId },
  ];
  const warningConditions = [{ targetId: userId }];

  if (activeRole === 'kitchen') {
    targetConditions.push({ targetRole: 'kitchen' });
    if (req.user.kitchenId) {
      targetConditions.push({ recipientId: req.user.kitchenId });
      warningConditions.push({ targetId: req.user.kitchenId });
    }
  } else if (activeRole === 'rider') {
    targetConditions.push({ targetRole: 'rider' });
    if (riderProfile) {
      targetConditions.push({ recipientId: riderProfile._id });
      warningConditions.push({ targetId: riderProfile._id });
    }
  } else {
    targetConditions.push({ targetRole: 'user' });
  }

  return { targetConditions, warningConditions };
}

async function fetchCombinedNotifications(req, { limit = 50, skip = 0 } = {}) {
  const activeRole = req.user.activeRole || req.user.role || 'customer';
  const riderProfile = activeRole === 'rider'
    ? await Rider.findOne({ userId: req.user._id }).select('_id')
    : null;
  const { targetConditions, warningConditions } = buildTargetConditions(req, riderProfile);
  const userCreatedAt = req.user.createdAt || new Date(0);

  const notifications = await Notification.find({
    $and: [
      { $or: targetConditions },
      { createdAt: { $gte: userCreatedAt } },
    ],
  }).sort({ createdAt: -1 }).skip(skip).limit(Math.min(limit, 50));

  const warnings = await Warning.find({
    $and: [
      { $or: warningConditions },
      { createdAt: { $gte: userCreatedAt } },
    ],
  }).sort({ createdAt: -1 }).limit(20);

  const formattedWarnings = warnings.map((w) => ({
    _id: w._id,
    title: w.title || 'Admin Notice / Warning',
    message: w.message,
    type: 'alert',
    createdAt: w.createdAt || w.issuedAt || new Date(),
    isWarning: true,
  }));

  const combined = [...notifications, ...formattedWarnings].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const seen = new Set();
  const uniqueCombined = [];
  for (const item of combined) {
    const key = `${String(item.message).trim()}_${new Date(item.createdAt).toISOString().slice(0, 13)}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCombined.push(item);
    }
  }

  const readDocs = await NotificationRead.find({ userId: req.user._id }).select('notificationId').lean();
  const readSet = new Set(readDocs.map((r) => String(r.notificationId)));

  return uniqueCombined.map((item) => ({
    ...item.toObject ? item.toObject() : item,
    isRead: readSet.has(String(item._id)),
  }));
}

/**
 * @desc    Get notifications for logged in user/rider
 * @route   GET /api/notifications
 */
const getNotifications = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 50);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const data = await fetchCombinedNotifications(req, { limit, skip });
    res.json({
      success: true,
      data,
      pagination: { skip, limit, hasMore: data.length === limit },
    });
  } catch (error) {
    console.error('getNotifications error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Unread notification count for badge
 * @route   GET /api/notifications/unread-count
 */
const getUnreadCount = async (req, res) => {
  try {
    const data = await fetchCombinedNotifications(req, { limit: 50, skip: 0 });
    const unreadCount = data.filter((item) => !item.isRead).length;
    res.json({ success: true, data: { unreadCount } });
  } catch (error) {
    console.error('getUnreadCount error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Mark notifications as read
 * @route   PUT /api/notifications/mark-read
 */
const markNotificationsRead = async (req, res) => {
  try {
    const { notificationIds = [], markAll = false } = req.body || {};
    let ids = notificationIds;

    if (markAll) {
      const data = await fetchCombinedNotifications(req);
      ids = data.map((item) => item._id);
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.json({ success: true, message: 'Nothing to mark as read' });
    }

    const ops = ids.map((notificationId) => ({
      updateOne: {
        filter: { userId: req.user._id, notificationId },
        update: { $setOnInsert: { userId: req.user._id, notificationId } },
        upsert: true,
      },
    }));

    await NotificationRead.bulkWrite(ops, { ordered: false });

    res.json({ success: true, message: 'Notifications marked as read' });
  } catch (error) {
    console.error('markNotificationsRead error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Admin sends/broadcasts a notification
 * @route   POST /api/notifications
 */
const sendNotification = async (req, res) => {
  try {
    const { title, message, targetRole = 'rider', type = 'system', recipientId = null } = req.body;

    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'Title and message are required' });
    }

    const notification = await Notification.create({
      title,
      message,
      targetRole,
      type,
      recipientId,
    });

    const io = req.app.get('io');
    if (io) {
      await emitNotificationToTargets(io, notification);
    }

    // Collect FCM tokens — for specific user fetch only that user's token
    let tokenSet;
    if (recipientId) {
      tokenSet = await collectFcmTokensForRecipient(targetRole, recipientId);
    } else {
      tokenSet = await collectFcmTokens(targetRole);
    }

    console.log(`📣 [Admin Notification] targetRole=${targetRole}, recipientId=${recipientId}, collectedTokens=${tokenSet.size}`);

    const pushData = {
      type: 'admin_notification',
      notificationId: String(notification._id),
      targetRole,
    };

    tokenSet.forEach((token) => {
      sendPushNotification(token, title, message, pushData);
    });

    res.status(201).json({
      success: true,
      message: 'Notification sent successfully',
      data: notification,
    });
  } catch (error) {
    console.error('sendNotification error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Admin gets all sent notifications
 * @route   GET /api/notifications/all
 */
const getAllNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({}).sort({ createdAt: -1 }).limit(100);
    res.json({
      success: true,
      data: notifications,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Delete notification
 * @route   DELETE /api/notifications/:id
 */
const deleteNotification = async (req, res) => {
  try {
    await Notification.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getNotifications,
  getUnreadCount,
  markNotificationsRead,
  sendNotification,
  getAllNotifications,
  deleteNotification,
};
