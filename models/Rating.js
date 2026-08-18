// ====================================
// Rating Model
// ====================================

const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    required: true,
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  kitchenId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Kitchen',
    required: true,
  },
  menuItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MenuItem',
    default: null, // Optional: links review to a specific dish
  },
  kitchenRating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  riderRating: {
    type: Number,
    required: false,
    min: 1,
    max: 5,
  },
  feedback: {
    type: String,
    default: '',
    trim: true,
    maxlength: 250,
  },
  photos: [{
    type: String, // Cloudinary URLs of customer review photos (max 3)
  }],
  helpfulCount: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

// Index for kitchen ratings
ratingSchema.index({ kitchenId: 1, createdAt: -1 });

// Index for dish-level ratings
ratingSchema.index({ menuItemId: 1, createdAt: -1 });

const Rating = mongoose.model('Rating', ratingSchema);
Rating.collection.dropIndex('orderId_1').catch(() => {});
module.exports = Rating;
