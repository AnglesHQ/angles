const debug = require('debug');
const User = require('../models/user.js');
const { resolveRole } = require('./role-mapper.js');

const log = debug('auth:provisioning');

/**
 * Finds or provisions the Angles user behind an SSO login, and keeps their role in step
 * with the identity provider. Shared by every SSO provider type (OIDC, SAML, LDAP) so
 * provisioning behaviour cannot drift between them.
 *
 * Role syncing only applies to users whose `authProvider` matches the provider that
 * authenticated them. That guard matters: without it, a login through one provider could
 * overwrite the role of a local admin (or a user from a different provider) who happens
 * to share a username, which would be a privilege-escalation path from any IdP an admin
 * has configured.
 *
 * @param {Object} params
 * @param {string} params.username - identifier from the provider (lower-cased by caller)
 * @param {*} params.groups - raw group values from the provider
 * @param {Object} params.provider - the configured provider document
 * @returns {Promise<{user: Object|null, message?: string}>} the user, or a denial message
 */
exports.findOrProvisionUser = async ({ username, groups, provider }) => {
  if (!username) {
    return { user: null, message: `Unable to determine a username from the ${provider.name} profile.` };
  }

  const normalised = String(username).toLowerCase().trim();
  const role = resolveRole(groups, provider.roleMappings, provider.defaultRole);

  if (!role) {
    log('User %s denied access: no matching role mapping for provider %s', normalised, provider.id);
    return { user: null, message: 'You do not have permission to access this application.' };
  }

  const providerKey = provider.id;
  let user = await User.findOne({ username: normalised });

  if (!user) {
    user = new User({
      username: normalised,
      authProvider: providerKey,
      role,
      teams: [],
    });
    await user.save();
    log('Provisioned new %s user: %s with role: %s', provider.type, normalised, role);
    return { user };
  }

  // A username already held by a local account (or another provider) is not taken over -
  // see the note above on privilege escalation.
  if (user.authProvider !== providerKey) {
    log('User %s exists with authProvider %s; refusing %s login', normalised, user.authProvider, providerKey);
    return {
      user: null,
      message: 'An account with this username already exists using a different sign-in method.',
    };
  }

  if (user.role !== role) {
    user.role = role;
    await user.save();
    log('Updated role for %s user: %s to: %s', provider.type, normalised, role);
  }

  return { user };
};
