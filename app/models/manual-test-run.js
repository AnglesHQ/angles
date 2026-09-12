const mongoose = require('mongoose');
const Platform = require('./platform.js');

const { Schema } = mongoose;

const runStates = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

// Per-case result states. Richer than the closed `executionStates` enum the metrics layer
// depends on: BLOCKED and IN_PROGRESS have no equivalent there and are kept here only.
const caseResultStates = ['NOT_RUN', 'IN_PROGRESS', 'PASS', 'FAIL', 'ERROR', 'SKIPPED', 'BLOCKED'];

// How a per-case state is written to the TestExecution the metrics layer reads.
//
// BLOCKED maps to SKIPPED rather than ERROR: a blocked test was never executed, so nothing
// was verified and no defect was found. Recording it as ERROR would inflate the failure
// count on every dashboard and alert that counts errors. IN_PROGRESS has no execution yet.
const EXECUTION_STATUS_BY_CASE_STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  ERROR: 'ERROR',
  SKIPPED: 'SKIPPED',
  BLOCKED: 'SKIPPED',
  NOT_RUN: 'SKIPPED',
  IN_PROGRESS: 'SKIPPED',
};

// The result a tester recorded against one step of the frozen version.
const StepResult = new Schema({
  // The _id of the step in the frozen ManualTestCaseVersion. ManualStep keeps its _id
  // precisely so this binding survives a later reorder or deletion.
  stepId: {
    type: Schema.Types.ObjectId,
    required: false,
  },
  status: {
    type: String,
    enum: ['NOT_RUN', 'PASS', 'FAIL', 'BLOCKED', 'SKIPPED'],
    default: 'NOT_RUN',
    required: true,
  },
  actual: {
    type: String,
    required: false,
  },
  notes: {
    type: String,
    required: false,
  },
  attachments: [{
    type: Schema.Types.ObjectId,
    ref: 'Attachment',
    required: false,
  }],
  timestamp: {
    type: Date,
    required: false,
  },
}, { _id: false });

// One test case as scheduled into a run.
const RunTestCase = new Schema({
  // The mutable head, so "show me every run of this case" is a single query.
  testCase: {
    type: Schema.Types.ObjectId,
    ref: 'ManualTestCase',
    required: true,
  },
  // The frozen content actually being executed. Bound at run creation and never moved
  // implicitly: editing a case mid-run must not shift the steps under the tester.
  testCaseVersion: {
    type: Schema.Types.ObjectId,
    ref: 'ManualTestCaseVersion',
    required: true,
  },
  // Denormalised so the run list can show "v3" without joining the version collection.
  versionNumber: {
    type: Number,
    required: false,
  },
  // Copied from the version at binding time, so the tester's step list is stable even if
  // the version document is somehow unavailable. Display only - the version is the record.
  snapshotTitle: {
    type: String,
    required: false,
  },
  status: {
    type: String,
    enum: caseResultStates,
    default: 'NOT_RUN',
    required: true,
  },
  stepResults: [{
    type: StepResult,
    required: false,
  }],
  execution: {
    type: Schema.Types.ObjectId,
    ref: 'TestExecution',
    required: false,
  },
  executedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  notes: {
    type: String,
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
});

// A planned or in-flight session of manual testing.
//
// The run sits beside a Build rather than replacing it: results are written as
// TestExecution documents against a Build tagged executionType 'manual', so every existing
// dashboard and metrics aggregation counts them without a parallel pipeline. What the run
// holds is everything a build has no concept of - who it is assigned to, which cases are
// still outstanding, and which frozen version each one is bound to.
const ManualTestRunSchema = mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  description: {
    type: String,
    required: false,
  },
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  // One component per run, matching Build.component - the backing build carries it, and a
  // run spanning components would make the component metrics approximate.
  component: {
    type: Schema.Types.ObjectId,
    required: false,
  },
  environment: {
    type: Schema.Types.ObjectId,
    ref: 'Environment',
    required: true,
  },
  phase: {
    type: Schema.Types.ObjectId,
    ref: 'Phase',
    required: false,
  },
  // The manual-tagged build this run's executions are written into.
  build: {
    type: Schema.Types.ObjectId,
    ref: 'Build',
    required: false,
  },
  status: {
    type: String,
    enum: runStates,
    default: 'PLANNED',
    required: true,
  },
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  // Reused from the automated model verbatim, so manual runs capture the same
  // platform/device metrics and the platform aggregations need no new fields.
  platforms: [{
    type: Platform,
    required: false,
  }],
  testCases: [{
    type: RunTestCase,
    required: false,
  }],
  start: {
    type: Date,
    required: false,
  },
  end: {
    type: Date,
    required: false,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
}, {
  timestamps: true,
  collection: 'manualtestruns',
});

ManualTestRunSchema.index({ team: 1, createdAt: -1 }, { unique: false });
ManualTestRunSchema.index({ team: 1, status: 1 }, { unique: false });
ManualTestRunSchema.index({ assignedTo: 1, status: 1 }, { unique: false });
ManualTestRunSchema.index({ 'testCases.testCase': 1 }, { unique: false });

module.exports = mongoose.model('ManualTestRun', ManualTestRunSchema);
module.exports.runStates = runStates;
module.exports.caseResultStates = caseResultStates;
module.exports.EXECUTION_STATUS_BY_CASE_STATUS = EXECUTION_STATUS_BY_CASE_STATUS;
