const mongoose = require('mongoose');

const { Schema } = mongoose;

const entityTypes = ['testcase', 'sharedstep', 'customfield'];
const historyActions = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'CLONE',
  'STATUS_CHANGE',
  'SHARED_STEP_UPDATE',
  'ARCHIVE',
];

// One field-level change. `from` and `to` are Mixed because a custom field value can be a
// string, number, boolean, date or array, and a steps change carries an array of objects.
const Change = new Schema({
  field: {
    type: String,
    required: true,
  },
  from: {
    type: Schema.Types.Mixed,
    required: false,
  },
  to: {
    type: Schema.Types.Mixed,
    required: false,
  },
}, { _id: false });

// An audit record of one mutation to a test case, shared step or custom field definition.
//
// This is a *log*, distinct from ManualTestCaseVersion: a version is the content a tester
// saw and is what an execution binds to, while a history entry says who changed what and
// why. A status change writes history without burning a version, and a shared step edit
// writes an entry against every case it cascaded into - neither of which the version
// collection alone can express.
//
// Entries are only ever inserted. Nothing updates or deletes them, and they are not
// auto-pruned; if volume becomes a problem the cleanup/ scripts get a follow-up task.
const ManualChangeHistorySchema = mongoose.Schema({
  entityType: {
    type: String,
    enum: entityTypes,
    required: true,
  },
  entityId: {
    type: Schema.Types.ObjectId,
    required: true,
  },
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  action: {
    type: String,
    enum: historyActions,
    required: true,
  },
  // The version the entity ended up on. Absent for entities that are not versioned
  // (custom field definitions), and unchanged from the previous entry for an action that
  // deliberately does not burn a version, such as a status change.
  version: {
    type: Number,
    required: false,
  },
  changes: [{
    type: Change,
    required: false,
  }],
  // Who made the change. Not required: a change can originate from a process without a
  // session, and losing the whole audit entry because the actor is unknown would be worse
  // than recording it without one.
  changedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  changedAt: {
    type: Date,
    default: Date.now,
    required: true,
  },
  // Free-text reason supplied by the author, or a generated one explaining a cascade.
  comment: {
    type: String,
    required: false,
  },
  // Set on a SHARED_STEP_UPDATE entry: the shared step whose edit caused this test case
  // to be versioned, so the history can say why a case changed when nobody edited it.
  causedBy: {
    type: Schema.Types.ObjectId,
    ref: 'SharedStep',
    required: false,
  },
}, {
  // Only createdAt would be meaningful and `changedAt` already carries it.
  timestamps: false,
  collection: 'manualchangehistory',
});

ManualChangeHistorySchema.index({ entityId: 1, changedAt: -1 }, { unique: false });
ManualChangeHistorySchema.index({ team: 1, changedAt: -1 }, { unique: false });

module.exports = mongoose.model('ManualChangeHistory', ManualChangeHistorySchema);
module.exports.entityTypes = entityTypes;
module.exports.historyActions = historyActions;
