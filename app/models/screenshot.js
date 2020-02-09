const mongoose = require('mongoose');

const { Schema } = mongoose;

const ScreenshotSchema = mongoose.Schema({
  build: {
    type: Schema.Types.ObjectId,
    ref: 'Build',
    required: true,
  },
  thumbnail: {
    type: String,
    required: true,
  },
  timestamp: {
    type: Date,
    required: true,
  },
  path: {
    type: String,
    required: true,
  },
  view: {
    type: String,
    required: false,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Screenshot', ScreenshotSchema);
