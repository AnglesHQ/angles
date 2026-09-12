const mongoose = require('mongoose');

const { Schema } = mongoose;

// What the attachment hangs off. `execution` is accepted now so the upload path does not
// need reworking when manual runs land; nothing writes it yet.
const attachmentScopes = ['testcase', 'sharedstep', 'execution'];

// An image a QA attached to a manual test step, referenced from a step's expected result
// as `![alt](attachment:<id>)` and resolved by the UI to /attachment/:id/file.
//
// Deliberately separate from Screenshot: that model requires a build and carries phash,
// platformId, view and baseline-comparison semantics that an authoring attachment has no
// use for. Loosening Screenshot.build to optional would weaken an invariant every
// screenshot query and the whole image-engine depends on.
//
// An attachment referenced by a frozen ManualTestCaseVersion is never hard-deleted - a
// historical execution has to render the image the tester actually saw.
const AttachmentSchema = mongoose.Schema({
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  scope: {
    type: String,
    enum: attachmentScopes,
    required: true,
  },
  // Whichever of these matches `scope`. Left unset otherwise.
  testCase: {
    type: Schema.Types.ObjectId,
    ref: 'ManualTestCase',
    required: false,
  },
  sharedStep: {
    type: Schema.Types.ObjectId,
    ref: 'SharedStep',
    required: false,
  },
  manualExecution: {
    type: Schema.Types.ObjectId,
    ref: 'TestExecution',
    required: false,
  },
  // Server-generated. The client's filename is never used to build a path.
  filename: {
    type: String,
    required: true,
  },
  // Kept for display only, stripped of any path component.
  originalName: {
    type: String,
    required: false,
  },
  mimeType: {
    type: String,
    required: false,
  },
  size: {
    type: Number,
    required: false,
  },
  path: {
    type: String,
    required: true,
  },
  // Path to the generated .thumb.png, served by /attachment/:id/thumbnail. Absent when
  // the image could not be thumbnailed - the original is still usable.
  thumbnail: {
    type: String,
    required: false,
  },
  width: {
    type: Number,
    required: false,
  },
  height: {
    type: Number,
    required: false,
  },
  uploadedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
}, {
  timestamps: true,
  collection: 'attachments',
});

AttachmentSchema.index({ team: 1 }, { unique: false });
AttachmentSchema.index({ testCase: 1 }, { unique: false });
AttachmentSchema.index({ sharedStep: 1 }, { unique: false });
AttachmentSchema.index({ manualExecution: 1 }, { unique: false });

module.exports = mongoose.model('Attachment', AttachmentSchema);
module.exports.attachmentScopes = attachmentScopes;
