const mongoose = require('mongoose');

const Platform = mongoose.Schema({
  platformName: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  platformVersion: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
  browserName: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
  browserVersion: {
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
  userAgent: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
  screenHeight: {
    type: Number,
    required: false,
  },
  screenWidth: {
    type: Number,
    required: false,
  },
  pixelRatio: {
    type: Number,
    required: false,
  },
}, { _id: false });

module.exports = Platform;
