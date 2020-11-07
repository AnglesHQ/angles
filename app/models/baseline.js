const mongoose = require('mongoose');

const { Schema } = mongoose;

const IgnoreBox = new Schema({
  left: {
    type: Number,
    required: true,
  },
  top: {
    type: Number,
    required: true,
  },
  right: {
    type: Number,
    required: true,
  },
  bottom: {
    type: Number,
    required: true,
  },
});

const BaselineSchema = mongoose.Schema({
  screenshot: {
    type: Schema.Types.ObjectId,
    ref: 'Screenshot',
    required: true,
  },
  view: {
    type: String,
    required: true,
    lowercase: true,
  },
  deviceName: {
    type: String,
    required: true,
    lowercase: true,
  },
  height: {
    type: Number,
    required: true,
  },
  width: {
    type: Number,
    required: true,
  },
  ignoreBoxes: [{
    type: IgnoreBox,
    required: false,
  }],
}, {
  timestamps: true,
});

BaselineSchema.index({ view: 1, deviceName: 1 }, { unique: true });

module.exports = mongoose.model('Baseline', BaselineSchema);
