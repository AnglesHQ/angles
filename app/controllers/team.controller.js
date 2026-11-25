const crypto = require('crypto');
const { validationResult } = require('express-validator');
const debug = require('debug');
const { Team, Component } = require('../models/team.js');
const User = require('../models/user.js');
const TeamToken = require('../models/team-token.js');
const {
  ConflictError, NotFoundError, ForbiddenError, handleError,
} = require('../exceptions/errors.js');
const authMiddleware = require('../utils/auth-middleware.js');
const validationUtils = require('../utils/validation-utils.js');
const { getCoreAdminUsername } = require('../utils/admin-seed-service.js');

const log = debug('team:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { name, components } = req.body;
  if (req.user && req.user.role !== 'admin') {
    return handleError(new ForbiddenError('Only admins can create teams'), res);
  }
  return Team.findOne({ name }).select('_id').lean().exec()
    .then((foundTeam) => {
      if (foundTeam) {
        throw new ConflictError(`Team with name ${name} already exists.`);
      }
      const team = new Team({
        name,
        components,
      });
      return team.save();
    })
    .then((savedTeam) => {
      log(`Created team "${savedTeam.name}" with id: "${savedTeam._id}"`);
      return res.status(201).send(savedTeam);
    })
    .catch((err) => handleError(err, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  let query = {};
  if (req.user && req.user.role !== 'admin') {
    query = { _id: { $in: req.user.teams } };
  }

  return Team.find(query).lean()
    .then((teams) => res.status(200).send(teams))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;

  if (!authMiddleware.hasTeamAccess(req.user, teamId)) {
    return res.status(403).json({ error: 'Forbidden. You do not have access to this team.' });
  }

  return Team.findById(teamId).lean()
    .then((team) => {
      if (!team) {
        throw new NotFoundError(`Team not found with id ${teamId}`);
      }
      return res.status(200).send(team);
    }).catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { name } = req.body;
  const { teamId } = req.params;

  if (!authMiddleware.hasTeamLeadAccess(req.user, teamId)) {
    return res.status(403).json({ error: 'Forbidden. You do not have permission to update this team.' });
  }

  return Team.where({ name }).findOne().select('_id').lean()
    .then((foundTeam) => {
      if (foundTeam) {
        throw new ConflictError(`Team with name ${name} already exists.`);
      }
      return Team.findByIdAndUpdate(teamId, {
        name: req.body.name,
      }, { new: true });
    })
    .then((team) => {
      if (!team) {
        throw new NotFoundError(`Team not found with id ${teamId}`);
      }
      return res.status(200).send(team);
    })
    .catch((err) => handleError(err, res));
};

exports.addComponents = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;
  const { components } = req.body;

  if (!authMiddleware.hasTeamLeadAccess(req.user, teamId)) {
    return res.status(403).json({ error: 'Forbidden. You do not have permission to add components to this team.' });
  }

  return Team.findById(teamId)
    .then((team) => {
      if (!team) {
        throw new NotFoundError(`Team not found with id ${teamId}`);
      }
      components.forEach((name) => {
        team.components.push(new Component({ name }));
      });
      return team.save();
    })
    .then((savedTeam) => res.status(200).send(savedTeam))
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;

  if (req.user && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden. Only admins can delete teams.' });
  }

  return Team.findByIdAndRemove(teamId)
    .then((team) => {
      if (!team) {
        throw new NotFoundError(`Team not found with id ${teamId}`);
      }
      // A deleted team's tokens must not outlive it.
      return TeamToken.deleteMany({ team: team._id }).exec();
    })
    .then(() => res.status(200).send({ message: 'Team deleted successfully!' }))
    .catch((err) => handleError(err, res));
};

/**
 * What a member list needs and nothing more: no password hash, tokens or other teams.
 */
const MEMBER_FIELDS = '_id username role authProvider';

exports.getMembers = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;

  try {
    if (!authMiddleware.hasTeamLeadAccess(req.user, teamId)) {
      throw new ForbiddenError('Forbidden. You do not have permission to view the members of this team.');
    }
    const team = await Team.findById(teamId).select('_id').lean();
    if (!team) {
      throw new NotFoundError(`Team not found with id ${teamId}`);
    }
    const members = await User.find({ teams: teamId }, MEMBER_FIELDS).sort('username').lean();
    // Flag the core admin so a client can show it as not removable by a team lead.
    const coreAdmin = getCoreAdminUsername();
    return res.status(200).send(members.map((member) => ({
      ...member, isCoreAdmin: member.username === coreAdmin,
    })));
  } catch (err) {
    return handleError(err, res);
  }
};

exports.addMember = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;
  const username = req.body.username.toLowerCase();

  try {
    if (!authMiddleware.hasTeamLeadAccess(req.user, teamId)) {
      throw new ForbiddenError('Forbidden. You do not have permission to add members to this team.');
    }
    const team = await Team.findById(teamId).select('_id name').lean();
    if (!team) {
      throw new NotFoundError(`Team not found with id ${teamId}`);
    }
    const user = await User.findOne({ username }, `${MEMBER_FIELDS} teams`);
    if (!user) {
      throw new NotFoundError(`User "${username}" not found.`);
    }
    if (req.user.role !== 'admin' && user.username === getCoreAdminUsername()) {
      throw new ForbiddenError('Forbidden. The core admin account cannot be added to a team by a team lead.');
    }
    if (user.teams.some((id) => id.toString() === teamId)) {
      throw new ConflictError(`User "${username}" is already a member of this team.`);
    }
    // $addToSet rather than save(): two leads adding the same person at once must not
    // produce a duplicate entry, and the rest of the user document is left untouched.
    await User.updateOne({ _id: user._id }, { $addToSet: { teams: teamId } });
    log(`Added user "${user.username}" to team "${team.name}" (${teamId}).`);
    return res.status(201).send({
      _id: user._id, username: user.username, role: user.role, authProvider: user.authProvider,
    });
  } catch (err) {
    return handleError(err, res);
  }
};

