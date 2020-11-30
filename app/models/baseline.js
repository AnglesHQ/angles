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

const Platform = new Schema({
  platformName: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  browserName: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
  deviceName: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
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
  platform: {
    type: Platform,
    required: true,
  },
  screenHeight: {
    type: Number,
    required: false,
  },
  screenWidth: {
    type: Number,
    required: false,
  },
  ignoreBoxes: [{
    type: IgnoreBox,
    required: false,
  }],
}, {
  timestamps: true,
});

BaselineSchema.index({ view: 1 }, { unique: false });

module.exports = mongoose.model('Baseline', BaselineSchema);
