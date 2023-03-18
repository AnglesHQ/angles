const { validationResult } = require('express-validator');
const mongoose = require('mongoose');
const debug = require('debug');

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
const { NotFoundError, handleError } = require('../exceptions/errors.js');

const log = debug('build:controller');

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    team,
    environment,
    phase,
    component: requestComponent,
  } = req.body;
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
        throw new NotFoundError(`No team found with name ${team}`);
      }

      if (environmentFound === null || environmentFound === undefined) {
        throw new NotFoundError(`No environment found with name ${environment}`);
      }

      if (phase && (phaseFound === null || phaseFound === undefined)) {
        throw new NotFoundError(`No phase found with name ${phase}`);
      }

      let matchComponent;
      // check if component is correct
      teamFound.components.forEach((component) => {
        if (component.name === requestComponent) {
          matchComponent = component;
        }
      });
      if (!matchComponent) {
        throw new NotFoundError(`No component found with name ${requestComponent}`);
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
    .catch((err) => handleError(err, res));
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
        throw new NotFoundError(`No team found with name ${req.body.team}`);
      }
      if (buildIds) {
        const buildIdsArray = buildIds.split(',');
        query = {
          team: mongoose.Types.ObjectId(teamId),
          _id: { $in: buildIdsArray },
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
      const buildQuery = Build.find(query, null, {
        limit,
        skip,
      })
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
        Build.countDocuments(query)
          .exec(),
      ];
      return Promise.all(promises);
    })
    .then((results) => {
      const builds = results[0];
      const count = results[1];
      const response = { builds, count };
      return res.status(200).send(response);
    })
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId } = req.params;
  return Build.findById(buildId)
    .populate('team')
    .populate('environment')
    .populate('phase')
    .populate('suites.executions')
    .then((build) => {
      if (!build) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      return res.status(200).send(build);
    })
    .catch((err) => handleError(err, res));
};

exports.getReport = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  let build;
  const { buildId } = req.params;
  return Build.findById(req.params.buildId)
    .populate('team')
    .populate('environment')
    .populate('phase')
    .populate('suites.executions')
    .then((retrievedBuild) => {
      if (!retrievedBuild) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      build = retrievedBuild;
      // retrieve all screenshots by buildId
      const query = { build: mongoose.Types.ObjectId(build._id) };
      return Screenshot.find(query);
    })
    .then((screenshots) => {
      // eslint-disable-next-line global-require
      return res.render('index', { build, screenshots, moment: require('moment') });
    })
    .catch((err) => handleError(err, res));
};

// TODO: We should be able to update more than just team and/or environment.
exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId } = req.params;
  const { team, environment } = req.body;
  return Build.findByIdAndUpdate(buildId, {
    team,
    environment,
  }, { new: true })
    .then((build) => {
      if (!build) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      return res.status(200).send(build);
    }).catch((err) => handleError(err, res));
};

exports.setKeep = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId } = req.params;
  const { keep } = req.body;
  return Build.findByIdAndUpdate(buildId, {
    keep,
  }, { new: true })
    .then((build) => {
      if (!build) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      return res.status(200).send(build);
    }).catch((err) => handleError(err, res));
};

exports.setArtifacts = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId } = req.params;
  return Build.findByIdAndUpdate(buildId, {
    artifacts: req.body.artifacts,
  }, { new: true })
    .populate('team')
    .populate('environment')
    .populate('phase')
    .then((build) => {
      if (!build) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      return res.status(200).send(build);
    })
    .catch((err) => handleError(err, res));
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
  const { buildId } = req.params;
  return Build.findByIdAndRemove(buildId)
    .then((build) => {
      if (!build) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      return res.status(200).send({ message: 'Build deleted successfully!' });
    }).catch((err) => handleError(err, res));
};

exports.deleteMany = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  let allBuildsToDelete;
  let reportingMetrics = {};
  const { teamId, ageInDays } = req.query;
  // delete by team and age (or default age 2 months) unless keep flag
  return Team.findById({ _id: teamId })
    .then((teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${teamId}`);
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
      return Build.find(deleteBuildQuery);
    })
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
      reportingMetrics = {
        buildsToDeleteLength: buildsToDelete.length,
        uniqueBaselineBuildIdsLength: uniqueBaselineBuildIds.length,
      };
      const promises = [
        imageUtils.removeScreenshotDirectories(buildsToDelete),
        Screenshot.remove({ build: { $in: buildsToDelete } })
          .exec(),
        Execution.remove({ build: { $in: buildsToDelete } })
          .exec(),
        Build.deleteMany({ _id: { $in: buildsToDeleteIds } })
          .exec(),
      ];
      return Promise.all(promises);
    })
    .then((results) => {
      log(results);
      return res.status(200).send({ message: `Deleted [${reportingMetrics.buildsToDeleteLength}] for team with id ${teamId} and age ${ageInDays}. Unable to delete ${reportingMetrics.uniqueBaselineBuildIdsLength} builds as they have baselines set.` });
    })
    .catch((err) => handleError(err, res));
};
