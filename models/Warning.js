// ====================================
// Warning Model
// ====================================

const mongoose = require('mongoose');

const warningSchema = new mongoose.Schema({
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'targetModel',
  },
  targetModel: {
    type: String,
    required: true,
    enum: ['User', 'Kitchen'],
  },
  targetType: {
    type: String,
    enum: ['user', 'kitchen'],
    required: true,
  },
  title: {
    type: String,
    default: '',
    trim: true,
  },
  message: {
    type: String,
    required: true,
    trim: true,
  },
  issuedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    required: true,
  },
  issuedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

// Index for target warnings lookup
warningSchema.index({ targetId: 1, targetType: 1 });

module.exports = mongoose.model('Warning', warningSchema);
