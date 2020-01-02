const mongoose = require('mongoose');

const { Schema } = mongoose;
const executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];

const Platform = mongoose.Schema({
  platformName: { type: String, required: true },
  platformVersion: { type: String, required: false },
  browserName: { type: String, required: false },
  browserVersion: { type: String, required: false },
  deviceName: { type: String, required: false },
  deviceBrand: { type: String, required: false },
  deviceModel: { type: String, required: false },
  userAgent: { type: String, required: false },
  screenHeight: { type: Number, required: false },
  screenWidth: { type: Number, required: false },
  pixelRatio: { type: Number, required: false },
});

const Step = mongoose.Schema({
  name: { type: String, required: true },
  expected: { type: String, required: false },
  actual: { type: String, required: false },
  info: { type: String, required: false },
  status: { type: String, enum: ['INFO', 'PASS', 'ERROR', 'FAIL'], required: true },
  timestamp: { type: Date, required: true },
});

const Action = mongoose.Schema({
  name: { type: String, required: true },
  steps: [{ type: Step, required: true }],
  status: { type: String, enum: executionStates, required: false },
  start: { type: Date, required: true },
  end: { type: Date, required: true },
});


const TestExecutionSchema = mongoose.Schema({
  title: { type: String, required: true },
  suite: { type: String, required: true },
  build: { type: Schema.Types.ObjectId, ref: 'Build', required: true },
  start: { type: Date, required: false },
  end: { type: Date, required: false },
  actions: [{ type: Action, required: false }],
  platforms: [{ type: Platform, required: false }],
  tags: [{ type: String, required: false }],
  meta: [{ type: Map, of: String, required: false }],
  status: { type: String, enum: executionStates, required: true },
}, {
  timestamps: true,
});

module.exports = mongoose.model('TestExecution', TestExecutionSchema);
