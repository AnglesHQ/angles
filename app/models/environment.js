const mongoose = require('mongoose');

const EnvironmentSchema = mongoose.Schema({
  name: { type: String, required: true, unique: true },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Environment', EnvironmentSchema);
