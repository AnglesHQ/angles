const mongoose = require('mongoose');

const { Schema } = mongoose;

const BuildSchema = Schema({
  environment: { type: Schema.Types.ObjectId, ref: 'Environment' },
  team: { type: Schema.Types.ObjectId, ref: 'Team' },
  name: { type: String, required: false },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Build', BuildSchema);
