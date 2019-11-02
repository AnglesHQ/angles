const mongoose = require('mongoose');

const { Schema } = mongoose;

const Result = new Schema({
  errorTests: { type: Number, required: false },
  failedTests: { type: Number, required: false },
  passedTests: { type: Number, required: false },
  skippedTests: { type: Number, required: false },
  totalTests: { type: Number, required: false },
});

const Artefact = new Schema({
  artifactId: { type: String, required: false },
  groupId: { type: String, required: false },
  version: { type: String, required: false },
});

const BuildSchema = Schema({
  name: { type: String, required: false },
  result: { type: Result, required: false },
  artifacts: [{ type: Artefact, required: false }],
  keep: { type: Boolean, required: false },
  environment: { type: Schema.Types.ObjectId, ref: 'Environment' },
  team: { type: Schema.Types.ObjectId, ref: 'Team' },
  tests: [{ type: Schema.Types.ObjectId, ref: 'TestExecution' }],
}, {
  timestamps: true,
});

module.exports = mongoose.model('Build', BuildSchema);
