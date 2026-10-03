const mongoose = require('mongoose');

const { Schema } = mongoose;

// What the attachment hangs off. `execution` is accepted now so the upload path does not
// need reworking when manual runs land; nothing writes it yet. `build` is a file an
// automated test uploaded while it ran (see below).
const attachmentScopes = ['testcase', 'sharedstep', 'execution', 'build'];

// What a build-scoped attachment holds, decided server-side from the file extension (see
// test-attachment-utils). The UI picks a viewer from this, never from the client's mime type.
const attachmentKinds = ['image', 'log', 'json', 'har', 'video', 'trace', 'archive', 'html'];

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
//
// Automated tests upload attachments too (logs, HAR files, videos, traces, HTML
// snapshots). Those are scoped to the build, because the execution does not exist yet
// while the test runs - the same reason screenshots hang off the build. The test then
// lists the returned ids on the execution (or one of its steps) when it saves it, and
// `execution` is filled in at that point.
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
  // Build scope only: the build the file was uploaded against, and the execution that
  // referenced it once that execution was saved. `execution` stays unset for a file no
  // execution has claimed (yet).
  build: {
    type: Schema.Types.ObjectId,
    ref: 'Build',
    required: false,
  },
  execution: {
    type: Schema.Types.ObjectId,
    ref: 'TestExecution',
    required: false,
  },
  kind: {
    type: String,
    enum: attachmentKinds,
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
AttachmentSchema.index({ build: 1 }, { unique: false });
AttachmentSchema.index({ execution: 1 }, { unique: false });

module.exports = mongoose.model('Attachment', AttachmentSchema);
module.exports.attachmentScopes = attachmentScopes;
module.exports.attachmentKinds = attachmentKinds;
