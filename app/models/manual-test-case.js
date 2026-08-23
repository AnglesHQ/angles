const mongoose = require('mongoose');

const { Schema } = mongoose;

const testCaseStates = ['DRAFT', 'ACTIVE', 'DEPRECATED'];
const testCasePriorities = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

// A single step of a manual test case. Unlike most subdocuments in this project this one
// keeps its `_id`: a recorded step result binds to a specific step of a specific frozen
// version, so a step reordered or removed in a later version can never pull a historical
// result onto the wrong step.
const ManualStep = new Schema({
  order: {
    type: Number,
    required: true,
  },
  action: {
    type: String,
    required: true,
    trim: true,
  },
  expected: {
    type: String,
    required: false,
  },
  // Set when this step is an inclusion of a re-usable shared step (added in phase 3).
  // When present the step's own action/expected are ignored in favour of the shared
  // step's contents.
  sharedStep: {
    type: Schema.Types.ObjectId,
    ref: 'SharedStep',
    required: false,
  },
  attachments: [{
    type: Schema.Types.ObjectId,
    ref: 'Attachment',
    required: false,
  }],
  // Test data the QA needs for this step (accounts, payloads, fixture references).
  data: {
    type: String,
    required: false,
  },
});

// The mutable head of a manual test case: it always reflects the latest content. Every
// version that has ever existed is additionally written to the append-only
// ManualTestCaseVersion collection, and it is those frozen documents that executions bind
// to - never this one. See docs/plans/manual-test-case-management.md.
const ManualTestCaseSchema = mongoose.Schema({
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  // Matches Build.component: the component _id from the team's components array.
  component: {
    type: Schema.Types.ObjectId,
    required: false,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  description: {
    type: String,
    required: false,
  },
  preconditions: {
    type: String,
    required: false,
  },
  status: {
    type: String,
    enum: testCaseStates,
    default: 'DRAFT',
    required: true,
  },
  priority: {
    type: String,
    enum: testCasePriorities,
    default: 'MEDIUM',
    required: true,
  },
  tags: [{
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  }],
  steps: [{
    type: ManualStep,
    required: false,
  }],
  // Values for the custom fields an admin configured for this team (phase 2). Mixed
  // because the value type depends on the field definition's `type`.
  customFields: {
    type: Map,
    of: Schema.Types.Mixed,
    required: false,
    default: () => new Map(),
  },
  // Incremented on every content change. Always points at an existing document in the
  // version collection.
  version: {
    type: Number,
    default: 1,
    required: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
}, {
  timestamps: true,
  collection: 'manualtestcases',
});

ManualTestCaseSchema.index({ team: 1, status: 1 }, { unique: false });
ManualTestCaseSchema.index({ team: 1, createdAt: -1 }, { unique: false });
ManualTestCaseSchema.index({ tags: 1 }, { unique: false });
// Backs the `search` query parameter on GET /manual-test-case.
ManualTestCaseSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('ManualTestCase', ManualTestCaseSchema);
module.exports.ManualStep = ManualStep;
module.exports.testCaseStates = testCaseStates;
module.exports.testCasePriorities = testCasePriorities;
