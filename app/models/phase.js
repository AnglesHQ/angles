const mongoose = require('mongoose');

const PhaseSchema = mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  priotity: {
    type: Number,
    required: true,
  },
}, {
  timestamps: true,
}, { collection: 'phase' });

PhaseSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Phase', PhaseSchema);
