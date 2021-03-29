const mongoose = require('mongoose');
const Platform = require('./platform.js');

const { Schema } = mongoose;
const executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];

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
    enum: ['INFO', 'DEBUG', 'PASS', 'ERROR', 'FAIL'],
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
}, { _id: false });

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
}, { _id: false });

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
  feature: {
    type: String,
    required: false,
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
    required: false,
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
}, { collection: 'testexecutions' });

TestExecutionSchema.index({ build: 1 }, { unique: false });
TestExecutionSchema.index({ suite: 1, title: 1 }, { unique: false });

module.exports = mongoose.model('TestExecution', TestExecutionSchema);
