const mongoose = require('mongoose');

const accountDeletionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  role: {
    type: String,
    enum: ['customer', 'seller', 'kitchen', 'rider'],
    default: 'customer',
  },
  status: {
    type: String,
    enum: ['Pending', 'Resolved'],
    default: 'Pending',
  },
  reason: {
    type: String,
    default: 'User requested deletion via app',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  resolvedAt: {
    type: Date,
  },
});

module.exports = mongoose.model('AccountDeletion', accountDeletionSchema);
