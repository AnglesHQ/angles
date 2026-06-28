const mongoose = require('mongoose');

const UserSchema = mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: false, // Optional because Okta users don't have passwords stored locally
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user',
  },
  teams: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
  }],
  authProvider: {
    type: String,
    enum: ['local', 'okta'],
    default: 'local',
  },
}, {
  timestamps: true,
}, { collection: 'users' });

// We could add an index, but unique: true already creates one
module.exports = mongoose.model('User', UserSchema);
