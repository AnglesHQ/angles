const mongoose = require('mongoose');

const PhaseSchema = mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  orderNumber: {
    type: Number,
    required: false,
  },
}, {
  timestamps: true,
}, { collection: 'phase' });

PhaseSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Phase', PhaseSchema);
