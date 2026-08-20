const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const debug = require('debug');
const User = require('../models/user.js');
const authConfig = require('../../config/auth.config.js');
const oidcStrategy = require('./strategies/oidc-strategy.js');

const log = debug('auth:passport');

// Strategy builders by provider type. Adding a protocol means adding a module here that
// exports `build(provider)` - the registry, routes and settings API need no changes.
const BUILDERS = {
  oidc: oidcStrategy,
};

// Serialize user ID to session
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id).lean();
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

// Local Strategy
passport.use(new LocalStrategy({
  usernameField: 'username',
  passwordField: 'password',
}, async (username, password, done) => {
  try {
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) {
      return done(null, false, { message: 'Incorrect username or password.' });
    }
    if (user.authProvider !== 'local') {
      return done(null, false, { message: 'Use SSO to login.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (isMatch) {
      return done(null, user);
    }
    return done(null, false, { message: 'Incorrect username or password.' });
  } catch (err) {
    return done(err);
  }
}));

/**
 * Registered SSO strategies, keyed by the passport strategy name (`sso:<providerId>`).
 *
 * Configuration is asynchronous for some provider types (OIDC discovery performs a
 * network request), so a provider can be enabled in settings while its strategy is
 * momentarily unavailable - for example when discovery fails because the IdP is
 * unreachable. The routes consult this registry rather than the settings, so they never
 * invoke an unregistered strategy.
 *
 * @type {Map<string, {provider: Object, error: string|null}>}
 */
const registry = new Map();

const strategyName = (providerId) => `sso:${providerId}`;

/**
 * Removes a provider's strategy from passport and the registry.
 */
const unregister = (providerId) => {
  registry.delete(providerId);
  try {
    passport.unuse(strategyName(providerId));
  } catch (err) {
    // Strategy was not registered; nothing to remove.
  }
};

/**
 * (Re)builds every enabled provider's strategy from the current authConfig.
 *
 * Safe to call at startup and again whenever an admin updates the auth settings, so
 * changes take effect without a restart. Providers are rebuilt wholesale rather than
 * diffed: the set is small, and rebuilding avoids stale clients after a config edit.
 *
 * A provider that fails to build is left unregistered with its error recorded, so the
 * admin UI can surface why, and one broken provider never prevents the others from
 * working.
 *
 * @returns {Promise<Array<{id: string, ok: boolean, error: string|null}>>}
 */
const configureProviders = async () => {
  const providers = authConfig.providers || [];

  // Drop strategies for providers that have been deleted or disabled.
  [...registry.keys()]
    .filter((id) => !providers.some((provider) => provider.id === id && provider.enabled))
    .forEach(unregister);

  const results = await Promise.all(providers.map(async (provider) => {
    if (!provider.enabled) {
      unregister(provider.id);
      return { id: provider.id, ok: false, error: null };
    }

    const builder = BUILDERS[provider.type];
    if (!builder) {
      unregister(provider.id);
      const error = `Unsupported provider type: ${provider.type}`;
      log(error);
      return { id: provider.id, ok: false, error };
    }

    try {
      const strategy = await builder.build(provider);
      passport.use(strategyName(provider.id), strategy);
      registry.set(provider.id, { provider, error: null });
      log('Configured %s strategy for provider %s', provider.type, provider.id);
      return { id: provider.id, ok: true, error: null };
    } catch (err) {
      unregister(provider.id);
      log('Failed to configure provider %s: %s', provider.id, err.message);
      return { id: provider.id, ok: false, error: err.message };
    }
  }));

  return results;
};

/**
 * @returns {boolean} whether the provider's strategy is registered and usable
 */
const isProviderReady = (providerId) => registry.has(providerId);

/**
 * @returns {Object|null} the configured provider backing a registered strategy
 */
const getReadyProvider = (providerId) => {
  const entry = registry.get(providerId);
  return entry ? entry.provider : null;
};

/**
 * The enabled providers, as the login page needs them: no secrets, no configuration -
 * just what is required to render and start a login.
 */
const listEnabledProviders = () => (authConfig.providers || [])
  .filter((provider) => provider.enabled)
  .map((provider) => ({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    ready: registry.has(provider.id),
    loginUrl: provider.type === 'ldap'
      ? `/rest/api/v1.0/auth/sso/${provider.id}/login`
      : `/rest/api/v1.0/auth/sso/${provider.id}`,
  }));

module.exports = {
  passport,
  configureProviders,
  isProviderReady,
  getReadyProvider,
  listEnabledProviders,
  strategyName,
  BUILDERS,
};
