const { validationResult } = require('express-validator');
const debug = require('debug');
const TestExecution = require('../models/execution.js');
const Build = require('../models/build.js');
const buildMetricsUtils = require('../utils/build-utils.js');
const authMiddleware = require('../utils/auth-middleware.js');
const { handleError, NotFoundError, ForbiddenError } = require('../exceptions/errors.js');

const log = debug('execution:controller');

/**
 * An execution belongs to a team only indirectly, through its build. Resolves that team and
 * throws if the caller has no access to it. Admins pass for everything (see hasTeamAccess).
 */
const assertExecutionAccess = async (user, execution) => {
  const build = await Build.findById(execution.build).select('team').lean();
  if (!build) {
    throw new NotFoundError(`No build found for execution with id ${execution._id}`);
  }
  if (!authMiddleware.hasTeamAccess(user, build.team)) {
    throw new ForbiddenError('You do not have access to this execution');
  }
  return build;
};

// Create and save a new test execution
exports.create = (req, res) => {
  // check the request is valid
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  let testExecution;
  const { build: buildId } = req.body;
  return Build.findById(buildId)
    .populate('suites.executions')
    .then((buildFound) => {
      if (!buildFound) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      testExecution = buildMetricsUtils.createExecution(req, buildFound);
      return testExecution.save();
    })
    .then((savedExecution) => {
      testExecution = savedExecution;
      return buildMetricsUtils.addExecutionToBuild(testExecution.build, testExecution);
    })
    .then((savedBuild) => {
      testExecution.build = savedBuild._id;
      log(`Created test "${testExecution.title}", suite "${testExecution.suite}" build "${testExecution.build}", with id: "${testExecution._id}"`);
      return res.status(201).send(testExecution);
    })
    .catch((error) => handleError(error, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId, executionIds } = req.query;
  if (buildId) {
    return Build.findById(buildId).select('_id team').lean()
      // .populate('suites.executions')
      .then((buildFound) => {
        if (!buildFound) {
          throw new NotFoundError(`No build found with id ${buildId}`);
        }
        if (!authMiddleware.hasTeamAccess(req.user, buildFound.team)) {
          throw new ForbiddenError('You do not have access to this build');
        }
        const query = { build: buildFound._id };
        if (executionIds) {
          const executionIdArray = executionIds.split(',');
          query._id = { $in: executionIdArray };
        }
        return TestExecution.find(query).lean();
      })
      .then((executionsFound) => res.status(200).send(executionsFound))
      .catch((err) => handleError(err, res));
  }
  // If no buildId was provided the executions are looked up by id alone, so restrict them
  // to builds belonging to the caller's teams (admins are unrestricted).
  const executionIdArray = executionIds.split(',');
  const isAdmin = req.user && req.user.role === 'admin';
  const buildQuery = isAdmin ? {} : { team: { $in: (req.user && req.user.teams) || [] } };
  return Build.find(buildQuery).select('_id').lean()
    .then((builds) => {
      const query = { _id: { $in: executionIdArray } };
      if (!isAdmin) {
        query.build = { $in: builds.map((build) => build._id) };
      }
      return TestExecution.find(query).lean();
    })
    .then((testExecutions) => res.status(200).send(testExecutions))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  return TestExecution.findById(executionId).lean()
    .then(async (testExecution) => {
      if (!testExecution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      await assertExecutionAccess(req.user, testExecution);
      return res.status(200).send(testExecution);
    }).catch((err) => handleError(err, res));
};

exports.findHistory = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  return TestExecution.findById(executionId)
    .populate('build')
    .lean()
    .then((testExecution) => {
      if (!testExecution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      const limit = parseInt(req.query.limit, 10) || 20;
      const skip = parseInt(req.query.skip, 10) || 0;

      const teamId = testExecution.build ? testExecution.build.team : null;
      if (!teamId) {
        throw new NotFoundError(`No team associated with build for execution ${executionId}`);
      }
      // The history spans every build for this team, so the caller must have team access.
      if (!authMiddleware.hasTeamAccess(req.user, teamId)) {
        throw new ForbiddenError('You do not have access to this execution');
      }

      return Build.find({ team: teamId }).select('_id').lean().exec()
        .then((builds) => {
          const buildIds = builds.map((b) => b._id);
          const query = {
            build: { $in: buildIds },
            title: testExecution.title,
            suite: testExecution.suite,
          };

          const promises = [
            TestExecution.find(query, null, {
              sort: { _id: -1 },
              limit,
              skip,
            })
              .populate('build')
              .lean(),
            TestExecution.countDocuments(query)
              .exec(),
          ];
          return Promise.all(promises);
        });
    })
    .then((results) => {
      const executions = results[0];
      const count = results[1];
      const response = { executions, count };
      return res.status(200).send(response);
    })
    .catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  const { name } = req.body;
  // Fetch before updating: findByIdAndUpdate would write before access could be checked.
  return TestExecution.findById(executionId).lean()
    .then(async (existingExecution) => {
      if (!existingExecution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      await assertExecutionAccess(req.user, existingExecution);
      return TestExecution.findByIdAndUpdate(executionId, { name }, { new: true });
    })
    .then((testExecution) => res.status(200).send(testExecution))
    .catch((err) => handleError(err, res));
};

exports.setPlatform = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  const { platforms } = req.body;
  // Fetch before updating: findByIdAndUpdate would write before access could be checked.
  return TestExecution.findById(executionId).lean()
    .then(async (existingExecution) => {
      if (!existingExecution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      await assertExecutionAccess(req.user, existingExecution);
      return TestExecution.findByIdAndUpdate(executionId, { platforms }, { new: true });
    })
    .then((execution) => res.status(200).send(execution))
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { executionId } = req.params;
  return TestExecution.findById(executionId)
    .populate('build')
    .then((execution) => {
      if (!execution) {
        throw new NotFoundError(`Execution not found with id ${executionId}`);
      }
      if (!authMiddleware.hasTeamLeadAccess(req.user, execution.build.team)) {
        throw new ForbiddenError('You do not have permission to delete this execution');
      }
      return TestExecution.findByIdAndRemove(executionId);
    })
    .then((testExecution) => res.status(200).send({ message: 'Test execution deleted successfully!' }))
    .catch((err) => handleError(err, res));
};
