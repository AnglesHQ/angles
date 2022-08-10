const { validationResult } = require('express-validator');
const mongoose = require('mongoose');
const debug = require('debug');
const rimraf = require('rimraf');
const path = require('path');

const buildMetricsUtils = require('../utils/build-utils.js');
const imageUtils = require('../utils/image-utils.js');
const validationUtils = require('../utils/validation-utils.js');

const Build = require('../models/build.js');
const { Team } = require('../models/team.js');
const Environment = require('../models/environment.js');
const Screenshot = require('../models/screenshot.js');
const Execution = require('../models/execution.js');
const Baseline = require('../models/baseline.js');
const Phase = require('../models/phase.js');

const log = debug('build:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { team, environment, phase } = req.body;
  let phasePromise = Promise.resolve(true);
  if (phase) {
    phasePromise = Phase.findOne({ name: phase }).exec();
  }

  const promises = [
    Team.findOne({ name: team }).exec(),
    Environment.findOne({ name: environment }).exec(),
    phasePromise,
  ];

  return Promise.all(promises)
    .then((results) => {
      const teamFound = results[0];
      const environmentFound = results[1];
      const phaseFound = results[2];

      if (teamFound === null || teamFound === undefined) {
        return res.status(404).send({
          message: `No team found with name ${team}`,
        });
      }

      if (environmentFound === null || environmentFound === undefined) {
        return res.status(404).send({
          message: `No environment found with name ${environment}`,
        });
      }

      if (phase && (phaseFound === null || phaseFound === undefined)) {
        return res.status(404).send({
          message: `No phase found with name ${phase}`,
        });
      }

      let matchComponent;
      // check if component is correct
      teamFound.components.forEach((component) => {
        if (component.name === req.body.component) {
          matchComponent = component;
        }
      });
      if (!matchComponent) {
        return res.status(404).send({
          message: `No component found with name ${req.body.component}`,
        });
      }
      // create and save build
      const { name, start } = req.body;
      const build = new Build({
        environment: environmentFound,
        team: teamFound,
        name,
        component: matchComponent,
        suite: [],
        start,
        result: new Map(buildMetricsUtils.defaultResultMap),
      });
      if (phase && phaseFound) {
        build.phase = phaseFound._id;
      }
      buildMetricsUtils.calculateBuildMetrics(build);
      return build.save();
    })
    .then((savedBuild) => Build
      .findOne({ _id: savedBuild._id })
      .populate('team')
      .populate('environment')
      .populate('phase')
      .exec())
    .then((savedBuild) => {
      log(`Created build "${savedBuild.name}" for team "${savedBuild.team.name}" with id: ${savedBuild._id}`);
      return res.status(201).send(savedBuild);
    })
    .catch((err) => res.status(500).send({
      message: err.message || 'Some error occurred while creating the build.',
    }));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    teamId,
    buildIds,
    returnExecutionDetails,
    environmentIds,
    componentIds,
    fromDate,
    toDate,
  } = req.query;
  const limit = parseInt(req.query.limit, 10) || 10;
  const skip = parseInt(req.query.skip, 10) || 0;
  let query = {};
  return Team.findById({ _id: teamId })
    .then((teamFound) => {
      if (!teamFound) {
        return res.status(404).send({
          message: `No team found with name ${req.body.team}`,
        });
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
      if (environmentIds) query.environment = { $in: environmentIds.split(',') };
      if (componentIds) query.component = { $in: componentIds.split(',') };
      if (fromDate) {
        const fromDateJS = new Date(fromDate);
        fromDateJS.setHours(0, 0, 0, 0);
        query.start = { $gte: fromDateJS };
      }
      if (toDate) {
        const toDateJS = new Date(toDate);
        toDateJS.setHours(23, 59, 59, 0);
        query.end = { $lt: toDateJS };
      }
      log(JSON.stringify(query));
      const buildQuery = Build.find(query, null, { limit, skip })
        .populate('team')
        .populate('environment')
        .populate('phase')
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
    .catch((err) => {
      res.status(500).send({
        message: err.message || 'Unable to retrieve builds.',
      });
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
    .populate('phase')
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

// TODO: We should be able to update more than just team and/or environment.
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
    .populate('phase')
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

/*
 TODO: when deleting a build we need to consider removing:
  - associated execution
  - associated Screenshot
  - baselines
 */
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

exports.deleteMany = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId, ageInDays } = req.query;
  // delete by team and age (or default age 2 months) unless keep flag
  return Team.findById({ _id: teamId })
    .then((teamFound) => {
      if (!teamFound) {
        return res.status(404).send({
          message: `Team not found with id ${teamId}`,
        });
      }
      const date = new Date();
      let daysToDeletion = 90;
      if (ageInDays) { daysToDeletion = ageInDays; }
      const deletionDate = new Date(date.setDate(date.getDate() - daysToDeletion));
      const deleteBuildQuery = {
        team: teamId,
        createdAt: { $lt: deletionDate },
        keep: { $ne: true },
      };
      let allBuildsToDelete;
      return Build.find(deleteBuildQuery)
        .then((builds) => {
          allBuildsToDelete = builds;
          return Screenshot.find({ build: { $in: allBuildsToDelete } });
        })
        .then((screenshotsToDelete) => Baseline.find({ screenshot: { $in: screenshotsToDelete } })
          .populate('screenshot'))
        .then((baseLines) => {
          // We keep the builds that contain any baseline screenshots
          const baselineScreenshots = baseLines.map((baseline) => baseline.screenshot);
          const baselineBuilds = baselineScreenshots.map((screenshot) => screenshot.build);
          const uniqueBaselineBuildIds = validationUtils.returnUniqueDocumentIds(baselineBuilds);
          const buildsToDelete = allBuildsToDelete
            .filter((build) => !uniqueBaselineBuildIds.includes(build._id.toString()));
          const buildsToDeleteIds = validationUtils.returnUniqueDocumentIds(buildsToDelete);
          const promises = [
            imageUtils.removeScreenshotDirectories(buildsToDelete),
            Screenshot.remove({ build: { $in: buildsToDelete } }).exec(),
            Execution.remove({ build: { $in: buildsToDelete } }).exec(),
            Build.deleteMany({ _id: { $in: buildsToDeleteIds } }).exec(),
          ];
          return Promise.all(promises)
            .then((results) => {
              log(results);
              return res.status(200).send({ message: `Deleted [${buildsToDelete.length}] for team with id ${teamId} and age ${ageInDays}. Unable to delete ${uniqueBaselineBuildIds.length} builds as they have baselines set.` });
            });
        })
        .catch((err) => res.status(500).send({
          message: `Could not delete build with id ${req.params.buildId} due to [${err}]`,
        }));
    });
};
