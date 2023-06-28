const { validationResult } = require('express-validator');
const debug = require('debug');
const { Team, Component } = require('../models/team.js');
const { ConflictError, NotFoundError, handleError } = require('../exceptions/errors.js');

const log = debug('team:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { name, components } = req.body;
  return Team.findOne({ name }).exec()
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
  return Team.find()
    .then((teams) => res.status(200).send(teams))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.params;
  return Team.findById(teamId)
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
  return Team.where({ name }).findOne()
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
  return Team.findByIdAndRemove(teamId)
    .then((team) => {
      if (!team) {
        throw new NotFoundError(`Team not found with id ${teamId}`);
      }
      return res.status(200).send({ message: 'Team deleted successfully!' });
    }).catch((err) => handleError(err, res));
};
