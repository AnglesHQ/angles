const { validationResult } = require('express-validator');
const mongoose = require('mongoose');
const buildMetricsUtils = require('../utils/build-metrics.js');

const Build = require('../models/build.js');
const { Team } = require('../models/team.js');
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
      let matchComponent;
      // check if component is correct
      teamFound.components.forEach((component) => {
        if (component.name === req.body.component) {
          matchComponent = component;
        }
      });
      const build = new Build({
        environment: environmentFound,
        team: teamFound,
        name: req.body.name,
        component: matchComponent,
        suite: [],
        result: new Map(buildMetricsUtils.defaultResultMap),
      });
      buildMetricsUtils.calculateBuildMetrics(build);
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
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId, buildIds, returnExecutionDetails } = req.query;
  const limit = parseInt(req.query.limit, 10) || 10;
  const skip = parseInt(req.query.skip, 10) || 0;
  let query = {};
  return Team.findById({ _id: teamId })
    .then((teamFound) => {
      if (!teamFound) {
        const error = new Error(`No team found with name ${req.body.team}`);
        error.status = 404;
        return Promise.reject(error);
      }
      if (buildIds) {
        const builIdsArray = buildIds.split(',');
        query = {
          team: mongoose.Types.ObjectId(teamId),
          _id: { $in: builIdsArray },
        };
      } else {
        query = {
          team: mongoose.Types.ObjectId(teamId),
        };
      }
      const buildQuery = Build.find(query, null, { limit, skip })
        .populate('team')
        .populate('environment')
        .sort('-createdAt');
      if (returnExecutionDetails === 'true') {
        // if asking for addExecutionDetails
        buildQuery.populate('suites.executions');
      }

      // add both queries to this.
      const promises = [
        buildQuery.exec(),
        Build.countDocuments(query).exec(),
      ];
      return Promise.all(promises).then((results) => {
        const builds = results[0];
        const count = results[1];
        const response = { builds, count };
        return res.status(200).send(response);
      });
    })
    .catch((error) => {
      if (error.status === 404) {
        res.status(404).send({
          message: error.message,
        });
      } else {
        res.status(500).send({
          message: error.message || 'Some error occurred while retrieving builds.',
        });
      }
    });
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Build.findById(req.params.buildId)
    .populate('team')
    .populate('environment')
    .populate('suites.executions')
    .then((build) => {
      if (!build) {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.send(build);
    })
    .catch((err) => res.status(500).send({
      message: `Error retrieving build with id ${req.params.buildId} due to [${err}]`,
    }));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
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
      return res.status(200).send(build);
    }).catch((err) => res.status(500).send({
      message: `Error updating build with id ${req.params.buildId} due to [${err}]`,
    }));
};

exports.setKeep = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  return Build.findByIdAndUpdate(req.params.buildId, {
    keep: req.body.keep,
  }, { new: true })
    .then((build) => {
      if (!build) {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.status(200).send(build);
    }).catch((err) => res.status(500).send({
      message: `Error updating build with id ${req.params.buildId} due to [${err}]`,
    }));
};

exports.setArtifacts = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Build.findByIdAndUpdate(req.params.buildId, {
    artifacts: req.body.artifacts,
  }, { new: true })
    .populate('team')
    .populate('environment')
    .then((build) => {
      if (!build) {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.status(200).send(build);
    })
    .catch((err) => res.status(500).send({
      message: `Error updating build with id ${req.params.buildId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Build.findByIdAndRemove(req.params.buildId)
    .then((build) => {
      if (!build) {
        return res.status(404).send({
          message: `Build not found with id ${req.params.buildId}`,
        });
      }
      return res.status(200).send({ message: 'Build deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete build with id ${req.params.buildId} due to [${err}]`,
    }));
};
