const mongoose = require('mongoose');

const { Schema } = mongoose;

const Artefact = new Schema({
  artifactId: { type: String, required: false },
  groupId: { type: String, required: false },
  version: { type: String, required: false },
});

const BuildSchema = Schema({
  name: { type: String, required: false },
  result: { type: Map, of: Number, required: false },
  artifacts: [{ type: Artefact, required: false }],
  keep: { type: Boolean, required: false },
  environment: { type: Schema.Types.ObjectId, ref: 'Environment' },
  team: { type: Schema.Types.ObjectId, ref: 'Team' },
  executions: [{ type: Schema.Types.ObjectId, ref: 'TestExecution' }],
  component: { type: Schema.Types.ObjectId, ref: 'Component' },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Build', BuildSchema);
