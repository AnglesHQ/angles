const { validationResult } = require('express-validator');
const debug = require('debug');
const groupingUtils = require('../utils/grouping-utils.js');

const Build = require('../models/build.js');
const { Team } = require('../models/team.js');
// const Environment = require('../models/environment.js');
// const Screenshot = require('../models/screenshot.js');
const Execution = require('../models/execution.js');
const { handleError, NotFoundError } = require('../exceptions/errors.js');
// const Baseline = require('../models/baseline.js');
// const Phase = require('../models/phase.js');

const log = debug('metrics:controller');

/**
 * 1. Metrics per test phase (and period e.g. sprint).
 * 2. Metrics per platform (e.g. last week, month, quarter).
 * 3. Exceptions metrics (e.g. last period).
 * 10. Could: Metrics per component artifact?
 *
 * GRAPHS:
 *  - Grouped by Test Phase (Documented)
 *  - Grouped by Platform
 *  - Environment
 *  - Across Teams? - No, not yet.
 *  - Grouped by Date (and sprint?).
 *  - Number of unique test cases + how often executed?
 *  - Pyramid (Testing).
 *  - Date range and group by period
 *  - Coverage for component Id.
 *  - Number of runs (per phase?)
 *  - Unique Test Cases
 *  - Number of Executions
 */

/**
 * Execution Metrics (defined)
 *    - Criteria: teamId & component (optional)
 *    - Criteria: start/end date.
 *    - Criteria: groupingPeriod (e.g. 7 days, 14 days, 30 days, 90 days).
 *    - Grouping: Period
 *       - Grouping: Phase
 *          - Test Case Count (unique).
 *          - Grouping: Daily
 *            - Results
 *            - Number of Builds
 *            - Number of Executions
 *            - Execution Time
 */