exports.removeMember = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId, userId } = req.params;

  try {
    if (!authMiddleware.hasTeamLeadAccess(req.user, teamId)) {
      throw new ForbiddenError('Forbidden. You do not have permission to remove members from this team.');
    }
    const team = await Team.findById(teamId).select('_id name').lean();
    if (!team) {
      throw new NotFoundError(`Team not found with id ${teamId}`);
    }
    const user = await User.findOne({ _id: userId, teams: teamId }, `${MEMBER_FIELDS} teams`);
    if (!user) {
      throw new NotFoundError(`User with id ${userId} is not a member of this team.`);
    }
    if (req.user.role !== 'admin' && req.user._id.toString() === userId) {
      throw new ForbiddenError('Forbidden. You cannot remove yourself from a team you lead; ask an admin.');
    }
    if (req.user.role !== 'admin' && user.username === getCoreAdminUsername()) {
      throw new ForbiddenError('Forbidden. The core admin account cannot be removed from a team by a team lead.');
    }
    await User.updateOne({ _id: user._id }, { $pull: { teams: teamId } });
    log(`Removed user "${user.username}" from team "${team.name}" (${teamId}).`);
    return res.status(200).send({ message: 'Member removed successfully!' });
  } catch (err) {
    return handleError(err, res);
  }
};

const CANDIDATE_LIMIT = 10;

exports.searchMemberCandidates = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;
  // Usernames are stored lowercase. The term can contain regex metacharacters (. + in an
  // email address), so it is escaped and matched literally.
  const term = validationUtils.escapeRegex(req.query.q.trim().toLowerCase());

  try {
    if (!authMiddleware.hasTeamLeadAccess(req.user, teamId)) {
      throw new ForbiddenError('Forbidden. You do not have permission to add members to this team.');
    }
    const team = await Team.findById(teamId).select('_id').lean();
    if (!team) {
      throw new NotFoundError(`Team not found with id ${teamId}`);
    }
    // Everyone except people already in the team and the core admin, whatever their role or
    // how they sign in (local, LDAP, SSO).
    const filter = {
      username: { $regex: term, $ne: getCoreAdminUsername() },
      teams: { $ne: teamId },
    };
    const candidates = await User.find(filter, '_id username role')
      .sort('username')
      .limit(CANDIDATE_LIMIT)
      .lean();
    return res.status(200).send(candidates);
  } catch (err) {
    return handleError(err, res);
  }
};

/*
 * Team tokens: API tokens that belong to the team, for its automation pipelines (see
 * models/team-token.js). Managed by the team's leads and admins, from a session only.
 */

// What a token list shows: never the hash.
const toTeamTokenView = (token) => ({
  _id: token._id,
  name: token.name,
  expiresAt: token.expiresAt,
  createdAt: token.createdAt,
  createdBy: token.createdBy ? { username: token.createdBy.username } : undefined,
  lastUsedAt: token.lastUsedAt,
});

const findManageableTeam = async (req, teamId, action) => {
  if (!authMiddleware.hasTeamLeadAccess(req.user, teamId)) {
    throw new ForbiddenError(`Forbidden. You do not have permission to ${action} this team's tokens.`);
  }
  const team = await Team.findById(teamId).select('_id name').lean();
  if (!team) {
    throw new NotFoundError(`Team not found with id ${teamId}`);
  }
  return team;
};

exports.getTokens = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;
  try {
    await findManageableTeam(req, teamId, 'view');
    const tokens = await TeamToken.find({ team: teamId }).sort('name').lean();
    return res.status(200).send(tokens.map(toTeamTokenView));
  } catch (err) {
    return handleError(err, res);
  }
};

exports.createToken = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;
  const name = req.body.name.trim();
  const expiresInDays = parseInt(req.body.expiresInDays, 10);
  try {
    const team = await findManageableTeam(req, teamId, 'create');
    if (await TeamToken.exists({ team: teamId, name })) {
      throw new ConflictError(`This team already has a token named "${name}".`);
    }
    // The prefix tells the authentication middleware to look for a team token.
    const token = `${authMiddleware.TEAM_TOKEN_PREFIX}${crypto.randomBytes(32).toString('hex')}`;
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);
    const saved = await new TeamToken({
      team: teamId,
      name,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      expiresAt,
      createdBy: { user: req.user._id, username: req.user.username },
    }).save();
    log(`User "${req.user.username}" created team token "${name}" for team "${team.name}" (${teamId}).`);
    // The token itself is returned this once and never again.
    return res.status(201).send({ ...toTeamTokenView(saved), token });
  } catch (err) {
    // Two leads creating the same name at once: the unique index catches the second.
    if (err && err.code === 11000) {
      return handleError(new ConflictError(`This team already has a token named "${name}".`), res);
    }
    return handleError(err, res);
  }
};

exports.revokeToken = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId, tokenId } = req.params;
  try {
    const team = await findManageableTeam(req, teamId, 'revoke');
    const token = await TeamToken.findOneAndDelete({ _id: tokenId, team: teamId }).lean();
    if (!token) {
      throw new NotFoundError(`Token with id ${tokenId} not found for this team.`);
    }
    log(`User "${req.user.username}" revoked team token "${token.name}" of team "${team.name}" (${teamId}).`);
    return res.status(200).send({ message: 'Token revoked successfully' });
  } catch (err) {
    return handleError(err, res);
  }
};
