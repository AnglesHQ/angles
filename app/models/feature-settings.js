const mongoose = require('mongoose');

// Single-document collection holding runtime-configurable feature toggles, kept separate
// from the auth settings singleton so the two concerns can be read, written and validated
// independently (auth settings carry provider secrets; these do not).
//
// A toggle defaults to on: enabling a feature that already shipped must not require an
// admin to act, and an instance upgrading to this version keeps the behaviour it had.
const FeatureSettingsSchema = mongoose.Schema({
  singleton: {
    type: String,
    default: 'features',
    unique: true,
    enum: ['features'],
  },
  // Manual test case management: the test cases, folders, shared steps and test runs.
  // They are one feature - a run is a run *of* cases - so they are gated together.
  manualTestingEnabled: { type: Boolean, default: true },
}, {
  timestamps: true,
}, { collection: 'featureSettings' });

module.exports = mongoose.model('FeatureSettings', FeatureSettingsSchema);
