const mongoose = require('mongoose');
const { ManualStep } = require('./manual-test-case.js');

const { Schema } = mongoose;

// A re-usable sequence of steps that many manual test cases can include - a login
// sequence, a checkout flow, a teardown.
//
// A test case includes a shared step by reference on its mutable head, but never in a
// frozen version: versions store the expanded steps instead. That is what stops an edit
// here rewriting the history of every case that includes it. Editing a shared step
// instead cascades forward, writing a fresh version for each referencing case (see
// shared-step-utils.cascadeToTestCases).
const SharedStepSchema = mongoose.Schema({
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 150,
  },
  description: {
    type: String,
    required: false,
  },
  // Nested shared steps are rejected at the controller: a shared step's steps are always
  // literal, so expansion is a single pass with no cycle risk.
  steps: [{
    type: ManualStep,
    required: false,
  }],
  // Incremented whenever the steps change. Recorded on every expanded step so a frozen
  // version can show which revision of the shared step the tester saw.
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
  collection: 'sharedsteps',
});

SharedStepSchema.index({ team: 1, name: 1 }, { unique: true });
SharedStepSchema.index({ team: 1, updatedAt: -1 }, { unique: false });

module.exports = mongoose.model('SharedStep', SharedStepSchema);
