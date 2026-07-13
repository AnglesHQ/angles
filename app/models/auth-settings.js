const mongoose = require('mongoose');

// Single-document collection holding runtime-configurable authentication settings.
// The `singleton` field is fixed to 'auth' with a unique index so only one document
// can ever exist.
//
// The Okta client secret is stored here so it can be managed entirely from the admin UI,
// but it is write-only: the settings API never returns its value (only a boolean flag
// indicating whether one is set), and the model's `select: false` keeps it out of query
// results unless explicitly requested.
const AuthSettingsSchema = mongoose.Schema({
  singleton: {
    type: String,
    default: 'auth',
    unique: true,
    enum: ['auth'],
  },
  localAuthEnabled: { type: Boolean, default: true },
  oktaAuthEnabled: { type: Boolean, default: false },
  oktaDomain: { type: String, default: '' },
  oktaClientId: { type: String, default: '' },
  oktaClientSecret: { type: String, default: '', select: false },
  oktaIssuer: { type: String, default: '' },
  oktaAdminGroup: { type: String, default: '' },
  oktaTeamLeadGroup: { type: String, default: '' },
  oktaUserGroup: { type: String, default: '' },
}, {
  timestamps: true,
}, { collection: 'authSettings' });

module.exports = mongoose.model('AuthSettings', AuthSettingsSchema);
