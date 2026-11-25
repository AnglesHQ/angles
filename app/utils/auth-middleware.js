const crypto = require('crypto');
const debug = require('debug');

const User = require('../models/user.js');
const TeamToken = require('../models/team-token.js');

const log = debug('auth:middleware');

/*
 * Team tokens (see models/team-token.js) are told apart from personal tokens by this
 * prefix, so each request looks in one place, and a leaked team token is recognisable.
 */
const TEAM_TOKEN_PREFIX = 'angles_team_';
const API_PREFIX = '/rest/api/v1.0';

/*
 * What a team token may change: reporting a team's test results, which is everything the
 * clients' reporters do in a pipeline. Anything else that writes (deleting results,
 * changing teams, users, environments, settings, manual testing) is refused, whatever
 * the endpoint's own checks would allow. Reads are allowed, limited to the token's team
 * by the same checks that limit a member of it.
 */
const TEAM_TOKEN_WRITES = [
  ['POST', /^\/build\/?$/],
  ['PUT', /^\/build\/[^/]+\/(executions|artifacts|keep)\/?$/],
  ['POST', /^\/build\/[^/]+\/attachment\/?$/],
  ['POST', /^\/execution\/?$/],
  ['POST', /^\/screenshot\/?$/],
];
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

const isTeamTokenRequestAllowed = (req) => {
  if (READ_METHODS.includes(req.method)) return true;
  // The full path, whether this runs mounted on the API prefix or on a single route.
  const fullPath = `${req.baseUrl}${req.path}`;
  if (!fullPath.startsWith(`${API_PREFIX}/`)) return false;
  const apiPath = fullPath.slice(API_PREFIX.length);
  return TEAM_TOKEN_WRITES
    .some(([method, pattern]) => method === req.method && pattern.test(apiPath));
};

// lastUsedAt is recorded at most once an hour per token, so a busy pipeline does not put a
// write on every request.
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

const recordTeamTokenUse = (token, now) => {
  if (token.lastUsedAt && now - new Date(token.lastUsedAt) < LAST_USED_RESOLUTION_MS) return;
  TeamToken.updateOne({ _id: token._id }, { $set: { lastUsedAt: now } }).exec()
    .catch((err) => log('Could not record use of team token %s: %s', token._id, err.message));
};

/*
 * Looks up a team token. When it is valid, the request acts as a member of the token's
 * team and nothing else: role `user`, that one team, no user account. `req.teamToken`
 * says so to anything that needs to know (the build's "triggered by", for one).
 *
 * @returns {Promise<boolean>} whether the token is valid
 */
const authenticateTeamToken = async (req, tokenHash) => {
  const token = await TeamToken.findOne({ tokenHash }).lean();
  const now = new Date();
  if (!token || new Date(token.expiresAt) <= now) return false;

  req.user = {
    username: token.name,
    role: 'user',
    teams: [token.team],
    isTeamToken: true,
  };
  req.isTokenAuth = true;
  req.apiTokenName = token.name;
  req.teamToken = { _id: token._id, name: token.name, team: token.team };
  recordTeamTokenUse(token, now);
  return true;
};

exports.isAuthenticated = async (req, res, next) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }

  // Check for API Key
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    let teamTokenValid = false;
    try {
      const tokenHash = crypto.createHash('sha256').update(apiKey).digest('hex');
      if (apiKey.startsWith(TEAM_TOKEN_PREFIX)) {
        teamTokenValid = await authenticateTeamToken(req, tokenHash);
      } else {
        const user = await User.findOne({ 'apiTokens.tokenHash': tokenHash });

        if (user) {
          const token = user.apiTokens.find((t) => t.tokenHash === tokenHash);
          if (token && new Date(token.expiresAt) > new Date()) {
            req.user = user;
            req.isTokenAuth = true;
            req.apiTokenName = token.name;
            return next();
          }
        }
      }
    } catch (err) {
      // Fall through to the 401 below - we deliberately do not tell the caller whether the
      // token was rejected or the lookup itself failed. Log it so a database outage is not
      // silently indistinguishable from a bad token.
      log('API token lookup failed: %s', err.message);
    }
    if (teamTokenValid) {
      if (!isTeamTokenRequestAllowed(req)) {
        return res.status(403).json({
          error: 'Forbidden. A team token can only report test results and read its team\'s data.',
        });
      }
      return next();
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
  return user.teams.some((t) => t.toString() === teamIdStr);
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
    return user.teams.some((t) => t.toString() === teamIdStr);
  }
  return false;
};

exports.preventTokenAuth = (req, res, next) => {
  if (req.isTokenAuth) {
    return res.status(403).json({ error: 'Forbidden. API Tokens cannot be used for this endpoint.' });
  }
  return next();
};

exports.TEAM_TOKEN_PREFIX = TEAM_TOKEN_PREFIX;
exports.isTeamTokenRequestAllowed = isTeamTokenRequestAllowed;
