const mongoose = require('mongoose');

/**
 * Pending / credited wallet deposits tied to a Razorpay order.
 * Enables webhook reconcile when client verify fails after payment.
 */
const walletDepositSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ['rider', 'kitchen'],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 100,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
    },
    razorpayPaymentId: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ['pending', 'credited', 'failed'],
      default: 'pending',
      index: true,
    },
    receipt: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

walletDepositSchema.index({ userId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('WalletDeposit', walletDepositSchema);
