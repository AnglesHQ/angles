const mongoose = require('mongoose');
const debug = require('debug');

const Build = require('../models/build.js');
const Execution = require('../models/execution.js');
const Screenshot = require('../models/screenshot.js');
const Baseline = require('../models/baseline.js');
const Environment = require('../models/environment.js');
const Phase = require('../models/phase.js');
const User = require('../models/user.js');
const { Team } = require('../models/team.js');

const log = debug('metrics:domain');

/**
 * Domain metrics are aggregations over whole collections, so they are far too expensive
 * to run on every scrape - Prometheus defaults to one every 15s, and Angles installs can
 * hold millions of executions. They are therefore cached for a TTL (default 60s) that
 * should be set *below* the scrape interval's usefulness threshold but above its
 * frequency; a stale-by-a-minute build count is fine, a Mongo aggregation storm is not.
 */
const CACHE_TTL_MS = parseInt(process.env.ANGLES_METRICS_CACHE_TTL_MS, 10) || 60000;

// Cardinality guard. Per-team/per-environment series are the most useful domain metrics
// Angles can expose, but they multiply: teams x environments x statuses. Installs with a
// large number of teams can lower this, and setting it to 0 disables the labelled
// breakdowns entirely while keeping the cheap global totals.
const MAX_LABEL_SERIES = (() => {
  const parsed = parseInt(process.env.ANGLES_METRICS_MAX_SERIES, 10);
  return Number.isFinite(parsed) ? parsed : 200;
})();

let cache = { expires: 0, value: null };
// Concurrent scrapes (or a scrape landing while a refresh is in flight) share one
// collection pass rather than each starting their own.
let inFlight = null;

const resetCache = () => {
  cache = { expires: 0, value: null };
  inFlight = null;
};

/**
 * Builds a lookup of ObjectId -> name so the aggregations below can label their series
 * without a $lookup per collection (cheaper, and it keeps the pipelines simple).
 */
const buildNameMap = (documents) => {
  const map = new Map();
  documents.forEach((doc) => map.set(doc._id.toString(), doc.name));
  return map;
};

/**
 * Counts builds grouped by team, environment and status, plus the global totals.
 * The heavy lifting is a single `$group` on indexed fields.
 */
const collectBuildMetrics = async (teamNames, environmentNames) => {
  const grouped = await Build.aggregate([
    {
      $group: {
        _id: { team: '$team', environment: '$environment', status: '$status' },
        count: { $sum: 1 },
      },
    },
  ]);

  const byStatus = new Map();
  // Mongo groups by *id*, but the metric is labelled by *name*. Deleted teams and
  // environments all resolve to the same "unknown" label, so several distinct id groups
  // collapse onto one label set and have to be re-summed here. Emitting them separately
  // would put duplicate series in the scrape body, which Prometheus rejects outright -
  // failing the whole scrape, not just the offending metric.
  const byLabels = new Map();
  let total = 0;

  grouped.forEach((group) => {
    const { team, environment, status } = group._id;
    total += group.count;
    byStatus.set(status, (byStatus.get(status) || 0) + group.count);

    const entry = {
      team: teamNames.get(team ? team.toString() : '') || 'unknown',
      environment: environmentNames.get(environment ? environment.toString() : '') || 'unknown',
      status: status || 'unknown',
    };
    const key = `${entry.team} ${entry.environment} ${entry.status}`;
    const existing = byLabels.get(key);
    if (existing) {
      existing.count += group.count;
    } else {
      byLabels.set(key, { ...entry, count: group.count });
    }
  });

  return { total, byStatus, byTeam: Array.from(byLabels.values()) };
};

/**
 * Counts executions by status. Executions are the largest collection in an Angles
 * install, so this is a single `$group` with no lookups; the per-team breakdown would
 * need a join against builds and is deliberately left out.
 */
const collectExecutionMetrics = async () => {
  const grouped = await Execution.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const byStatus = new Map();
  let total = 0;
  grouped.forEach((group) => {
    total += group.count;
    byStatus.set(group._id || 'unknown', group.count);
  });
  return { total, byStatus };
};

/**
 * The age of the most recent build, per team. This is the metric that detects a *silent*
 * CI pipeline: builds are not arriving any more, which no error-rate alert would catch
 * because nothing is failing - nothing is happening at all.
 */
