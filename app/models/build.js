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
});

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
});


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
});

module.exports = mongoose.model('Build', BuildSchema);
