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
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  handleError,
} = require('../exceptions/errors.js');
const authMiddleware = require('../utils/auth-middleware.js');

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
    phasePromise = Phase.findOne({ name: phase }).lean().exec();
  }

  const promises = [
    Team.findOne({ name: team }).lean().exec(),
    Environment.findOne({ name: environment }).lean().exec(),
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

      if (!authMiddleware.hasTeamAccess(req.user, teamFound._id)) {
        throw new ForbiddenError('You do not have access to this team');
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
      const { name, start, executions } = req.body;
      const build = new Build({
        environment: environmentFound,
        team: teamFound,
        name,
        component: matchComponent,
        suites: [],
        start,
        result: new Map(buildMetricsUtils.defaultResultMap),
      });
      if (phase && phaseFound) {
        build.phase = phaseFound._id;
      }
      buildMetricsUtils.calculateBuildMetrics(build);
      return build.save()
        .then((savedBuild) => {
          // Executions are optional; when supplied the whole build is created in one call rather
          // than requiring a POST /execution per test afterwards.
          if (!executions || executions.length === 0) {
            return savedBuild;
          }
          const testExecutions = executions
            .map((execution) => buildMetricsUtils.buildExecution(execution, savedBuild));
          return Execution.insertMany(testExecutions)
            .then((savedExecutions) => buildMetricsUtils
              .addExecutionsToBuild(savedBuild, savedExecutions))
            .catch(async (err) => {
              // Don't leave a build behind that only partially reflects the executions posted
              // with it - the caller retries the whole request instead.
              log(`Failed to add executions to build ${savedBuild._id}, rolling back: ${err.message}`);
              await Execution.deleteMany({ build: savedBuild._id }).exec();
              await Build.deleteOne({ _id: savedBuild._id }).exec();
              throw err;
            });
        });
    })
    .then((savedBuild) => Build
      .findOne({ _id: savedBuild._id })
      .populate('team')
      .populate('environment')
      .populate('phase')
      .populate('suites.executions')
      .lean()
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
  return Team.findById(teamId).select('_id').lean()
    .then((teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with name ${req.body.team}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, teamId)) {
        throw new ForbiddenError('You do not have access to this team');
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
      if (environmentIds) query.environment = { $in: environmentIds.split(',').map((environmentId) => (mongoose.Types.ObjectId(environmentId))) };
      if (componentIds) query.component = { $in: componentIds.split(',').map((componentId) => (mongoose.Types.ObjectId(componentId))) };
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
      log(`QUERY: ${JSON.stringify(query)}`);
      const buildQuery = Build.find(query, null, {
        limit,
        skip,
      })
        .populate('team')
        .populate('environment')
        .populate('phase')
        .sort('-createdAt')
        .lean();
      if (returnExecutionDetails === 'true') {
        // if asking for addExecutionDetails
        buildQuery.populate('suites.executions');
      }

      // add both queries to this.
      const promises = [
        buildQuery.exec(),
        Build.countDocuments(query)
          .exec(),
        Build.aggregate([
          { $match: query },
          { $project: { result: 1, end: 1, start: 1 } },
          { $addFields: { length: { $subtract: ['$end', '$start'] } } },
          { $unset: ['end', 'start'] },
          {
            $group: {
              _id: { _id: 'result' },
              pass: { $sum: '$result.PASS' },
              fail: { $sum: '$result.FAIL' },
              error: { $sum: '$result.ERROR' },
              skipped: { $sum: '$result.SKIPPED' },
              totalTimeMs: { $sum: '$length' },
            },
          },
          { $addFields: { totalExecutions: { $sum: ['$pass', '$fail', '$error', '$skipped'] } } },
          { $unset: ['_id'] },
        ]),
      ];
      return Promise.all(promises);
    })
    .then((results) => {
      const builds = results[0];
      const count = results[1];
      const executionMetrics = results[2][0];
      const response = { builds, metrics: { totalTestRuns: count, ...executionMetrics } };
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
    .lean()
    .then((build) => {
      if (!build) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, build.team._id)) {
        throw new ForbiddenError('You do not have access to this build');
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
      if (!authMiddleware.hasTeamAccess(req.user, retrievedBuild.team._id)) {
        throw new ForbiddenError('You do not have access to this build');
      }
      build = retrievedBuild;
      // retrieve all screenshots by buildId
      const query = { build: mongoose.Types.ObjectId(build._id) };
      return Screenshot.find(query).lean();
    })
    // eslint-disable-next-line global-require
    .then((screenshots) => res.render('index', { build, screenshots, moment: require('moment') }))
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
  // Note: for a more robust update, we should fetch the existing build and check its team as well,
  // but updating build.team is checked below if it's changing the team.
  return Build.findById(buildId).then((existingBuild) => {
    if (!existingBuild) {
      throw new NotFoundError(`No build found with id ${buildId}`);
    }
    if (!authMiddleware.hasTeamAccess(req.user, existingBuild.team)) {
      throw new ForbiddenError('You do not have access to this build');
    }
    // if team is being updated, check if user has access to new team.
    // (team comes as name or id? assume id for update)
    if (team && existingBuild.team.toString() !== team.toString()) {
      if (!authMiddleware.hasTeamAccess(req.user, team)) {
        throw new ForbiddenError('You do not have access to the new team');
      }
    }
    return Build.findByIdAndUpdate(buildId, {
      team,
      environment,
    }, { new: true });
  })
    .then((build) => {
      if (!build) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      return res.status(200).send(build);
    }).catch((err) => handleError(err, res));
};

