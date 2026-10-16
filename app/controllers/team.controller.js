const { validationResult } = require('express-validator');
const debug = require('debug');
const { Team, Component } = require('../models/team.js');
const User = require('../models/user.js');
const {
  ConflictError, NotFoundError, ForbiddenError, handleError,
} = require('../exceptions/errors.js');
const authMiddleware = require('../utils/auth-middleware.js');

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
      return res.status(200).send({ message: 'Team deleted successfully!' });
    }).catch((err) => handleError(err, res));
};

/**
 * What a member list needs and nothing more: no password hash, tokens or other teams.
 */
const MEMBER_FIELDS = '_id username role authProvider';

/**
 * Team leads manage plain users only. An admin's access is global, and a team lead's
 * `team_lead` role is what grants lead powers over every team they belong to - so letting
 * a lead add or remove another lead would let them hand out (or take away) lead access.
 * Those memberships stay with admins.
 */
const canManageMembership = (caller, targetUser) => caller.role === 'admin' || targetUser.role === 'user';

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
    return res.status(200).send(members);
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
    if (!canManageMembership(req.user, user)) {
      throw new ForbiddenError('Forbidden. Only an admin can add team leads or admins to a team.');
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
    if (!canManageMembership(req.user, user)) {
      throw new ForbiddenError('Forbidden. Only an admin can remove team leads or admins from a team.');
    }
    await User.updateOne({ _id: user._id }, { $pull: { teams: teamId } });
    log(`Removed user "${user.username}" from team "${team.name}" (${teamId}).`);
    return res.status(200).send({ message: 'Member removed successfully!' });
  } catch (err) {
    return handleError(err, res);
  }
};
