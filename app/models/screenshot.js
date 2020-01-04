const mongoose = require('mongoose');

const { Schema } = mongoose;

const ScreenshotSchema = mongoose.Schema({
  build: { type: Schema.Types.ObjectId, ref: 'Build', required: true },
  thumbnail: { type: String, required: false },
  timestamp: { type: Date, required: false },
  path: { type: String, required: true },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Screenshot', ScreenshotSchema);
