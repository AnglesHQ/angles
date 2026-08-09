const debug = require('debug');
const AuthSettings = require('../models/auth-settings.js');
const authConfig = require('../../config/auth.config.js');

const log = debug('auth:settings');

// Non-secret fields that are safe to return to the admin UI. The Okta client secret is
// deliberately excluded - it is write-only (see toPublic / updateAuthSettings below).
const PUBLIC_FIELDS = [
  'localAuthEnabled',
  'oktaAuthEnabled',
  'oktaDomain',
  'oktaClientId',
  'oktaIssuer',
  'oktaAdminGroup',
  'oktaTeamLeadGroup',
  'oktaUserGroup',
];

/**
 * Reduces a settings document to the plain, client-safe object returned by the API. The
 * client secret value is never included; instead a boolean flag reports whether one is
 * configured so the UI can prompt appropriately.
 */
const toPublic = (settings) => {
  const result = PUBLIC_FIELDS.reduce((acc, field) => {
    acc[field] = settings[field];
    return acc;
  }, {});
  result.oktaClientSecretSet = Boolean(settings.oktaClientSecret);
  return result;
};

/**
 * Mirrors the persisted settings onto the live in-memory authConfig object so that
 * call-time consumers (role-mapper, the /auth/config endpoint) and strategy
 * (re)configuration read the current values without a restart.
 */
const applyToRuntime = (settings) => {
  authConfig.localAuthEnabled = settings.localAuthEnabled;
  authConfig.oktaAuthEnabled = settings.oktaAuthEnabled;
  authConfig.authType = settings.oktaAuthEnabled ? 'okta' : 'local';
  authConfig.okta.domain = settings.oktaDomain || '';
  authConfig.okta.issuer = settings.oktaIssuer || '';
  authConfig.okta.clientID = settings.oktaClientId || '';
  authConfig.okta.clientSecret = settings.oktaClientSecret || '';
  authConfig.okta.adminGroup = settings.oktaAdminGroup || '';
  authConfig.okta.teamLeadGroup = settings.oktaTeamLeadGroup || '';
  authConfig.okta.userGroup = settings.oktaUserGroup || '';
};

/**
 * Loads the settings document (including the select:false client secret, needed to
 * configure the strategy). On first run it creates a bare document from the schema
 * defaults (local auth on, Okta off/unconfigured); all authentication configuration is
 * managed exclusively through the admin UI, never from environment variables.
 * @returns {Promise<Object>} the settings document, with oktaClientSecret populated
 */
const loadDoc = async () => {
  let settings = await AuthSettings.findOne({ singleton: 'auth' }).select('+oktaClientSecret');
  if (!settings) {
    settings = await AuthSettings.create({ singleton: 'auth' });
    log('Created default auth settings document.');
  }
  return settings;
};

/**
 * Loads settings and mirrors them onto the live authConfig. Called at startup.
 */
const loadAuthSettings = async () => {
  const settings = await loadDoc();
  applyToRuntime(settings);
  return settings;
};

/**
 * Returns the current client-safe settings (no secret value), seeding on first access.
 */
const getAuthSettings = async () => {
  const settings = await loadDoc();
  return toPublic(settings);
};

/**
 * Persists the provided settings (upserting the singleton document), mirrors them onto
 * the live authConfig, and returns the client-safe result. Only known fields are
 * accepted. The client secret is write-only: it is updated only when a non-empty string
 * is supplied, so saving the form with a blank secret field preserves the existing value.
 */
const updateAuthSettings = async (payload = {}) => {
  const update = PUBLIC_FIELDS.reduce((acc, field) => {
    if (payload[field] !== undefined) {
      acc[field] = payload[field];
    }
    return acc;
  }, {});

  if (typeof payload.oktaClientSecret === 'string' && payload.oktaClientSecret.length > 0) {
    update.oktaClientSecret = payload.oktaClientSecret;
  }

  const settings = await AuthSettings.findOneAndUpdate(
    { singleton: 'auth' },
    { $set: update, $setOnInsert: { singleton: 'auth' } },
    {
      new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true,
    },
  ).select('+oktaClientSecret');

  applyToRuntime(settings);
  log('Auth settings updated.');
  return toPublic(settings);
};

module.exports = {
  loadAuthSettings,
  getAuthSettings,
  updateAuthSettings,
  applyToRuntime,
  toPublic,
  PUBLIC_FIELDS,
};