exports.retrieveMetricsPerPhase = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(422).json({ errors: errors.array() });
  }
  const metrics = {};
  const {
    teamId,
    componentId,
    fromDate,
    toDate,
    groupingPeriod,
  } = req.query;
  let query = {};
  Team.findById({ _id: teamId })
    .then((teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${teamId}`);
      }
      const buildQuery = { team: teamFound._id };
      if (componentId) {
        // match componentId with name (and add it to query)
        teamFound.components.forEach((component) => {
          if (component.id === componentId) {
            buildQuery.component = component._id;
          }
        });
      }
      let fromDateJS = new Date();
      if (fromDate) {
        fromDateJS = new Date(fromDate);
      }
      fromDateJS.setHours(0, 0, 0, 0);
      metrics.fromDate = fromDateJS;
      buildQuery.start = { $gte: fromDateJS };

      // set toDate if provided or today if not
      let toDateJS = new Date();
      if (toDate) {
        toDateJS = new Date(toDate);
      }
      toDateJS.setHours(23, 59, 59, 0);
      metrics.toDate = toDateJS;
      buildQuery.end = { $lt: toDateJS };

      metrics.groupingPeriod = groupingPeriod;

      return Build.find(buildQuery);
    })
    .then((builds) => {
      const buildIds = builds.map((build) => build._id);
      const match = { build: { $in: buildIds } };
      log(`Query match ${match}n`);
      query = [
        { $match: match },
        { $addFields: { buildId: { $toString: '$build' } } },
        {
          $lookup: {
            from: 'builds',
            localField: 'build',
            foreignField: '_id',
            as: 'build',
          },
        },
        { $unwind: '$build' },
        {
          $lookup: {
            from: 'environments',
            localField: 'build.environment',
            foreignField: '_id',
            as: 'environment',
          },
        },
        { $unwind: '$environment' },
        {
          $lookup: {
            from: 'teams',
            localField: 'build.team',
            foreignField: '_id',
            as: 'team',
          },
        },
        { $unwind: '$team' },
        { $addFields: { componentId: { $toString: '$build.component' } } },
        {
          $lookup: {
            from: 'phases',
            localField: 'build.phase',
            foreignField: '_id',
            as: 'phase',
          },
        },
        // { $addFields: { phase: { $ifNull: ['$phase', 'default'] } } },
        // { $unwind: '$phase' },
        { $addFields: { length: { $subtract: ['$end', '$start'] } } },
        {
          $addFields: {
            component: {
              $function: {
                body: 'function(componentId, team){ return team.components.find((component) => component._id.str === componentId ) }',
                args: ['$componentId', '$team'],
                lang: 'js',
              },
            },
          },
        },
        { $unset: ['build', 'actions', 'componentId', 'team.components'] },
      ];
      return Execution.aggregate(query);
    })
    .then((executionsDetails) => {
      metrics.periods = groupingUtils.groupExecutionsByPeriod(
        metrics.fromDate,
        metrics.toDate,
        groupingPeriod,
        executionsDetails,
        'start',
      );
      metrics.periods.forEach((currentPeriod) => {
        const period = currentPeriod;
        period.result = { TOTAL: 0 };
        period.buildIds = new Set();
        const { items: executions } = period;
        executions.map((execution) => {
          if (execution.phase.length === 0) {
            // eslint-disable-next-line no-param-reassign
            execution.phase = 'default';
          } else {
            // eslint-disable-next-line no-param-reassign,prefer-destructuring
            execution.phase = execution.phase[0].name;
          }
          return execution;
        });
        const phaseNames = [...new Set(executions.map((execution) => execution.phase))];
        period.phases = [];
        phaseNames.forEach((phaseName) => {
          period.phases.push({
            name: phaseName,
            tests: new Set(),
            buildIds: new Set(),
            result: { TOTAL: 0 },
            executions: [],
          });
        });
        executions.forEach((execution) => {
          if (period.result[execution.status] === undefined) {
            period.result[execution.status] = 0;
          }
          period.result[execution.status] += 1;
          period.result.TOTAL += 1;

          const phaseGroup = period.phases.find((phase) => phase.name === execution.phase);
          if (phaseGroup.result[execution.status] === undefined) {
            phaseGroup.result[execution.status] = 0;
          }
          phaseGroup.result[execution.status] += 1;
          phaseGroup.result.TOTAL += 1;
          phaseGroup.executions.push(execution);

          phaseGroup.tests.add(`${execution.suite}.${execution.title}`);
          period.buildIds.add(execution.buildId);
          phaseGroup.buildIds.add(execution.buildId);
        });
        period.buildIds = Array.from(period.buildIds);
        period.buildCount = period.buildIds.length;

        period.phases.forEach((phaseGroup) => {
          const currentPhase = phaseGroup;
          currentPhase.tests = Array.from(currentPhase.tests);
          currentPhase.buildIds = Array.from(currentPhase.buildIds);
          currentPhase.buildCount = currentPhase.buildIds.length;
          delete currentPhase.buildIds;
        });
        delete period.items;
        delete period.buildIds;
      });
      res.status(200).send(metrics);
    })
    .catch((err) => {
      handleError(err, res);
    });
};

/**
 * Platform Metrics
 *    - Criteria: teamId & component (optional)
 *    - Criteria: start/end date.
 *    - Criteria: groupingPeriod (e.g. 7 days, 14 days, 30 days, 90 days).
 *    - Grouping: Period
 *       - Grouping: Platform
 *          - Results
 *          - Number of Executions
 *          - Execution Time
 *          - Grouping: Version
 *           - Results
 *           - Number of Executions
 *           - Execution Time
 */

/**
 * Device Metrics
 *    - Criteria: teamId & component (optional)
 *    - Criteria: start/end date.
 *    - Criteria: groupingPeriod (e.g. 7 days, 14 days, 30 days, 90 days).
 *    - Grouping: Period
 *       - Grouping: Platform
 *          - Results
 *          - Number of Executions
 *          - Execution Time
 *          - Grouping: Device
 *           - Results
 *           - Number of Executions
 *           - Execution Time
 */
