// In-memory mirror of the feature toggles held in the database. These are only the
// defaults used before the persisted settings load at startup; the feature-settings
// service loads the database document and mutates this object in place, and again on
// every admin save, so route guards can read a toggle synchronously.
//
// Toggles are managed through the admin UI and stored in the database. The environment
// variables below are *seeds*, not overrides: they choose the value written when the
// settings document is first created, so a deployment can ship with a feature already
// off. Once the document exists the database is authoritative and the env var is
// ignored - otherwise a restart would silently revert an admin's choice.
//
// Anything other than the string 'false' leaves a feature enabled, so an unset, empty or
// misspelled value behaves exactly as the instance did before the toggle existed.
const seedEnabled = (value) => value !== 'false';

module.exports = {
  manualTestingEnabled: true,
  // The seed values, read once at startup and applied only on first run.
  seeds: {
    manualTestingEnabled: seedEnabled(process.env.ANGLES_MANUAL_TESTING_ENABLED),
  },
};
