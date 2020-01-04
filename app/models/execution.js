const mongoose = require('mongoose');

const { Schema } = mongoose;
const executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];

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
  deviceBrand: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
  deviceModel: {
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
});

const Step = mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  expected: {
    type: String,
    required: false,
  },
  actual: {
    type: String,
    required: false,
  },
  info: {
    type: String,
    required: false,
  },
  status: {
    type: String,
    enum: ['INFO', 'PASS', 'ERROR', 'FAIL'],
    required: true,
  },
  timestamp: {
    type: Date,
    required: true,
  },
  screenshot: {
    type: Schema.Types.ObjectId,
    ref: 'Screenshot',
    required: false,
  },
});

const Action = mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  steps: [{
    type: Step,
    required: true,
  }],
  status: {
    type: String,
    enum: executionStates,
    required: false,
  },
  start: {
    type: Date,
    required: true,
  },
  end: {
    type: Date,
    required: true,
  },
});


const TestExecutionSchema = mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  suite: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  build: {
    type: Schema.Types.ObjectId,
    ref: 'Build',
    required: true,
  },
  start: {
    type: Date,
    required: true,
  },
  end: {
    type: Date,
    required: false,
  },
  actions: [{
    type: Action,
    required: false,
  }],
  platforms: [{
    type: Platform,
    required: false,
  }],
  tags: [{
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  }],
  meta: [{
    type: Map,
    of: String,
    required: false,
  }],
  status: {
    type: String,
    enum: executionStates,
    required: true,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('TestExecution', TestExecutionSchema);
