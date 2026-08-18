// ====================================
// Wallet & Digital Ledger Model
// ====================================

const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  role: {
    type: String,
    enum: ['kitchen', 'rider'],
    required: true,
  },
  balance: {
    type: Number,
    default: 0, 
    // Positive balance = Money owed by Admin to Seller/Rider
    // Negative balance = Money owed by Rider to Admin (due to COD floating cash)
  },
  totalEarned: {
    type: Number,
    default: 0,
  },
  totalWithdrawn: {
    type: Number,
    default: 0,
  },
  floatingCashHeld: {
    type: Number,
    default: 0, // Specifically tracks cash collected at door by Rider
  },
}, {
  timestamps: true,
});

// Compound index to ensure 1 wallet per user per role
walletSchema.index({ userId: 1, role: 1 }, { unique: true });

module.exports = mongoose.model('Wallet', walletSchema);
