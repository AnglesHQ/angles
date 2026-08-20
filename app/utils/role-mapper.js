/**
 * Resolves an Angles role from the group/attribute values supplied by an identity
 * provider. Shared by every SSO provider type: OIDC passes the groups claim, SAML the
 * groups attribute, and LDAP the resolved group names.
 */

// Highest privilege first, so a subject matching several mappings gets the strongest role.
const ROLE_PRECEDENCE = ['admin', 'team_lead', 'user'];

/**
 * Normalises a provider-supplied groups value into an array of strings. Providers are
 * inconsistent here: a single group may arrive as a bare string rather than an array,
 * and SAML attributes in particular are frequently scalar when there is one value.
 * @param {*} groups - raw value from the claim/attribute
 * @returns {string[]}
 */
const toGroupArray = (groups) => {
  if (Array.isArray(groups)) {
    return groups.filter((group) => typeof group === 'string' || typeof group === 'number')
      .map((group) => String(group));
  }
  if (typeof groups === 'string' && groups.length > 0) {
    return [groups];
  }
  if (typeof groups === 'number') {
    return [String(groups)];
  }
  return [];
};

/**
 * Resolves a role from the provider's role mappings.
 *
 * Matching is case-insensitive because directories are inconsistent about casing
 * (Active Directory group names and SAML attribute values in particular), and an admin
 * typing "Angles-Admins" into the UI should still match "angles-admins" from the wire.
 *
 * @param {string[]|string} groups - group values from the provider
 * @param {Array<{value: string, role: string}>} roleMappings - configured mappings
 * @param {string} [defaultRole] - role granted when nothing matches; empty/absent denies
 * @returns {string|null} the mapped role, or null when access should be denied
 */
exports.resolveRole = (groups, roleMappings = [], defaultRole = '') => {
  const groupList = toGroupArray(groups).map((group) => group.toLowerCase());

  const matched = (roleMappings || [])
    .filter((mapping) => mapping && mapping.value && mapping.role)
    .filter((mapping) => groupList.includes(String(mapping.value).toLowerCase()))
    .map((mapping) => mapping.role);

  if (matched.length > 0) {
    // Grant the strongest role the subject qualifies for.
    return ROLE_PRECEDENCE.find((role) => matched.includes(role)) || null;
  }

  return defaultRole || null;
};

exports.toGroupArray = toGroupArray;
exports.ROLE_PRECEDENCE = ROLE_PRECEDENCE;
