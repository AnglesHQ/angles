const LdapStrategy = require('passport-ldapauth').Strategy;
const debug = require('debug');
const { findOrProvisionUser } = require('../provider-user-service.js');

const log = debug('auth:ldap');

// Attributes that commonly hold group membership on the user entry itself. Active
// Directory populates memberOf; some directories use a differently-cased variant.
const MEMBER_OF_ATTRIBUTES = ['memberOf', 'memberof', 'isMemberOf'];

/**
 * Extracts the group name from a distinguished name.
 *
 * `memberOf` yields full DNs (CN=Angles Admins,OU=Groups,DC=example,DC=com), but admins
 * configure role mappings using the group's name. The leading RDN value is taken when
 * the value looks like a DN, and the value is passed through unchanged otherwise - some
 * directories already return bare names.
 */
const groupNameFromDn = (value) => {
  const dn = String(value || '').trim();
  // Match up to the first *unescaped* comma. A group name may legitimately contain a
  // comma (`CN=Admins\, Global,OU=...`), and stopping at the escaped one would truncate
  // the name and silently fail to match its role mapping.
  const match = dn.match(/^[A-Za-z]+=((?:\\.|[^,\\])*)/);
  if (!match) return dn;
  // Unescape the DN escaping rules that matter for a display name.
  return match[1].replace(/\\([,+"\\<>;=])/g, '$1').trim();
};

/**
 * Collects the group values for a directory entry, from whichever source is populated.
 *
 * Two shapes are supported: `_groups`, which ldapauth-fork populates when a group search
 * is configured, and the entry's own memberOf attribute, which is how Active Directory
 * usually exposes membership without a second search.
 */
const extractGroups = (user, config) => {
  const nameAttribute = config.groupNameAttribute || 'cn';

  // `_groups` is ldapauth-fork's own field name for the group search results.
  // eslint-disable-next-line no-underscore-dangle
  const searched = user._groups;
  if (Array.isArray(searched) && searched.length > 0) {
    return searched
      .map((group) => group[nameAttribute] || group.cn || group.name)
      .filter(Boolean)
      .map((value) => (Array.isArray(value) ? value[0] : value));
  }

  const memberOfKey = MEMBER_OF_ATTRIBUTES.find((key) => user[key] !== undefined);
  if (!memberOfKey) return [];

  const raw = user[memberOfKey];
  const values = Array.isArray(raw) ? raw : [raw];
  return values.map(groupNameFromDn).filter(Boolean);
};

/**
 * Resolves the username to store against the Angles account. The configured attribute is
 * preferred; uid/sAMAccountName/mail are tried next, and the DN is the last resort.
 */
const resolveUsername = (user, config) => {
  const candidates = [
    config.usernameAttribute,
    'uid',
    'sAMAccountName',
    'userPrincipalName',
    'mail',
    'dn',
  ].filter(Boolean);

  const found = candidates
    .map((attribute) => user[attribute])
    .find((value) => value !== undefined && value !== null && value !== '');

  return Array.isArray(found) ? found[0] : found;
};

/**
 * Builds a passport LDAP strategy for the provider.
 *
 * Unlike OIDC and SAML this is a direct-bind flow: the user submits their password to
 * Angles, which forwards it to the directory. That makes transport security a first-order
 * concern here rather than an operational detail, so a plaintext ldap:// URL without
 * StartTLS is refused - it would put directory credentials on the wire in clear text.
 *
 * @returns {Promise<Strategy>} the configured strategy
 * @throws when the provider is incompletely or unsafely configured
 */
exports.build = async (provider) => {
  const config = provider.ldap || {};

  if (!config.url) {
    throw new Error('url (e.g. ldaps://directory.example.com:636) is required');
  }
  if (!config.searchBase) {
    throw new Error('searchBase is required');
  }
  if (!config.searchFilter) {
    throw new Error('searchFilter is required');
  }

  const isSecure = /^ldaps:\/\//i.test(config.url);
  if (!isSecure && config.startTLS !== true) {
    throw new Error(
      'url must use ldaps:// or startTLS must be enabled - a plaintext bind would expose '
      + 'user passwords on the network',
    );
  }

  // Attributes the strategy must retrieve for role mapping to work. Left unset (rather
  // than a fixed list) so the directory returns everything: restricting the list is a
  // common cause of an empty memberOf and an unexplained "no permission" denial.
  const serverOptions = {
    url: config.url,
    bindDN: config.bindDN || undefined,
    bindCredentials: config.bindCredentials || undefined,
    searchBase: config.searchBase,
    searchFilter: config.searchFilter,
    starttls: config.startTLS === true,
  };

  if (config.groupSearchBase) {
    serverOptions.groupSearchBase = config.groupSearchBase;
    serverOptions.groupSearchFilter = config.groupSearchFilter || '(member={{dn}})';
    serverOptions.groupSearchScope = 'sub';
  }

  // Certificate validation is on by default; disabling it makes the TLS connection
  // trivially interceptable, which for this flow means intercepting passwords.
  if (isSecure || config.startTLS === true) {
    serverOptions.tlsOptions = {
      rejectUnauthorized: config.tlsRejectUnauthorized !== false,
    };
    if (config.tlsRejectUnauthorized === false) {
      log('WARNING: provider %s disables LDAP certificate validation', provider.id);
    }
  }

  const verify = async (user, done) => {
    try {
      const username = resolveUsername(user, config);
      const groups = extractGroups(user, config);

      const result = await findOrProvisionUser({ username, groups, provider });
      if (!result.user) return done(null, false, { message: result.message });
      return done(null, result.user);
    } catch (err) {
      return done(err);
    }
  };

  log('Configured LDAP strategy for provider %s (%s)', provider.id, config.url);

  return new LdapStrategy({
    server: serverOptions,
    // The credentials arrive as a normal form/JSON body on the provider's login route.
    usernameField: 'username',
    passwordField: 'password',
    // Surface bind failures through the verify callback rather than throwing, so a wrong
    // password is a clean 401 instead of a 500.
    handleErrorsAsFailures: true,
  }, verify);
};

exports.groupNameFromDn = groupNameFromDn;
exports.extractGroups = extractGroups;
exports.resolveUsername = resolveUsername;