const collectFreshnessMetrics = async (teamNames) => {
  const latest = await Build.aggregate([
    { $group: { _id: '$team', lastBuild: { $max: '$createdAt' } } },
  ]);
  // As in collectBuildMetrics: every deleted team resolves to the "unknown" label, so the
  // id-keyed groups have to be merged by name to avoid duplicate series. For a max-date
  // metric, merging means keeping the most recent of the collapsed group.
  const byTeamName = new Map();
  latest
    .filter((entry) => entry.lastBuild)
    .forEach((entry) => {
      const team = teamNames.get(entry._id ? entry._id.toString() : '') || 'unknown';
      // Emitted as a unix timestamp rather than an age in seconds: a timestamp is correct
      // regardless of when it is evaluated, and `time() - metric` in PromQL gives the age.
      const lastBuildTimestamp = new Date(entry.lastBuild).getTime() / 1000;
      const existing = byTeamName.get(team);
      if (!existing || lastBuildTimestamp > existing.lastBuildTimestamp) {
        byTeamName.set(team, { team, lastBuildTimestamp });
      }
    });
  return Array.from(byTeamName.values());
};

/** Screenshot counts, plus how many carry a perceptual hash (image-engine coverage). */
const collectScreenshotMetrics = async () => {
  const [total, withPhash, baselines] = await Promise.all([
    Screenshot.estimatedDocumentCount(),
    // A real count rather than an estimate: this one is a filtered subset.
    Screenshot.countDocuments({ phash: { $exists: true, $ne: null } }),
    Baseline.estimatedDocumentCount(),
  ]);
  return { total, withPhash, baselines };
};

/**
 * Truncates a labelled series list to the cardinality budget, newest/largest first, so an
 * install with hundreds of teams degrades to its most significant series instead of
 * flooding Prometheus.
 */
const capSeries = (series, sortKey) => {
  if (MAX_LABEL_SERIES <= 0) {
    return [];
  }
  if (series.length <= MAX_LABEL_SERIES) {
    return series;
  }
  log('Capping %d series to %d', series.length, MAX_LABEL_SERIES);
  return [...series]
    .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0))
    .slice(0, MAX_LABEL_SERIES);
};

/** Runs every collection pass. Not exported directly - go through `collect`. */
const refresh = async () => {
  const [teams, environments] = await Promise.all([
    Team.find({}).select('_id name').lean(),
    Environment.find({}).select('_id name').lean(),
  ]);
  const teamNames = buildNameMap(teams);
  const environmentNames = buildNameMap(environments);

  const [
    builds,
    executions,
    screenshots,
    freshness,
    phaseCount,
    userCount,
  ] = await Promise.all([
    collectBuildMetrics(teamNames, environmentNames),
    collectExecutionMetrics(),
    collectScreenshotMetrics(),
    collectFreshnessMetrics(teamNames),
    Phase.estimatedDocumentCount(),
    User.estimatedDocumentCount(),
  ]);

  return {
    builds: { ...builds, byTeam: capSeries(builds.byTeam, 'count') },
    executions,
    screenshots,
    freshness: capSeries(freshness, 'lastBuildTimestamp'),
    teams: teams.length,
    // Components live inside the team document, so this needs no extra query.
    components: teams.reduce((sum, team) => sum + (team.components || []).length, 0),
    environments: environments.length,
    phases: phaseCount,
    users: userCount,
    collectedAt: Date.now(),
  };
};

/**
 * Returns the domain metrics, refreshing them when the cached copy has expired.
 *
 * A failed refresh does not clear the cache: serving metrics that are a few minutes stale
 * is far better than a scrape that returns nothing, and the accompanying
 * `angles_metrics_collection_errors_total` counter is what makes the staleness visible.
 *
 * @param {Boolean} force - bypass the TTL (used by tests)
 */
const collect = async (force = false) => {
  if (!force && cache.value && Date.now() < cache.expires) {
    return { ...cache.value, cached: true };
  }
  if (inFlight) {
    return inFlight;
  }
  inFlight = refresh()
    .then((value) => {
      cache = { expires: Date.now() + CACHE_TTL_MS, value };
      return { ...value, cached: false };
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

/** Whether Mongo is currently usable; 1 === connected in mongoose's readyState enum. */
const isDatabaseConnected = () => mongoose.connection.readyState === 1;

module.exports = {
  collect,
  resetCache,
  isDatabaseConnected,
  CACHE_TTL_MS,
  MAX_LABEL_SERIES,
};
