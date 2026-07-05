const mongoose = require('mongoose');

const TokenSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true },
  name: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

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
    enum: ['admin', 'user', 'team_lead'],
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
  apiTokens: [TokenSchema],
}, {
  timestamps: true,
}, { collection: 'users' });

// Explicit unique index per convention (unique: true on field also creates one,
// but we declare it explicitly for clarity and to match project convention)
UserSchema.index({ username: 1 }, { unique: true });

module.exports = mongoose.model('User', UserSchema);

