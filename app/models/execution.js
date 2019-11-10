const mongoose = require('mongoose');

const { Schema } = mongoose;

const Step = mongoose.Schema({
  description: { type: String, required: true },
  expected: { type: String, required: false },
  actual: { type: String, required: false },
  info: { type: String, required: false },
  status: { type: String, enum: ['INFO', 'PASS', 'ERROR', 'FAIL'], required: true },
  timestamp: { type: Date, required: true },
});

const Platform = mongoose.Schema({
  platformName: { type: String, required: true },
  platformVersion: { type: String, required: false },
  browserName: { type: String, required: true },
  browserVersion: { type: String, required: false },
  deviceName: { type: String, required: false },
  deviceBrand: { type: String, required: false },
  deviceModel: { type: String, required: false },
  userAgent: { type: String, required: false },
});

const TestExecutionSchema = mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: false },
  // suite: { type: String, required: true },
  build: { type: Schema.Types.ObjectId, ref: 'Build' },
  platforms: [{ type: Platform, required: false }],
  steps: [{ type: Step, required: false }],
  tags: [{ type: String, required: false }],
  status: { type: String, enum: ['SKIPPED', 'PASS', 'ERROR', 'FAIL'], required: true },
}, {
  timestamps: true,
});

module.exports = mongoose.model('TestExecution', TestExecutionSchema);
