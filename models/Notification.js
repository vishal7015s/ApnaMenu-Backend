// ====================================
// Notification Model
// ====================================

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  targetRole: {
    type: String,
    enum: ['all', 'rider', 'kitchen', 'user'],
    default: 'all',
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  title: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['promo', 'system', 'wallet', 'order', 'alert'],
    default: 'system',
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Notification', notificationSchema);
