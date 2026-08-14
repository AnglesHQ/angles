const debug = require('debug');
// eslint-disable-next-line import/extensions
const { version } = require('../../package.json');
const registry = require('../utils/prometheus-registry.js');
const httpMetrics = require('../utils/http-metrics.js');
const resourceMetrics = require('../utils/resource-metrics.js');
const domainMetrics = require('../utils/domain-metrics.js');

const log = debug('metrics:prometheus');

// The exposition format's content type. Prometheus content-negotiates, but this exact
// string (version included) is what it expects for the text format.
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

// Walking the screenshots/compares trees is O(files), so it is opt-in. The
// filesystem-level gauges (from statfs) are always on and are usually what you want.
const DIRECTORY_SIZES_ENABLED = process.env.ANGLES_METRICS_DISK_USAGE === 'true';

// Counts failed collection passes so a scrape serving stale cached values is detectable.
let collectionErrors = 0;

const bytesGauge = (name, help, samples) => ({
  name, type: 'gauge', help, samples,
});

/** Builds the resource (CPU/memory/disk) metric families. */
const resourceFamilies = (resources) => {
  const { process: proc, host, disk } = resources;
  const families = [
    {
      name: 'angles_process_cpu_user_seconds_total',
      type: 'counter',
      help: 'Total user CPU time spent by the Angles process, in seconds.',
      samples: [{ value: proc.cpuUserSeconds }],
    },
    {
      name: 'angles_process_cpu_system_seconds_total',
      type: 'counter',
      help: 'Total system CPU time spent by the Angles process, in seconds.',
      samples: [{ value: proc.cpuSystemSeconds }],
    },
    {
      name: 'angles_process_cpu_usage_percent',
      type: 'gauge',
      help: 'CPU used by the Angles process since the previous scrape, as a percentage of a single core.',
      samples: [{ value: proc.cpuPercent }],
    },
    bytesGauge(
      'angles_process_resident_memory_bytes',
      'Resident set size of the Angles process, in bytes.',
      [{ value: proc.residentMemoryBytes }],
    ),
    bytesGauge(
      'angles_process_heap_bytes',
      'V8 heap used and total for the Angles process, in bytes.',
      [
        { value: proc.heapUsedBytes, labels: { state: 'used' } },
        { value: proc.heapTotalBytes, labels: { state: 'total' } },
      ],
    ),
    bytesGauge(
      'angles_process_external_memory_bytes',
      'Memory held outside the V8 heap (buffers, image data), in bytes.',
      [
        { value: proc.externalBytes, labels: { type: 'external' } },
        { value: proc.arrayBuffersBytes, labels: { type: 'array_buffers' } },
      ],
    ),
    {
      name: 'angles_process_uptime_seconds',
      type: 'gauge',
      help: 'Seconds since the Angles process started.',
      samples: [{ value: proc.uptimeSeconds }],
    },
    {
      name: 'angles_event_loop_lag_seconds',
      type: 'gauge',
      help: 'Delay between a timer being due and running - the saturation signal for CPU-bound image work.',
      samples: [{ value: proc.eventLoopLagMs / 1000 }],
    },
    {
      name: 'angles_host_cpus',
      type: 'gauge',
      help: 'Number of logical CPUs visible to the host.',
      samples: [{ value: host.cpuCount }],
    },
    {
      name: 'angles_host_load_average',
      type: 'gauge',
      help: 'Host load average over 1, 5 and 15 minutes.',
      samples: [
        { value: host.loadAverage1, labels: { period: '1m' } },
        { value: host.loadAverage5, labels: { period: '5m' } },
        { value: host.loadAverage15, labels: { period: '15m' } },
      ],
    },
    bytesGauge(
      'angles_host_memory_bytes',
      'Total and free memory on the host, in bytes.',
      [
        { value: host.totalMemoryBytes, labels: { state: 'total' } },
        { value: host.freeMemoryBytes, labels: { state: 'free' } },
      ],
    ),
  ];

  // Filesystem gauges, labelled by the volume they describe. Both directories are their
  // own Docker VOLUME and may sit on different filesystems.
  const diskSamples = [];
  Object.entries(disk).forEach(([volume, usage]) => {
    diskSamples.push({ value: usage.total, labels: { volume, state: 'total' } });
    diskSamples.push({ value: usage.used, labels: { volume, state: 'used' } });
    diskSamples.push({ value: usage.available, labels: { volume, state: 'available' } });
  });
  families.push(bytesGauge(
    'angles_disk_bytes',
    'Filesystem capacity, used and available bytes for the screenshot and compare volumes.',
    diskSamples,
  ));

  // Opt-in directory walk: how much of the disk Angles itself is responsible for.
  const directorySizeSamples = [];
  const directoryFileSamples = [];
  Object.entries(resources.directories).forEach(([volume, usage]) => {
    directorySizeSamples.push({ value: usage.bytes, labels: { volume } });
    directoryFileSamples.push({ value: usage.files, labels: { volume } });
  });
  families.push(bytesGauge(
    'angles_storage_bytes',
    'Bytes stored by Angles in the screenshot and compare directories (requires ANGLES_METRICS_DISK_USAGE=true).',
    directorySizeSamples,
  ));
  families.push({
    name: 'angles_storage_files',
    type: 'gauge',
    help: 'Number of files stored in the screenshot and compare directories (requires ANGLES_METRICS_DISK_USAGE=true).',
    samples: directoryFileSamples,
  });

  return families;
};

