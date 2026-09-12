const mongoose = require('mongoose');

const { Schema } = mongoose;
const executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];
const executionTypes = ['automated', 'manual'];

const Artifact = new Schema({
  groupId: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  artifactId: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  version: {
    type: String,
    required: true,
    trim: true,
  },
}, { _id: false });

const Suite = mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  result: {
    type: Map,
    of: Number,
    required: true,
  },
  status: {
    type: String,
    enum: executionStates,
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
  executions: [{ type: Schema.Types.ObjectId, ref: 'TestExecution' }],
}, { _id: false });

const BuildSchema = Schema({
  name: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
  result: {
    type: Map,
    of: Number,
    required: false,
  },
  status: {
    type: String,
    enum: executionStates,
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
  artifacts: [{
    type: Artifact,
    required: false,
  }],
  keep: {
    type: Boolean,
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
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  component: {
    type: Schema.Types.ObjectId,
    ref: 'Component',
    required: true,
  },
  suites: [{
    type: Suite,
    required: true,
  }],
  // Whether this build's results came from an automated run or a manual test run.
  // Defaults to 'automated' so every existing document reads back correctly with no
  // migration; scripts/backfill-execution-type.js sets it explicitly so the index below
  // is dense.
  executionType: {
    type: String,
    enum: executionTypes,
    default: 'automated',
    required: true,
  },
}, {
  timestamps: true,
  collection: 'builds',
});

BuildSchema.index({ team: 1 }, { unique: false });
BuildSchema.index({ team: 1, createdAt: -1 }, { unique: false });
BuildSchema.index({ team: 1, start: -1 }, { unique: false });
// Backs the dashboard's automated/manual filter without falling back to the broader
// { team: 1, start: -1 } index and discarding most of what it reads.
BuildSchema.index({ team: 1, executionType: 1, start: -1 }, { unique: false });

module.exports = mongoose.model('Build', BuildSchema);
module.exports.executionTypes = executionTypes;
