const mongoose = require('mongoose');
const Platform = require('./platform.js');

const { Schema } = mongoose;

const ScreenshotSchema = mongoose.Schema({
  build: {
    type: Schema.Types.ObjectId,
    ref: 'Build',
    required: true,
  },
  thumbnail: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    required: true,
  },
  path: {
    type: String,
    required: true,
  },
  view: {
    type: String,
    required: false,
  },
  height: {
    type: Number,
    required: false,
  },
  width: {
    type: Number,
    required: false,
  },
  platform: {
    type: Platform,
    required: false,
  },
  metaData: {
    type: Map,
    required: false,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Screenshot', ScreenshotSchema);
