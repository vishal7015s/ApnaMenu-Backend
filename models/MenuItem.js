// ====================================
// MenuItem Model
// ====================================

const mongoose = require('mongoose');
const { MENU_CATEGORY_IDS } = require('../constants/menuCategories');

const menuItemSchema = new mongoose.Schema({
  kitchenId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Kitchen',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 80,
  },
  description: {
    type: String,
    default: '',
    trim: true,
    maxlength: 500,
  },
  photo: {
    type: String, // Cloudinary URL (primary image, backward compatible)
    default: '',
  },
  photoPublicId: {
    type: String, // Cloudinary public ID for deletion
    default: '',
  },
  photos: [{
    url: { type: String, required: true },
    publicId: { type: String, default: '' },
  }],
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  originalPrice: {
    type: Number,
    default: null, // If set and > price, shows discount badge
  },
  prepTime: {
    type: Number,
    required: true,
    enum: [5, 10, 15, 20, 30], // Minutes
  },
  category: {
    type: String,
    required: true,
    enum: MENU_CATEGORY_IDS,
  },
  type: {
    type: String,
    enum: ['veg', 'nonveg'], // Optional — seller may leave unspecified (field stays undefined)
  },
  tags: [{
    type: String,
    trim: true,
    maxlength: 30,
  }],
  inStock: {
    type: Boolean,
    default: true,
  },
  totalOrders: {
    type: Number,
    default: 0,
  },
  rating: {
    type: Number,
    default: 0,
  },
  totalReviews: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

// Index for searching menu items by kitchen
menuItemSchema.index({ kitchenId: 1, inStock: 1 });
menuItemSchema.index({ kitchenId: 1, category: 1, name: 1 });
menuItemSchema.index({ category: 1, inStock: 1, totalOrders: -1 });
menuItemSchema.index({ kitchenId: 1, inStock: 1, totalOrders: -1 });

// Text index for search functionality
menuItemSchema.index({ name: 'text' });

module.exports = mongoose.model('MenuItem', menuItemSchema);
