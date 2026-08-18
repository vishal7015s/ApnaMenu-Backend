// ====================================
// Order Model
// ====================================

const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  menuItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MenuItem',
    required: true,
  },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  qty: { type: Number, required: true, min: 1 },
  type: { type: String, enum: ['veg', 'nonveg'], default: 'veg' },
}, { _id: false });

const orderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true, // AM-XXXX format
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  customerName: {
    type: String,
  },
  customerPhone: {
    type: String,
  },
  kitchenId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Kitchen',
    required: true,
  },
  items: [orderItemSchema],
  itemTotal: {
    type: Number,
    required: true,
  },
  deliveryFee: {
    type: Number,
    default: 20,
  },
  /** Fixed platform fee charged to customer; paid to rider (or self-delivering seller). */
  platformFee: {
    type: Number,
    default: 9,
  },
  grandTotal: {
    type: Number,
    required: true,
  },

  // Payment details
  paymentType: {
    type: String,
    enum: ['online', 'partialCod'],
    required: true,
  },
  onlineAmount: {
    type: Number,
    default: 0, // 30% for partialCod, 100% for online
  },
  cashAmount: {
    type: Number,
    default: 0, // 70% for partialCod
  },
  paymentStatus: {
    type: String,
    enum: ['awaiting_acceptance', 'pending', 'paid', 'refunded', 'failed', 'refund_pending'],
    default: 'awaiting_acceptance',
  },
  razorpayOrderId: { type: String, default: null },
  razorpayPaymentId: { type: String, default: null },
  razorpaySignature: { type: String, default: null },
  doorPaymentMode: {
    type: String,
    enum: ['cash', 'online', null],
    default: null, // Seller/rider claim of how door remainder was collected
  },
  // Set true only by verified doorstep gateway webhook — never by client claim
  doorPaymentVerified: {
    type: Boolean,
    default: false,
  },

  // Order status
  status: {
    type: String,
    enum: ['PENDING_SELLER_APPROVAL', 'PENDING_CUSTOMER_PAYMENT', 'placed', 'accepted', 'preparing', 'ready', 'outForDelivery', 'delivered', 'cancelled', 'autoCancelled'],
    default: 'PENDING_SELLER_APPROVAL',
  },

  // Delivery choice & Rider details
  deliveryMethod: {
    type: String,
    enum: ['self', 'rider', null],
    default: null,
  },
  riderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  riderBroadcasts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  riderRejections: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  riderStatus: {
    type: String,
    enum: ['none', 'pending', 'accepted', 'rejected_all', 'ignored_all'],
    default: 'none',
  },
  pickupOtp: {
    type: String, // 4-digit OTP generated for kitchen verification
    default: null,
  },
  dropOtp: {
    type: String, // 4-digit OTP generated for customer verification
    default: null,
  },
  walletSettled: {
    type: Boolean,
    default: false, // Prevents duplicate ledger calculations upon delivery
  },

  // Delivery details
  deliveryLocation: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
    },
  },
  deliveryAddress: {
    house: { type: String },
    landmark: { type: String },
    label: { type: String },
  },
  distance: {
    type: Number, // Distance in KM
  },
  deliveryOtp: {
    type: String, // Legacy support
    default: null,
  },

  // Schedule delivery
  schedule: {
    isScheduled: { type: Boolean, default: false },
    date: { type: Date, default: null },
    timeSlot: { type: String, default: null },
  },

  // Timestamps
  placedAt: { type: Date, default: Date.now },
  acceptedAt: { type: Date, default: null },
  prepStartedAt: { type: Date, default: null },
  kitchenHandoverAt: { type: Date, default: null },
  riderSearchStartedAt: { type: Date, default: null },
  outForDeliveryAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, default: null },

  // Rating
  isRated: { type: Boolean, default: false },
  rating: {
    kitchenRating: { type: Number, min: 1, max: 5 },
    riderRating: { type: Number, min: 1, max: 5 },
    feedback: { type: String, trim: true, maxlength: 250 },
    ratedAt: { type: Date }
  }
}, {
  timestamps: true,
});

// Indexes for efficient queries
orderSchema.index({ customerId: 1, status: 1 });
orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ customerId: 1, status: 1, createdAt: -1 });
orderSchema.index({ kitchenId: 1, status: 1 });
orderSchema.index({ kitchenId: 1, createdAt: -1 });
orderSchema.index({ kitchenId: 1, status: 1, createdAt: 1 });
orderSchema.index({ kitchenId: 1, status: 1, createdAt: -1 });
orderSchema.index({ kitchenId: 1, status: 1, deliveredAt: -1 });
orderSchema.index({ riderId: 1, status: 1 });
orderSchema.index({ riderId: 1, status: 1, createdAt: -1 });
orderSchema.index({ riderId: 1, deliveredAt: -1 });
orderSchema.index({ riderBroadcasts: 1, status: 1 });
orderSchema.index({ razorpayOrderId: 1 }, { sparse: true });
orderSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);

