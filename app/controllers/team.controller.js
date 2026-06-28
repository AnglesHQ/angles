const { validationResult } = require('express-validator');
const debug = require('debug');
const { Team, Component } = require('../models/team.js');
const { ConflictError, NotFoundError, ForbiddenError, handleError } = require('../exceptions/errors.js');
const authMiddleware = require('../utils/auth-middleware.js');

const log = debug('team:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { name, components } = req.body;
  if (req.user && req.user.role !== 'admin') {
    return next(new ForbiddenError('Only admins can create teams'));
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
    }).then((savedTeam) => {
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

  if (req.user && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden. Only admins can update teams.' });
  }

  return Team.where({ name }).findOne().select('_id').lean()
    .then((foundTeam) => {
      if (foundTeam) {
        throw new ConflictError(`Team with name ${name} already exists.`);
      }
      return Team.findByIdAndUpdate(teamId, {
        name: req.body.name,
      }, { new: true });
    }).then((team) => {
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
  
  if (req.user && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden. Only admins can add components.' });
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
