const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  imageUrl: {
    type: String,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  order: {
    type: Number,
    default: 0,
  },
  actionType: {
    type: String, // 'none', 'link', 'category', 'kitchen'
    default: 'none',
  },
  actionData: {
    type: String, // e.g. URL if actionType is 'link'
    default: '',
  }
}, { timestamps: true });

module.exports = mongoose.model('Banner', bannerSchema);
