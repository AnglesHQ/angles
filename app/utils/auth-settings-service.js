const debug = require('debug');
const AuthSettings = require('../models/auth-settings.js');
const authConfig = require('../../config/auth.config.js');

const log = debug('auth:settings');

// Secret paths, per provider type. These are `select: false` on the model and are
// write-only through the API: their values are never returned, only a boolean flag
// reporting whether one is set.
const SECRET_PATHS = {
  oidc: ['clientSecret'],
  saml: ['privateKey'],
  ldap: ['bindCredentials'],
};

// The mongoose `.select()` projection needed to read every provider secret back.
const SECRET_SELECT = Object.entries(SECRET_PATHS)
  .flatMap(([type, fields]) => fields.map((field) => `+providers.${type}.${field}`))
  .join(' ');

/**
 * The callback/ACS URL for a provider, derived from the configured public base URL.
 * Not stored: deriving it keeps it correct when the deployment moves, and it must match
 * what is registered with the IdP.
 */
const callbackUrlFor = (providerId) => `${authConfig.baseUrl}/rest/api/v1.0/auth/sso/${providerId}/callback`;

exports.callbackUrlFor = callbackUrlFor;

/**
 * Reduces one provider subdocument to its client-safe form: configuration minus every
 * secret value, plus a `<field>Set` boolean so the UI can show "configured" and prompt
 * appropriately without ever receiving the secret itself.
 */
const providerToPublic = (provider) => {
  const plain = typeof provider.toObject === 'function'
    ? provider.toObject()
    : { ...provider };

  const result = {
    id: plain.id,
    name: plain.name,
    type: plain.type,
    enabled: plain.enabled,
    roleMappings: (plain.roleMappings || []).map((mapping) => ({
      value: mapping.value,
      role: mapping.role,
    })),
    defaultRole: plain.defaultRole || '',
  };

  // Only the config block matching the provider's type is returned, so the payload
  // reflects what is actually in use rather than every unused default.
  const config = { ...(plain[plain.type] || {}) };
  (SECRET_PATHS[plain.type] || []).forEach((field) => {
    result[`${field}Set`] = Boolean(config[field]);
    delete config[field];
  });
  result[plain.type] = config;

  // SSO providers are browser redirect flows; LDAP is a credential post. The UI needs to
  // know which to render, so hand it the URL rather than have it rebuild the convention.
  if (plain.type === 'ldap') {
    result.loginUrl = `/rest/api/v1.0/auth/sso/${plain.id}/login`;
  } else {
    result.loginUrl = `/rest/api/v1.0/auth/sso/${plain.id}`;
    result.callbackUrl = callbackUrlFor(plain.id);
  }

  return result;
};

/**
 * Reduces a settings document to the plain, client-safe object returned by the API.
 */
const toPublic = (settings) => ({
  localAuthEnabled: settings.localAuthEnabled,
  providers: (settings.providers || []).map(providerToPublic),
});

/**
 * Mirrors the persisted settings onto the live in-memory authConfig so call-time
 * consumers (the strategy registry, the /auth/config endpoint) read current values
 * without a restart. Secrets are included here - this object stays in memory and is
 * never serialised to a client.
 */
const applyToRuntime = (settings) => {
  authConfig.localAuthEnabled = settings.localAuthEnabled !== false;
  authConfig.providers = (settings.providers || []).map((provider) => (
    typeof provider.toObject === 'function' ? provider.toObject() : provider
  ));
};

/**
 * Migrates a pre-multi-provider settings document in place.
 *
 * Releases up to 2.0.30 stored a single Okta configuration as flat `okta*` fields. Those
 * are folded into one `oidc` provider with id `okta` so existing deployments keep working
 * without an admin re-entering the configuration (including the client secret, which they
 * would have no way to recover from the UI). The legacy fields are then unset.
 *
 * @returns {boolean} whether anything was migrated
 */
const LEGACY_OKTA_FIELDS = [
  'oktaAuthEnabled', 'oktaDomain', 'oktaClientId', 'oktaClientSecret',
  'oktaIssuer', 'oktaAdminGroup', 'oktaTeamLeadGroup', 'oktaUserGroup',
];

