// ====================================
// User Model
// ====================================

const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
  label: {
    type: String,
    enum: ['home', 'office', 'factory', 'other'],
    default: 'home',
  },
  house: {
    type: String,
    required: true,
    trim: true,
    maxlength: [80, 'House / company name cannot exceed 80 characters'],
  },
  landmark: {
    type: String,
    required: true,
    trim: true,
    maxlength: [80, 'Landmark cannot exceed 80 characters'],
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
}, { _id: true });

const userSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  name: {
    type: String,
    trim: true,
    default: '',
    maxlength: [40, 'Name cannot exceed 40 characters'],
  },
  avatar: {
    type: String,
    default: '',
  },
  role: {
    type: String,
    enum: ['customer', 'kitchen', 'rider'],
    default: 'customer',
  },
  activeRole: {
    type: String,
    enum: ['customer', 'kitchen', 'rider'],
    default: 'customer',
  },
  /** Survives app clear data — tracks incomplete signup path. */
  signupIntent: {
    type: String,
    enum: ['customer', 'kitchen', 'rider', null],
    default: null,
  },
  language: {
    type: String,
    enum: ['en', 'hi'],
    default: 'en',
  },
  addresses: [addressSchema],
  onlineOrderCount: {
    type: Number,
    default: 0,
  },
  codUnlocked: {
    type: Boolean,
    default: false,
  },
  codBannedArea: {
    type: Boolean,
    default: false,
  },
  googleId: {
    type: String,
    default: null,
  },
  fcmToken: {
    type: String,
    default: null,
  },
  /**
   * Incremented on rider login/logout/suspend to revoke older JWTs (single active session).
   * JWT payload includes `tv` matching this value.
   */
  tokenVersion: {
    type: Number,
    default: 0,
  },
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active',
  },
  suspendedAt: { type: Date, default: null },
  suspendReason: { type: String, default: null },
}, {
  timestamps: true,
});

// Index for geospatial queries on addresses
addressSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('User', userSchema);
