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
    // Required only for a literal step. A shared step inclusion carries no action of its
    // own - the shared step's contents are expanded in its place, and expandSteps supplies
    // a placeholder action if the reference cannot be resolved - so demanding one here
    // would force callers to invent a dummy value that is never displayed.
    required: [
      function actionRequiredForLiteralSteps() { return !this.sharedStep && !this.sharedStepRef; },
      'Each step requires an action unless it includes a shared step',
    ],
    trim: true,
  },
  expected: {
    type: String,
    required: false,
  },
  // Set when this step is an inclusion of a re-usable shared step. On the mutable head
  // it marks a placeholder whose own action/expected are ignored; the shared step's
  // contents are expanded in its place. A frozen version never stores a placeholder -
  // it stores the expanded result, with the two attribution fields below.
  sharedStep: {
    type: Schema.Types.ObjectId,
    ref: 'SharedStep',
    required: false,
  },
  // Display attribution on an expanded step: which shared step it came from and at which
  // version. Carried so the UI can show "from <shared step> v2" and so a frozen version
  // records what the tester was actually looking at, without the step still being a
  // reference that could resolve differently later.
  sharedStepRef: {
    type: Schema.Types.ObjectId,
    ref: 'SharedStep',
    required: false,
  },
  sharedStepVersion: {
    type: Number,
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
  // The folder this case is filed under, or null for the team's root. Organisation rather
  // than content: a move does not burn a version, and a frozen version carries no folder -
  // an execution renders what was tested, not where the case has since been filed.
  folder: {
    type: Schema.Types.ObjectId,
    ref: 'ManualFolder',
    required: false,
    default: null,
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
// Drives the folder-filtered case list.
ManualTestCaseSchema.index({ team: 1, folder: 1 }, { unique: false });
// Backs the `search` query parameter on GET /manual-test-case.
ManualTestCaseSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('ManualTestCase', ManualTestCaseSchema);
module.exports.ManualStep = ManualStep;
module.exports.testCaseStates = testCaseStates;
module.exports.testCasePriorities = testCasePriorities;
