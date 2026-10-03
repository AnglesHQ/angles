const mongoose = require('mongoose');
const Platform = require('./platform.js');

const { Schema } = mongoose;
const executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];
const executionTypes = ['automated', 'manual'];

const Step = mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
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
  // Images a QA attached while recording a manual step result, or files an automated test
  // uploaded for this step (e.g. the page's HTML when the step failed). Automated
  // screenshots still use `screenshot` above; this shares the same subdocument so there is
  // no parallel step structure to keep in sync.
  attachments: [{
    type: Schema.Types.ObjectId,
    ref: 'Attachment',
    required: false,
  }],
}, { _id: false });

const Action = mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  steps: [{
    type: Step,
    required: false,
  }],
  status: {
    type: String,
    enum: executionStates,
    required: false,
  },
  start: {
    type: Date,
    required: false,
  },
  end: {
    type: Date,
    required: false,
  },
}, { _id: false });

const TestExecutionSchema = mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  suite: {
    type: String,
    required: true,
    trim: true,
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
  // Files the automated test uploaded for the whole execution - a video, a trace, a HAR
  // file or a console log. Step-level files live on the step (see Step.attachments).
  attachments: [{
    type: Schema.Types.ObjectId,
    ref: 'Attachment',
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
  // Mirrors Build.executionType, defaulted the same way so existing documents read back
  // unchanged. Carried on the execution as well as the build because the metrics
  // aggregations group executions without always loading their build.
  executionType: {
    type: String,
    enum: executionTypes,
    default: 'automated',
    required: true,
  },
  // Set on a manual execution: the test case it came from, and - critically - the frozen
  // version it was executed against.
  manualTestCase: {
    type: Schema.Types.ObjectId,
    ref: 'ManualTestCase',
    required: false,
  },
  // The version ref lives here as well as on the run entry on purpose. An execution is
  // reachable from the dashboard and from the execution history without ever loading the
  // run, and it has to be able to render the content it was executed against on its own.
  manualTestCaseVersion: {
    type: Schema.Types.ObjectId,
    ref: 'ManualTestCaseVersion',
    required: false,
  },
  versionNumber: {
    type: Number,
    required: false,
  },
  executedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
}, {
  timestamps: true,
}, { collection: 'testexecutions' });

TestExecutionSchema.index({ build: 1 }, { unique: false });
TestExecutionSchema.index({ suite: 1, title: 1 }, { unique: false });
// "Every run of this manual test case", which the case detail view asks for directly.
TestExecutionSchema.index({ manualTestCase: 1, createdAt: -1 }, { unique: false });

module.exports = mongoose.model('TestExecution', TestExecutionSchema);
module.exports.executionTypes = executionTypes;
