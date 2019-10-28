const mongoose = require('mongoose');

const ExecutionSchema = mongoose.Schema({
  title: String,
  content: String,
}, {
  timestamps: true,
});

module.exports = mongoose.model('Execution', ExecutionSchema);
