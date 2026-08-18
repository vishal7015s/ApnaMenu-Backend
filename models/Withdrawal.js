// ====================================
// Withdrawal Model
// ====================================

const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  // Either kitchenId OR riderId will be set based on requesterType
  kitchenId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Kitchen',
    default: null,
  },
  riderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Rider',
    default: null,
  },
  requesterType: {
    type: String,
    enum: ['kitchen', 'rider'],
    required: true,
    default: 'kitchen',
  },
  amount: {
    type: Number,
    required: true,
    min: 1,
  },
  currentBalance: {
    type: Number,
    default: 0,
  },
  paymentMethodType: {
    type: String,
    enum: ['qrcode', 'phonepe', 'bank', 'upi'],
    default: 'phonepe',
  },
  paymentDetails: {
    qrCodeImage: { type: String, default: '' },
    phonePeNumber: { type: String, default: '' },
    upiId: { type: String, default: '' },
    bankAccount: {
      accountHolderName: { type: String, default: '' },
      accountNumber: { type: String, default: '' },
      ifscCode: { type: String, default: '' },
    },
  },
  // Backward compatibility field
  upiId: {
    type: String,
    default: '',
    trim: true,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null,
  },
  settledAt: {
    type: Date,
    default: null,
  },
  notes: {
    type: String,
    default: '',
    trim: true,
  },
  requestedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

withdrawalSchema.index({ kitchenId: 1, status: 1 });
withdrawalSchema.index({ riderId: 1, status: 1 });
withdrawalSchema.index(
  { kitchenId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending', kitchenId: { $exists: true, $ne: null } } }
);
withdrawalSchema.index(
  { riderId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending', riderId: { $exists: true, $ne: null } } }
);

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
