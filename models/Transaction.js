// ====================================
// Transaction Model
// ====================================

const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  kitchenId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Kitchen',
    default: null,
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
  },
  walletId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Wallet',
    default: null,
  },
  type: {
    type: String,
    enum: [
      'advance',
      'cash',
      'withdrawal',
      'deposit',
      'withdrawal_request',
      'withdrawal_success',
      'withdrawal_rejected',
    ],
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  description: {
    type: String,
    default: '',
  },
  razorpayPaymentId: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

transactionSchema.index({ razorpayPaymentId: 1 }, { unique: true, sparse: true });

// One settlement credit per order+type — blocks double-credit on ledger retry
transactionSchema.index(
  { orderId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: { orderId: { $exists: true, $ne: null } },
  }
);

// Index for kitchen transaction history
transactionSchema.index({ kitchenId: 1, createdAt: -1 });
transactionSchema.index({ walletId: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
