// ====================================
// Rider Model — Partner Ecosystem
// ====================================

const mongoose = require('mongoose');

const riderSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  phone: {
    type: String,
    required: true,
    trim: true,
  },
  vehicleName: {
    type: String,
    default: '',
    trim: true,
  },
  vehicleNumber: {
    type: String,
    default: '',
    trim: true,
  },
  licenseNumber: {
    type: String,
    default: '',
    trim: true,
  },
  photo: {
    type: String, // Avatar URL
    default: '',
  },
  pinCode: {
    type: String,
    default: '',
  },
  isOnline: {
    type: Boolean,
    default: false,
  },
  /**
   * When the current On Duty session started (set on go-online, cleared on offline).
   * Used by 8-hour max-shift failsafe cron.
   */
  dutyStartedAt: {
    type: Date,
    default: null,
  },
  dutyLocation: {
    type: String,
    default: '',
  },
  currentLocation: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      default: [0, 0],
    },
  },
  /** Last successful GPS push from rider app — used to exclude stale online riders from broadcast */
  lastLocationAt: {
    type: Date,
    default: null,
  },
  floatingCash: {
    type: Number,
    default: 0, // Increases when collecting COD cash at door
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
  documents: {
    aadhaarUrl: { type: String, default: '' },
    aadhaarPublicId: { type: String, default: '' },
    panUrl: { type: String, default: '' },
    panPublicId: { type: String, default: '' },
    drivingLicenseUrl: { type: String, default: '' },
    drivingLicensePublicId: { type: String, default: '' },
  },
  activeOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
  },
  expoPushToken: {
    type: String,
    default: '',
  },
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active',
  },
}, {
  timestamps: true,
});

// 2dsphere index for geospatial queries (7KM broadcast radius)
riderSchema.index({ currentLocation: '2dsphere' });
riderSchema.index({ isOnline: 1, accountStatus: 1 });
riderSchema.index({ isOnline: 1, lastLocationAt: -1 });
riderSchema.index({ isOnline: 1, dutyStartedAt: 1 });
riderSchema.index({ isOnline: 1, activeOrderId: 1, lastLocationAt: 1 });

module.exports = mongoose.model('Rider', riderSchema);
