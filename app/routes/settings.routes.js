const { check, body } = require('express-validator');
const settings = require('../controllers/settings.controller.js');
const authMiddleware = require('../utils/auth-middleware.js');

const PROVIDER_TYPES = ['oidc', 'saml', 'ldap'];
const ROLES = ['admin', 'team_lead', 'user'];
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

// Per-type configuration validators. Only the block matching a provider's `type` is
// checked, so an unused block cannot fail the request.
const CONFIG_RULES = {
  oidc: {
    issuer: { type: 'string', max: 255 },
    clientId: { type: 'string', max: 255 },
    clientSecret: { type: 'string', max: 500 },
    scopes: { type: 'string', max: 255 },
    groupsClaim: { type: 'string', max: 255 },
    usernameClaim: { type: 'string', max: 255 },
  },
  saml: {
    entryPoint: { type: 'string', max: 2048 },
    idpCert: { type: 'string', max: 20000 },
    issuer: { type: 'string', max: 255 },
    privateKey: { type: 'string', max: 20000 },
    signatureAlgorithm: { type: 'enum', values: ['sha256', 'sha512'] },
    identifierFormat: { type: 'string', max: 255 },
    groupsAttribute: { type: 'string', max: 255 },
    usernameAttribute: { type: 'string', max: 255 },
    allowUnsolicited: { type: 'boolean' },
    wantAuthnResponseSigned: { type: 'boolean' },
  },
  ldap: {
    url: { type: 'string', max: 2048 },
    bindDN: { type: 'string', max: 512 },
    bindCredentials: { type: 'string', max: 500 },
    searchBase: { type: 'string', max: 512 },
    searchFilter: { type: 'string', max: 512 },
    groupSearchBase: { type: 'string', max: 512 },
    groupSearchFilter: { type: 'string', max: 512 },
    groupNameAttribute: { type: 'string', max: 255 },
    usernameAttribute: { type: 'string', max: 255 },
    tlsRejectUnauthorized: { type: 'boolean' },
    startTLS: { type: 'boolean' },
  },
};

/**
 * Validates one provider's config block against the rules for its type. Unknown keys are
 * rejected rather than ignored, so a typo in the admin UI surfaces as a 422 instead of
 * silently leaving the setting at its default.
 */
const validateConfig = (provider, index) => {
  const rules = CONFIG_RULES[provider.type];
  const config = provider[provider.type];

  if (config === undefined) return;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`providers[${index}].${provider.type} must be an object.`);
  }

  Object.entries(config).forEach(([key, value]) => {
    const rule = rules[key];
    if (!rule) {
      throw new Error(`providers[${index}].${provider.type}.${key} is not a recognised setting.`);
    }
    if (value === null || value === undefined) return;

    if (rule.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`providers[${index}].${provider.type}.${key} must be a boolean.`);
    }
    if (rule.type === 'enum' && !rule.values.includes(value)) {
      throw new Error(`providers[${index}].${provider.type}.${key} must be one of: ${rule.values.join(', ')}.`);
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string') {
        throw new Error(`providers[${index}].${provider.type}.${key} must be a string.`);
      }
      if (value.length > rule.max) {
        throw new Error(`providers[${index}].${provider.type}.${key} must be at most ${rule.max} characters.`);
      }
    }
  });
};

/**
 * Validates the whole providers array. Throwing inside a custom validator is how
 * express-validator surfaces the message, so each failure returns a specific reason
 * rather than a generic "invalid providers".
 */
const validateProviders = (providers) => {
  if (!Array.isArray(providers)) {
    throw new Error('providers must be an array.');
  }
  if (providers.length > 20) {
    throw new Error('At most 20 providers can be configured.');
  }

  const seen = new Set();

  providers.forEach((provider, index) => {
    if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
      throw new Error(`providers[${index}] must be an object.`);
    }
    if (typeof provider.id !== 'string' || !PROVIDER_ID_PATTERN.test(provider.id)) {
      throw new Error(`providers[${index}].id must be 2-32 lowercase alphanumeric or hyphen characters.`);
    }
    // The id is part of the login URL and the IdP-registered callback URL, so a duplicate
    // would make one provider silently shadow the other.
    if (seen.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}.`);
    }
    seen.add(provider.id);

    if (typeof provider.name !== 'string' || provider.name.trim().length === 0
      || provider.name.length > 100) {
      throw new Error(`providers[${index}].name is required and must be at most 100 characters.`);
    }
    if (!PROVIDER_TYPES.includes(provider.type)) {
      throw new Error(`providers[${index}].type must be one of: ${PROVIDER_TYPES.join(', ')}.`);
    }
    if (provider.enabled !== undefined && typeof provider.enabled !== 'boolean') {
      throw new Error(`providers[${index}].enabled must be a boolean.`);
    }
    if (provider.defaultRole !== undefined && provider.defaultRole !== ''
      && !ROLES.includes(provider.defaultRole)) {
      throw new Error(`providers[${index}].defaultRole must be empty or one of: ${ROLES.join(', ')}.`);
    }

    if (provider.roleMappings !== undefined) {
      if (!Array.isArray(provider.roleMappings)) {
        throw new Error(`providers[${index}].roleMappings must be an array.`);
      }
      if (provider.roleMappings.length > 100) {
        throw new Error(`providers[${index}].roleMappings may contain at most 100 entries.`);
      }
      provider.roleMappings.forEach((mapping, mappingIndex) => {
        if (typeof mapping !== 'object' || mapping === null) {
          throw new Error(`providers[${index}].roleMappings[${mappingIndex}] must be an object.`);
        }
        if (typeof mapping.value !== 'string' || mapping.value.trim().length === 0
          || mapping.value.length > 255) {
          throw new Error(`providers[${index}].roleMappings[${mappingIndex}].value is required and must be at most 255 characters.`);
        }
        if (!ROLES.includes(mapping.role)) {
          throw new Error(`providers[${index}].roleMappings[${mappingIndex}].role must be one of: ${ROLES.join(', ')}.`);
        }
      });
    }

    validateConfig(provider, index);
  });

  return true;
};

module.exports = (app, path) => {
  // Settings are admin-only and cannot be managed with an API token.
  app.use(`${path}/settings`, authMiddleware.preventTokenAuth);

  app.get(
    `${path}/settings/auth`,
    authMiddleware.isAuthenticated,
    authMiddleware.authorizeAdmin,
    settings.getAuthSettings,
  );

  app.put(`${path}/settings/auth`, [
    check('localAuthEnabled').optional().isBoolean().withMessage('localAuthEnabled must be a boolean.'),
    body('providers').optional().custom(validateProviders),
  ], authMiddleware.isAuthenticated, authMiddleware.authorizeAdmin, settings.updateAuthSettings);
};

module.exports.validateProviders = validateProviders;
