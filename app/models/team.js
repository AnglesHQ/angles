const mongoose = require('mongoose');

const { Schema } = mongoose;

const Component = new Schema({
  name: { type: String, required: true, unique: true },
  features: [{ type: String, required: false }],
});

const TeamSchema = mongoose.Schema({
  name: { type: String, required: true, unique: true },
  components: [{ type: Component, required: true }],
}, {
  timestamps: true,
});

module.exports = mongoose.model('Team', TeamSchema);
