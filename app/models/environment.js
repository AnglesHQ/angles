const mongoose = require('mongoose');

const EnvironmentSchema = mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
}, {
  timestamps: true,
});

EnvironmentSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Environment', EnvironmentSchema);