exports.addExecutions = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId } = req.params;
  const { executions } = req.body;
  return Build.findById(buildId)
    .then((existingBuild) => {
      if (!existingBuild) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, existingBuild.team)) {
        throw new ForbiddenError('You do not have access to this build');
      }
      const testExecutions = executions
        .map((execution) => buildMetricsUtils.buildExecution(execution, existingBuild));
      return Execution.insertMany(testExecutions)
        .then((savedExecutions) => buildMetricsUtils
          .addExecutionsToBuild(existingBuild, savedExecutions))
        .catch(async (err) => {
          // Unlike create, the build may already hold executions and screenshots, so only the
          // executions from this failed batch are removed - the caller retries the batch.
          log(`Failed to add executions to build ${buildId}, rolling back batch: ${err.message}`);
          const batchIds = testExecutions.map((execution) => execution._id);
          await Execution.deleteMany({ _id: { $in: batchIds } }).exec();
          throw err;
        });
    })
    .then(() => Build
      .findOne({ _id: buildId })
      .populate('team')
      .populate('environment')
      .populate('phase')
      .populate('suites.executions')
      .lean()
      .exec())
    .then((updatedBuild) => {
      log(`Added ${executions.length} execution(s) to build ${buildId}`);
      return res.status(200).send(updatedBuild);
    })
    .catch((err) => handleError(err, res));
};

exports.setKeep = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId } = req.params;
  const { keep } = req.body;
  return Build.findById(buildId).then((existingBuild) => {
    if (!existingBuild) {
      throw new NotFoundError(`No build found with id ${buildId}`);
    }
    if (!authMiddleware.hasTeamAccess(req.user, existingBuild.team)) {
      throw new ForbiddenError('You do not have access to this build');
    }
    return Build.findByIdAndUpdate(buildId, {
      keep,
    }, { new: true });
  })
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
  return Build.findById(buildId).then((existingBuild) => {
    if (!existingBuild) {
      throw new NotFoundError(`No build found with id ${buildId}`);
    }
    if (!authMiddleware.hasTeamAccess(req.user, existingBuild.team)) {
      throw new ForbiddenError('You do not have access to this build');
    }
    return Build.findByIdAndUpdate(buildId, {
      artifacts: req.body.artifacts,
    }, { new: true })
      .populate('team')
      .populate('environment')
      .populate('phase');
  })
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
  return Build.findById(buildId)
    .then(async (existingBuild) => {
      if (!existingBuild) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      if (!authMiddleware.hasTeamLeadAccess(req.user, existingBuild.team)) {
        throw new ForbiddenError('You do not have permission to delete this build');
      }

      // Same rule as deleteMany: a build whose screenshots back a baseline is never
      // deleted, otherwise the baseline would be left pointing at a screenshot that no
      // longer exists and visual comparison for that view would break.
      const screenshots = await Screenshot.find({ build: existingBuild._id })
        .select('_id')
        .lean();
      const screenshotIds = screenshots.map((screenshot) => screenshot._id);
      const baselineCount = await Baseline.countDocuments({
        screenshot: { $in: screenshotIds },
      });
      if (baselineCount > 0) {
        throw new ConflictError(`Unable to delete build with id ${buildId} as ${baselineCount} of its screenshots are used as baselines.`);
      }

      // Cascade the same way deleteMany does: image files on disk first, then the
      // screenshot and execution documents, then the build itself.
      await imageUtils.removeScreenshotDirectories([existingBuild]);
      await Screenshot.deleteMany({ build: existingBuild._id }).exec();
      await Execution.deleteMany({ build: existingBuild._id }).exec();
      log(`Deleting build ${buildId} along with ${screenshotIds.length} screenshot(s).`);
      return Build.findByIdAndRemove(buildId);
    })
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
      if (!authMiddleware.hasTeamLeadAccess(req.user, teamId)) {
        throw new ForbiddenError('You do not have permission to delete builds for this team');
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
      // Query by id rather than by whole document - mongoose casts the latter, but only
      // incidentally, and it sends every full document into the query.
      const buildIds = allBuildsToDelete.map((build) => build._id);
      return Screenshot.find({ build: { $in: buildIds } }).select('_id').lean();
    })
    .then((screenshotsToDelete) => Baseline.find({
      screenshot: { $in: screenshotsToDelete.map((screenshot) => screenshot._id) },
    }).populate('screenshot'))
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
        // deleteMany rather than the deprecated remove(): remove() is gone in Mongoose 7,
        // where it would silently stop cleaning these up.
        Screenshot.deleteMany({ build: { $in: buildsToDeleteIds } })
          .exec(),
        Execution.deleteMany({ build: { $in: buildsToDeleteIds } })
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
