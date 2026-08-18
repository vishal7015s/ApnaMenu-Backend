const mongoose = require('mongoose');

const notificationReadSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  notificationId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
}, {
  timestamps: true,
});

notificationReadSchema.index({ userId: 1, notificationId: 1 }, { unique: true });

module.exports = mongoose.model('NotificationRead', notificationReadSchema);
