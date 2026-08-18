// ====================================
// Kitchen Model
// ====================================

const mongoose = require('mongoose');

const kitchenSchema = new mongoose.Schema({
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 60,
  },
  ownerName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 40,
  },
  upiId: {
    type: String,
    required: false,
    default: '',
    trim: true,
  },
  fssaiNumber: {
    type: String,
    default: '',
    trim: true,
  },
  pinCode: {
    type: String,
    default: '',
    trim: true,
  },
  photo: {
    type: String, // Cloudinary URL
    default: '',
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: true,
    },
  },
  isOpen: {
    type: Boolean,
    default: false,
  },
  /**
   * Consecutive acceptance timeouts (seller no-response).
   * Reset to 0 when seller accepts an order; at 3 → auto-close shop.
   */
  consecutiveMisses: {
    type: Number,
    default: 0,
    min: 0,
  },
  avgRating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5,
  },
  totalOrders: {
    type: Number,
    default: 0,
  },
  totalReviews: {
    type: Number,
    default: 0,
  },
  totalEarnings: {
    type: Number,
    default: 0,
  },
  paymentMethods: {
    phonePe: { type: String, default: '' },
    upiId: { type: String, default: '' },
    bankDetails: {
      accountNumber: { type: String, default: '' },
      ifsc: { type: String, default: '' },
      accountName: { type: String, default: '' }
    },
    qrCodeUrl: { type: String, default: '' }
  },
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active',
  },
  verificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  verifiedAt: { type: Date, default: null },
  rejectionReason: { type: String, default: null },
  expoPushToken: { type: String, default: null },
  suspendedAt: { type: Date, default: null },
  suspendReason: { type: String, default: null },
}, {
  timestamps: true,
});

// 2dsphere index for geospatial queries (7KM radius)
kitchenSchema.index({ location: '2dsphere' });

// Compound index for nearby + open kitchens
kitchenSchema.index({ isOpen: 1, accountStatus: 1 });
kitchenSchema.index({ verificationStatus: 1, accountStatus: 1 });
kitchenSchema.index({ ownerId: 1 }, { unique: true });

module.exports = mongoose.model('Kitchen', kitchenSchema);
