const { validationResult } = require('express-validator');
const debug = require('debug');
const { Team, Component } = require('../models/team.js');

const log = debug('team:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Team.where({ name: req.body.name }).findOne((mongoErr, foundTeam) => {
    if (foundTeam) {
      return res.status(409).send({
        message: `Team with name ${req.body.name} already exists.`,
      });
    }
    const team = new Team({
      name: req.body.name,
      components: req.body.components,
    });
    return team.save()
      .then((data) => {
        log(`Created team "${team.name}" with id: "${data._id}"`);
        return res.status(201).send(data);
      }).catch((err) => res.status(500).send({
        message: err.message || 'Some error occurred while creating the team.',
      }));
  });
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Team.find()
    .then((teams) => res.send(teams))
    .catch((err) => res.status(500).send({
      message: err.message || 'Some error occurred while retrieving teams.',
    }));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Team.findById(req.params.teamId)
    .then((team) => {
      if (!team) {
        return res.status(404).send({
          message: `Team not found with id ${req.params.teamId}`,
        });
      }
      return res.status(200).send(team);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving team with id ${req.params.teamId} due to [${err}]`,
    }));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Team.where({ name: req.body.name }).findOne()
    .then((foundTeam) => {
      if (foundTeam) {
        return res.status(409).send({
          message: `Team with name ${req.body.name} already exists.`,
        });
      }
      return Team.findByIdAndUpdate(req.params.teamId, {
        name: req.body.name,
      }, { new: true });
    }).then((team) => {
      if (!team) {
        return res.status(404).send({
          message: `Team not found with id ${req.params.teamId}`,
        });
      }
      return res.status(200).send(team);
    })
    .catch((err) => res.status(500).send({
      message: `Error updating team with id ${req.params.teamId} due to [${err}]`,
    }));
};

exports.addComponents = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Team.findById(req.params.teamId)
    .then((team) => {
      if (!team) {
        return res.status(404).send({
          message: `Team not found with id ${req.params.teamId}`,
        });
      }
      req.body.components.forEach((name) => {
        team.components.push(new Component({ name }));
      });
      return team.save();
    })
    .then((savedTeam) => res.status(200).send(savedTeam))
    .catch((err) => res.status(500).send({
      message: `Error adding component(s) to team with id ${req.params.teamId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Team.findByIdAndRemove(req.params.teamId)
    .then((team) => {
      if (!team) {
        return res.status(404).send({
          message: `Team not found with id ${req.params.teamId}`,
        });
      }
      return res.status(200).send({ message: 'Team deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete team with id ${req.params.teamId} due to [${err}]`,
    }));
};
