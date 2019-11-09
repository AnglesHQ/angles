const { validationResult } = require('express-validator');
const Build = require('../models/build.js');
const Team = require('../models/team.js');
const Environment = require('../models/environment.js');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const promises = [
    Team.findOne({ name: req.body.team }).exec(),
    Environment.findOne({ name: req.body.environment }).exec(),
  ];

  return Promise.all(promises).then((results) => {
    const teamFound = results[0];
    const environmentFound = results[1];
    if (teamFound == null || teamFound === undefined) {
      res.status(404).send({
        message: `No team found with name ${req.body.team}`,
      });
    } else if (environmentFound == null || environmentFound === undefined) {
      res.status(404).send({
        message: `No environment found with name ${req.body.environment}`,
      });
    } else {
      const build = new Build({
        environment: environmentFound,
        team: teamFound,
        name: req.body.name,
        executions: [],
      });
      build.save()
        .then((data) => {
          res.status(201).send(data);
        }).catch((err) => {
          res.status(500).send({
            message: err.message || 'Some error occurred while creating the build.',
          });
        });
    }
  }).catch((err) => {
    res.status(500).send({
      message: err.message || 'Some error occurred while creating the build.',
    });
  });
};

exports.findAll = (req, res) => {
  Build.find()
    .populate('team')
    .populate('environment')
    .then((builds) => {
      res.send(builds);
    })
    .catch((err) => {
      res.status(500).send({
        message: err.message || 'Some error occurred while retrieving builds.',
      });
    });
};

exports.findOne = (req, res) => {
  Build.findById(req.params.buildId)
    .populate('team')
    .populate('environment')
    .populate('executions')
    .then((build) => {
      if (!build) {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.send(build);
    })
    .catch((err) => {
      if (err.kind === 'ObjectId') {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.status(500).send({
        message: `Error retrieving build with id ${req.params.buildId}`,
      });
    });
};

exports.update = (req, res) => {
  // validate request
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  // Find build and update it with the request body
  return Build.findByIdAndUpdate(req.params.buildId, {
    team: req.body.team,
    environment: req.body.environment,
  }, { new: true })
    .then((build) => {
      if (!build) {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.send(build);
    }).catch((err) => {
      if (err.kind === 'ObjectId') {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.status(500).send({
        message: `Error updating build with id ${req.params.buildId}`,
      });
    });
};

exports.updateKeep = (req, res) => {
  // validate request
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  // Find build and update it with the request body
  return Build.findByIdAndUpdate(req.params.buildId, {
    keep: req.body.keep,
  }, { new: true })
    .then((build) => {
      if (!build) {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.send(build);
    }).catch((err) => {
      if (err.kind === 'ObjectId') {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.status(500).send({
        message: `Error updating build with id ${req.params.buildId}`,
      });
    });
};

// Delete a build with the specified build in the request
exports.delete = (req, res) => {
  Build.findByIdAndRemove(req.params.buildId)
    .then((build) => {
      if (!build) {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.send({ message: 'Build deleted successfully!' });
    }).catch((err) => {
      if (err.kind === 'ObjectId' || err.name === 'NotFound') {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.status(500).send({
        message: `Could not delete build with id ${req.params.buildId}`,
      });
    });
};