const migrateLegacyOkta = (settings) => {
  // The legacy fields are no longer in the schema, so they must be read with
  // `strict: false` - a plain property access returns undefined for an off-schema path.
  const readLegacy = (field) => settings.get(field, null, { strict: false });
  const raw = LEGACY_OKTA_FIELDS.reduce((acc, field) => {
    acc[field] = readLegacy(field);
    return acc;
  }, {});

  const hasLegacy = raw.oktaIssuer || raw.oktaClientId || raw.oktaAuthEnabled !== undefined;
  if (!hasLegacy) return false;

  // Do not migrate on top of an already-migrated document.
  if ((settings.providers || []).some((provider) => provider.id === 'okta')) {
    return false;
  }

  const roleMappings = [
    { value: raw.oktaAdminGroup, role: 'admin' },
    { value: raw.oktaTeamLeadGroup, role: 'team_lead' },
    { value: raw.oktaUserGroup, role: 'user' },
  ].filter((mapping) => mapping.value);

  settings.providers.push({
    id: 'okta',
    name: 'Okta',
    type: 'oidc',
    enabled: Boolean(raw.oktaAuthEnabled),
    oidc: {
      issuer: raw.oktaIssuer || '',
      clientId: raw.oktaClientId || '',
      clientSecret: raw.oktaClientSecret || '',
      // The previous implementation always requested these scopes.
      scopes: 'openid profile email groups',
      groupsClaim: 'groups',
      usernameClaim: 'email',
    },
    roleMappings,
    defaultRole: '',
  });

  // $unset the legacy fields so the persisted document is left clean. Setting them to
  // undefined marks them for removal on save.
  LEGACY_OKTA_FIELDS.forEach((field) => {
    settings.set(field, undefined, { strict: false });
  });
  settings.markModified('providers');

  log('Migrated legacy Okta settings into the providers array.');
  return true;
};

/**
 * Loads the settings document (including the select:false secrets, needed to configure
 * the strategies), migrating a legacy Okta document on the way. On first run it creates a
 * bare document from the schema defaults (local auth on, no providers).
 */
const loadDoc = async () => {
  let settings = await AuthSettings.findOne({ singleton: 'auth' }).select(SECRET_SELECT);
  if (!settings) {
    settings = await AuthSettings.create({ singleton: 'auth' });
    log('Created default auth settings document.');
    return settings;
  }
  if (migrateLegacyOkta(settings)) {
    await settings.save();
    // Re-read so the saved document is clean and the secrets are selected consistently.
    settings = await AuthSettings.findOne({ singleton: 'auth' }).select(SECRET_SELECT);
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
 * Returns the current client-safe settings (no secret values), seeding on first access.
 */
const getAuthSettings = async () => {
  const settings = await loadDoc();
  return toPublic(settings);
};

/**
 * Merges an incoming provider payload onto the stored provider.
 *
 * Secrets are write-only in both directions: a secret is updated only when a non-empty
 * string is supplied, so saving the form with a blank secret field preserves the stored
 * value rather than wiping it. Config fields are merged rather than replaced so a partial
 * update does not reset unspecified fields to their schema defaults.
 */
const mergeProvider = (existing, payload) => {
  const target = existing || {};
  const type = payload.type || target.type;
  const merged = {
    id: payload.id !== undefined ? payload.id : target.id,
    name: payload.name !== undefined ? payload.name : target.name,
    type,
    enabled: payload.enabled !== undefined ? payload.enabled : (target.enabled || false),
    roleMappings: payload.roleMappings !== undefined
      ? payload.roleMappings
      : (target.roleMappings || []),
    defaultRole: payload.defaultRole !== undefined ? payload.defaultRole : (target.defaultRole || ''),
  };

  const existingConfig = (target[type] && typeof target[type].toObject === 'function')
    ? target[type].toObject()
    : { ...(target[type] || {}) };
  const incomingConfig = { ...(payload[type] || {}) };

  (SECRET_PATHS[type] || []).forEach((field) => {
    const supplied = incomingConfig[field];
    if (typeof supplied !== 'string' || supplied.length === 0) {
      // Not supplied (or blank): keep whatever is stored.
      delete incomingConfig[field];
    }
  });

  merged[type] = { ...existingConfig, ...incomingConfig };
  return merged;
};

/**
 * Persists the provided settings (upserting the singleton document), mirrors them onto
 * the live authConfig, and returns the client-safe result.
 *
 * `providers` is treated as the full desired set: providers absent from the payload are
 * removed. Each supplied provider is merged onto its stored counterpart by `id`.
 */
const updateAuthSettings = async (payload = {}) => {
  const settings = await loadDoc();

  if (payload.localAuthEnabled !== undefined) {
    settings.localAuthEnabled = payload.localAuthEnabled;
  }

  if (payload.providers !== undefined) {
    const existingById = new Map(
      (settings.providers || []).map((provider) => [provider.id, provider]),
    );
    settings.providers = payload.providers.map(
      (provider) => mergeProvider(existingById.get(provider.id), provider),
    );
  }

  await settings.save();
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
  providerToPublic,
  callbackUrlFor,
  SECRET_PATHS,
  SECRET_SELECT,
};
