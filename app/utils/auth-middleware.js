const { ForbiddenError, UnauthorizedError } = require('../exceptions/errors');

const User = require('../models/user');
const crypto = require('crypto');

exports.isAuthenticated = async (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  
  // Check for API Key
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    try {
      const tokenHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      const user = await User.findOne({ 'apiTokens.tokenHash': tokenHash });
      
      if (user) {
        const token = user.apiTokens.find(t => t.tokenHash === tokenHash);
        if (token && new Date(token.expiresAt) > new Date()) {
          req.user = user;
          req.isTokenAuth = true;
          return next();
        }
      }
    } catch (err) {
      // Ignore error and fall through to 401
    }
  }

  // Let the error handler catch it, or return a standard response
  return res.status(401).json({ error: 'Unauthorized. Please log in or provide a valid x-api-key.' });
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

/**
 * Validates if the user has team lead access to the provided team ID.
 * Admins have access to everything.
 * @param {Object} user - req.user
 * @param {String} teamId - the ObjectId of the team as a string
 * @returns {Boolean}
 */
exports.hasTeamLeadAccess = (user, teamId) => {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'team_lead' && user.teams) {
    const teamIdStr = teamId.toString();
    return user.teams.some(t => t.toString() === teamIdStr);
  }
  return false;
};

exports.preventTokenAuth = (req, res, next) => {
  if (req.isTokenAuth) {
    return res.status(403).json({ error: 'Forbidden. API Tokens cannot be used for this endpoint.' });
  }
  return next();
};
