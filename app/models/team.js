const mongoose = require('mongoose');

const { Schema } = mongoose;

const Component = new Schema({
  name: {
    type: String,
    required: true,
    unique: false,
    lowercase: true,
  },
  features: [{
    type: String,
    required: false,
    lowercase: true,
  }],
});

const TeamSchema = mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  components: [{
    type: Component,
    required: true,
  }],
}, {
  timestamps: true,
});

module.exports = {
  Team: mongoose.model('Team', TeamSchema),
  Component: mongoose.model('Component', Component),
};
