const mongoose = require('mongoose');
const { ManualStep, testCasePriorities } = require('./manual-test-case.js');

const { Schema } = mongoose;

// A frozen copy of a custom field definition as it stood when a version was written, so a
// field that is later relabelled, retyped or archived still renders a historical execution
// with the label and type the QA actually saw. Populated from phase 2 onwards; versions
// written before then simply carry an empty array.
const CustomFieldDefinitionSnapshot = new Schema({
  key: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    required: false,
  },
  type: {
    type: String,
    required: false,
  },
  options: [{
    type: String,
    required: false,
  }],
}, { _id: false });

// An immutable, fully self-contained copy of one version of a manual test case.
//
// Documents in this collection are only ever inserted - nothing in the application
// updates or deletes them. That is the property the whole feature rests on: an execution
// bound to version 3 cannot be made to render version 4's content, because there is no
// write path that can alter version 3's document.
//
// The copy is deliberately complete rather than a diff or a step-only snapshot: an
// execution has to render exactly what the tester saw, which includes the title,
// preconditions, priority and custom field values, not just the steps. Steps are stored
// with shared steps already expanded (phase 3) for the same reason - a shared step edited
// later must not rewrite the history of every case that included it.
const ManualTestCaseVersionSchema = mongoose.Schema({
  testCase: {
    type: Schema.Types.ObjectId,
    ref: 'ManualTestCase',
    required: true,
  },
  version: {
    type: Number,
    required: true,
  },
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: false,
  },
  preconditions: {
    type: String,
    required: false,
  },
  priority: {
    type: String,
    enum: testCasePriorities,
    required: false,
  },
  tags: [{
    type: String,
    required: false,
  }],
  steps: [{
    type: ManualStep,
    required: false,
  }],
  customFields: {
    type: Map,
    of: Schema.Types.Mixed,
    required: false,
  },
  fieldDefinitions: [{
    type: CustomFieldDefinitionSnapshot,
    required: false,
  }],
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
}, {
  // Only createdAt is meaningful - these documents are never updated.
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'manualtestcaseversions',
});

// Guarantees a case can never end up with two documents claiming the same version, which
// would make "which content was this execution run against?" ambiguous.
ManualTestCaseVersionSchema.index({ testCase: 1, version: 1 }, { unique: true });

module.exports = mongoose.model('ManualTestCaseVersion', ManualTestCaseVersionSchema);
