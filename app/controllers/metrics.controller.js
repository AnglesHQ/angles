const { validationResult } = require('express-validator');
const mongoose = require('mongoose');
const debug = require('debug');

const Build = require('../models/build.js');
const { Team } = require('../models/team.js');
// const Environment = require('../models/environment.js');
// const Screenshot = require('../models/screenshot.js');
// const Execution = require('../models/execution.js');
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
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    teamId,
    componentId,
    fromDate,
    toDate,
  } = req.query;
  let query = {};
  return Team.findById({ _id: teamId })
    .then((teamFound) => {
      if (!teamFound) {
        return res.status(404).send({
          message: `No team found with name ${req.body.team}`,
        });
      }
      const match = { team: teamFound._id };
      if (componentId) {
        // match componentId with name (and add it to query)
        teamFound.components.forEach((component) => {
          if (component.id === componentId) {
            match.component = component._id;
          }
        });
      }
      if (fromDate) {
        const fromDateJS = new Date(fromDate);
        fromDateJS.setHours(0, 0, 0, 0);
        match.start = { $gte: fromDateJS };
      }
      if (toDate) {
        const toDateJS = new Date(toDate);
        toDateJS.setHours(23, 59, 59, 0);
        match.end = { $lt: toDateJS };
      }
      query = [
        { $match: match },
        {
          $lookup: {
            from: 'teams',
            localField: 'team',
            foreignField: '_id',
            as: 'team',
          },
        },
        { $unwind: '$team' },
        {
          $lookup: {
            from: 'environments',
            localField: 'environment',
            foreignField: '_id',
            as: 'environment',
          },
        },
        { $unwind: '$environment' },
        {
          $lookup: {
            from: 'testexecutions',
            localField: 'suites.executions',
            foreignField: '_id',
            as: 'suites.executions',
          },
        },
        { $unset: 'suites.executions.actions' },
        { $unwind: '$suites.executions' },
        { $addFields: { execution: '$suites.executions' } },
        { $addFields: { phase: { $ifNull: ['$phase.name', 'default'] }, date: { $dateToString: { format: '%Y-%m-%d', date: '$execution.start' } } } },
        { $addFields: { 'execution.length': { $subtract: ['$execution.end', '$execution.start'] } } },
        { $addFields: { componentId: { $toString: '$component' } } },
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
        { $unset: ['suites', 'result', 'status', 'componentId', 'start', 'end'] },
      ];
      return Build.aggregate(query)
        .then((aggregateResult) => {
          const metrics = {};
          metrics.results = {};
          metrics.phase = {};
          metrics.tests = new Set();
          aggregateResult.forEach((aggregate) => {
            const { execution } = aggregate;
            log(execution);
            if (metrics.results[execution.status] === undefined) {
              metrics.results[execution.status] = 0;
            }
            metrics.results[execution.status] += 1;
            metrics.tests.add(`${execution.suite}.${execution.title}`);
          });
          metrics.tests = Array.from(metrics.tests);
          return res.status(200).send(metrics);
        });
    })
    .catch((err) => {
      res.status(500).send({
        message: err.message || 'Unable to retrieve builds.',
      });
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
