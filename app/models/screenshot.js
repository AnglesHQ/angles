const mongoose = require('mongoose');

const { Schema } = mongoose;

const ScreenshotSchema = mongoose.Schema({
  build: { type: Schema.Types.ObjectId, ref: 'Build', required: true },
  execution: { type: Schema.Types.ObjectId, ref: 'TestExecution', required: true },
  thumbnail: { type: String, required: true },
  timestamp: { type: Date, required: true },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Screenshot', ScreenshotSchema);
