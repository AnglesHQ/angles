const debug = require('debug');
const FeatureSettings = require('../models/feature-settings.js');
const featureConfig = require('../../config/feature.config.js');

const log = debug('features:settings');

/**
 * Reduces a settings document to the plain object returned by the API. There are no
 * secrets here, but going through an explicit projection keeps mongoose internals
 * (_id, __v, timestamps) out of the payload.
 */
const toPublic = (settings) => ({
  manualTestingEnabled: settings.manualTestingEnabled !== false,
});

/**
 * Mirrors the persisted toggles onto the live in-memory featureConfig so request-time
 * consumers (the route guard) read current values without a database round trip per
 * request, and without a restart after an admin saves.
 */
const applyToRuntime = (settings) => {
  featureConfig.manualTestingEnabled = settings.manualTestingEnabled !== false;
};

/**
 * Loads the settings document, creating it on first run from the deployment-provided
 * seeds (see config/feature.config.js) so an instance can ship with a feature already
 * turned off.
 *
 * Seeding is create-if-missing, matching how the initial admin account is provisioned:
 * once the document exists it is authoritative and the environment is not consulted
 * again, so a restart never reverts a change an admin made in the UI.
 */
const loadDoc = async () => {
  const settings = await FeatureSettings.findOne({ singleton: 'features' });
  if (settings) return settings;

  log('Created feature settings document from environment seeds.');
  return FeatureSettings.create({
    singleton: 'features',
    manualTestingEnabled: featureConfig.seeds.manualTestingEnabled,
  });
};

/**
 * Loads settings and mirrors them onto the live featureConfig. Called at startup.
 */
const loadFeatureSettings = async () => {
  const settings = await loadDoc();
  applyToRuntime(settings);
  return settings;
};

/**
 * Returns the current toggles, seeding the document on first access.
 */
const getFeatureSettings = async () => {
  const settings = await loadDoc();
  return toPublic(settings);
};

/**
 * Persists the supplied toggles and mirrors them onto the live featureConfig. Only keys
 * present in the payload are changed, so a partial update leaves other features alone.
 */
const updateFeatureSettings = async (payload = {}) => {
  const settings = await loadDoc();

  if (payload.manualTestingEnabled !== undefined) {
    settings.manualTestingEnabled = payload.manualTestingEnabled;
  }

  await settings.save();
  applyToRuntime(settings);
  log('Feature settings updated.');
  return toPublic(settings);
};

module.exports = {
  loadFeatureSettings,
  getFeatureSettings,
  updateFeatureSettings,
  applyToRuntime,
  toPublic,
};
