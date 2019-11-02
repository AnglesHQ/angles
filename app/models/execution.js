const mongoose = require('mongoose');

const TestExecutionSchema = mongoose.Schema({
  title: String,
  content: String,
}, {
  timestamps: true,
});

module.exports = mongoose.model('TestExecution', TestExecutionSchema);
