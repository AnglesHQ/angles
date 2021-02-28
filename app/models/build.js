const mongoose = require('mongoose');

const { Schema } = mongoose;
const executionStates = ['SKIPPED', 'PASS', 'ERROR', 'FAIL'];

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
    required: true,
  },
  end: {
    type: Date,
    required: true,
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
}, {
  timestamps: true,
}, { collection: 'builds' });

BuildSchema.index({ team: 1 }, { unique: false });

module.exports = mongoose.model('Build', BuildSchema);
