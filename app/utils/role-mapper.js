const authConfig = require('../../config/auth.config');

/**
 * Ordered highest-privilege first, so a user who belongs to more than one mapped
 * group is granted the strongest role. Groups that have not been configured are
 * filtered out and therefore never match.
 * @returns {Array<{ group: string, role: string }>}
 */
const roleMappings = () => [
  { group: authConfig.okta.adminGroup, role: 'admin' },
  { group: authConfig.okta.teamLeadGroup, role: 'team_lead' },
  { group: authConfig.okta.userGroup, role: 'user' },
].filter((mapping) => mapping.group);

/**
 * Resolves an Angles role from the list of Okta groups a user belongs to.
 * @param {string[]} groups - group names from the Okta profile claim
 * @returns {string|null} the mapped role, or null if the user is in none of the configured groups
 */
exports.resolveRoleFromGroups = (groups = []) => {
  const match = roleMappings().find((mapping) => groups.includes(mapping.group));
  return match ? match.role : null;
};