/** Builds the Angles domain (builds/executions/screenshots) metric families. */
const domainFamilies = (domain) => {
  const buildStatusSamples = [];
  domain.builds.byStatus.forEach((count, status) => {
    buildStatusSamples.push({ value: count, labels: { status } });
  });
  const executionStatusSamples = [];
  domain.executions.byStatus.forEach((count, status) => {
    executionStatusSamples.push({ value: count, labels: { status } });
  });

  return [
    {
      name: 'angles_builds',
      type: 'gauge',
      help: 'Number of builds stored, by status.',
      samples: buildStatusSamples,
    },
    {
      name: 'angles_builds_by_team',
      type: 'gauge',
      help: 'Number of builds stored, by team, environment and status.',
      samples: domain.builds.byTeam.map((entry) => ({
        value: entry.count,
        labels: { team: entry.team, environment: entry.environment, status: entry.status },
      })),
    },
    {
      name: 'angles_executions',
      type: 'gauge',
      help: 'Number of test executions stored, by status.',
      samples: executionStatusSamples,
    },
    {
      name: 'angles_screenshots',
      type: 'gauge',
      help: 'Number of screenshots stored.',
      samples: [{ value: domain.screenshots.total }],
    },
    {
      name: 'angles_screenshots_with_phash',
      type: 'gauge',
      help: 'Screenshots that have a perceptual hash - image-engine coverage of the stored set.',
      samples: [{ value: domain.screenshots.withPhash }],
    },
    {
      name: 'angles_baselines',
      type: 'gauge',
      help: 'Number of visual baselines configured.',
      samples: [{ value: domain.screenshots.baselines }],
    },
    {
      name: 'angles_last_build_timestamp_seconds',
      type: 'gauge',
      help: 'Unix timestamp of the most recent build per team - alert on time() - this to detect a silent pipeline.',
      samples: domain.freshness.map((entry) => ({
        value: entry.lastBuildTimestamp,
        labels: { team: entry.team },
      })),
    },
    {
      name: 'angles_entities',
      type: 'gauge',
      help: 'Number of configured Angles entities, by type.',
      samples: [
        { value: domain.teams, labels: { type: 'team' } },
        { value: domain.components, labels: { type: 'component' } },
        { value: domain.environments, labels: { type: 'environment' } },
        { value: domain.phases, labels: { type: 'phase' } },
        { value: domain.users, labels: { type: 'user' } },
      ],
    },
  ];
};

/** Builds the HTTP request (RED) metric families. */
const httpFamilies = (http) => [
  {
    name: 'angles_http_requests_total',
    type: 'counter',
    help: 'Total HTTP requests handled, by method, matched route and status code.',
    samples: http.counts,
  },
  {
    name: 'angles_http_requests_in_flight',
    type: 'gauge',
    help: 'HTTP requests currently being handled.',
    samples: [{ value: http.inFlight }],
  },
  {
    name: 'angles_http_request_duration_seconds',
    type: 'histogram',
    help: 'HTTP request latency, by method, matched route and status code.',
    bounds: httpMetrics.DURATION_BUCKETS,
    series: http.durations,
  },
];

/**
 * GET /metrics - the Prometheus scrape endpoint.
 *
 * Always returns 200 with whatever could be collected. A scrape is a health signal in its
 * own right, so a failure to reach Mongo must not produce a 500 that hides the resource
 * metrics too: instead the database-dependent families are dropped,
 * `angles_database_up` goes to 0 and `angles_metrics_collection_errors_total` increments.
 */
exports.scrape = async (req, res) => {
  const families = [];
  const startedAt = process.hrtime.bigint();

  families.push({
    name: 'angles_build_info',
    type: 'gauge',
    help: 'Angles build information; the value is always 1 and the version is carried in a label.',
    samples: [{ value: 1, labels: { version, node: process.versions.node } }],
  });

  try {
    const resources = await resourceMetrics.collect(DIRECTORY_SIZES_ENABLED);
    families.push(...resourceFamilies(resources));
  } catch (err) {
    collectionErrors += 1;
    log('Resource collection failed: %s', err.message);
  }

  const databaseConnected = domainMetrics.isDatabaseConnected();
  families.push({
    name: 'angles_database_up',
    type: 'gauge',
    help: 'Whether the Mongo connection is usable (1) or not (0).',
    samples: [{ value: databaseConnected ? 1 : 0 }],
  });

  if (databaseConnected) {
    try {
      const domain = await domainMetrics.collect();
      families.push(...domainFamilies(domain));
      families.push({
        name: 'angles_metrics_cache_age_seconds',
        type: 'gauge',
        help: 'Age of the cached domain metrics; grows past the TTL when collection is failing.',
        samples: [{ value: (Date.now() - domain.collectedAt) / 1000 }],
      });
    } catch (err) {
      collectionErrors += 1;
      log('Domain collection failed: %s', err.message);
    }
  }

  families.push(...httpFamilies(httpMetrics.snapshot()));

  families.push({
    name: 'angles_metrics_collection_errors_total',
    type: 'counter',
    help: 'Collection passes that failed since start-up; a non-zero rate means these metrics are stale.',
    samples: [{ value: collectionErrors }],
  });
  families.push({
    name: 'angles_metrics_scrape_duration_seconds',
    type: 'gauge',
    help: 'Time taken to build this scrape response.',
    samples: [{ value: Number(process.hrtime.bigint() - startedAt) / 1e9 }],
  });

  res.set('Content-Type', CONTENT_TYPE);
  // Scrape responses are point-in-time samples and must never be served from a cache.
  res.set('Cache-Control', 'no-store');
  return res.status(200).send(registry.render(families));
};

/** Test helper - resets the error counter. */
exports.resetCollectionErrors = () => {
  collectionErrors = 0;
};

exports.CONTENT_TYPE = CONTENT_TYPE;
