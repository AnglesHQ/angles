const { ForbiddenError, UnauthorizedError } = require('../exceptions/errors');

exports.isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  // Let the error handler catch it, or return a standard response
  return res.status(401).json({ error: 'Unauthorized. Please log in.' });
};

exports.authorizeAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden. Admin access required.' });
};

/**
 * Validates if the user has access to the provided team ID.
 * Admins have access to everything.
 * @param {Object} user - req.user
 * @param {String} teamId - the ObjectId of the team as a string
 * @returns {Boolean}
 */
exports.hasTeamAccess = (user, teamId) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!user.teams) return false;
  
  const teamIdStr = teamId.toString();
  return user.teams.some(t => t.toString() === teamIdStr);
};
