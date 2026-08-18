const express = require('express');
const router = express.Router();
const { getNotifications, getUnreadCount, markNotificationsRead } = require('../controllers/notification.controller');
const { protect } = require('../middleware/auth');

router.get('/unread-count', protect, getUnreadCount);
router.put('/mark-read', protect, markNotificationsRead);
router.get('/', protect, getNotifications);

module.exports = router;
