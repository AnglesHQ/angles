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
    required: false, // Optional because SSO users have no password stored locally
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
  // 'local' for password accounts, otherwise the id of the configured SSO provider that
  // authenticated the user. Not an enum: provider ids are created at runtime by an admin,
  // so the valid set is not known at schema-definition time.
  authProvider: {
    type: String,
    default: 'local',
    trim: true,
  },
  apiTokens: [TokenSchema],
}, {
  timestamps: true,
}, { collection: 'users' });

// Explicit unique index per convention (unique: true on field also creates one,
// but we declare it explicitly for clarity and to match project convention)
UserSchema.index({ username: 1 }, { unique: true });

// Every API-token-authenticated request looks a user up by token hash (see
// auth-middleware.isAuthenticated). Without this multikey index that lookup is a full
// collection scan on the hottest authentication path.
UserSchema.index({ 'apiTokens.tokenHash': 1 });

module.exports = mongoose.model('User', UserSchema);
