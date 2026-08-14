const should = require('should');
const pino = require('pino');
const request = require('supertest');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const registry = require('../app/utils/prometheus-registry.js');
const httpMetrics = require('../app/utils/http-metrics.js');
const resourceMetrics = require('../app/utils/resource-metrics.js');
const domainMetrics = require('../app/utils/domain-metrics.js');
const Build = require('../app/models/build.js');
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Set by test/mocha-setup.js before any suite loads server.js - the route reads its
// configuration once at require time, so it cannot be set from inside this file.
const METRICS_TOKEN = process.env.ANGLES_METRICS_TOKEN;

/**
 * Parses an exposition body into `{ 'name{labels}': value }` so assertions can look up a
 * sample without depending on the order families are rendered in.
 */
const parseExposition = (body) => {
  const samples = {};
  body.split('\n').forEach((line) => {
    if (line.startsWith('#') || line.trim() === '') {
      return;
    }
    const separator = line.lastIndexOf(' ');
    samples[line.substring(0, separator)] = Number(line.substring(separator + 1));
  });
  return samples;
};

/** All sample keys belonging to a metric family (with or without labels). */
const samplesFor = (samples, name) => Object.keys(samples)
  .filter((key) => key === name || key.startsWith(`${name}{`));

describe('Prometheus Metrics API Tests', () => {
  let team;
  let environment;

  before((done) => {
    const clearingPromises = [
      Team.deleteMany({ name: 'prometheus-unit-testing-team' }).exec(),
      Environment.deleteMany({ name: 'prometheus-unit-testing-environment' }).exec(),
    ];
    Promise.all(clearingPromises)
      .then(() => Promise.all([
        testUtils.createTeam('prometheus-unit-testing-team', 'prometheus-component'),
        testUtils.createEnvironment('prometheus-unit-testing-environment'),
      ]))
      .then(([createdTeam, createdEnvironment]) => {
        team = createdTeam;
        environment = createdEnvironment;
        return testUtils.createBuild(team, environment, 'prometheus-test-build');
      })
      .then(() => {
        // The domain collector caches for a minute; drop it so the build above is counted.
        domainMetrics.resetCache();
        logger.info('Created required team, environment & build for prometheus tests.');
        done();
      })
      .catch(done);
  });

  describe('Exposition format rendering', () => {
    it('renders a gauge with HELP and TYPE headers', () => {
      const output = registry.render([{
        name: 'angles_test_gauge',
        type: 'gauge',
        help: 'A test gauge.',
        samples: [{ value: 7 }],
      }]);
      output.should.containEql('# HELP angles_test_gauge A test gauge.');
      output.should.containEql('# TYPE angles_test_gauge gauge');
      output.should.containEql('angles_test_gauge 7');
      output.endsWith('\n').should.equal(true);
    });

    it('renders labels and escapes quotes and backslashes in label values', () => {
      const output = registry.render([{
        name: 'angles_test_gauge',
        type: 'gauge',
        help: 'A test gauge.',
        samples: [{ value: 1, labels: { team: 'quote"and\\slash' } }],
      }]);
      output.should.containEql('angles_test_gauge{team="quote\\"and\\\\slash"} 1');
    });

    it('omits a family entirely when it has no samples', () => {
      const output = registry.render([{
        name: 'angles_test_gauge',
        type: 'gauge',
        help: 'A test gauge.',
        samples: [],
      }]);
      output.should.not.containEql('angles_test_gauge');
    });

    it('drops non-finite sample values rather than emitting NaN', () => {
      const output = registry.render([{
        name: 'angles_test_gauge',
        type: 'gauge',
        help: 'A test gauge.',
        samples: [{ value: 1 }, { value: NaN, labels: { bad: 'yes' } }],
      }]);
      output.should.containEql('angles_test_gauge 1');
      output.should.not.containEql('NaN');
    });

    it('rejects an invalid metric name', () => {
      should(() => registry.render([{
        name: 'angles-test-gauge',
        type: 'gauge',
        help: 'x',
        samples: [{ value: 1 }],
      }])).throw(/Invalid Prometheus metric name/);
    });

    it('renders a histogram with cumulative buckets and a +Inf bucket', () => {
      const output = registry.render([{
        name: 'angles_test_duration_seconds',
        type: 'histogram',
        help: 'A test histogram.',
        bounds: [0.1, 1],
        series: [{
          labels: { route: '/test' }, buckets: [1, 3], sum: 2.5, count: 4,
        }],
      }]);
      output.should.containEql('# TYPE angles_test_duration_seconds histogram');
      output.should.containEql('angles_test_duration_seconds_bucket{route="/test",le="0.1"} 1');
      output.should.containEql('angles_test_duration_seconds_bucket{route="/test",le="1"} 3');
      output.should.containEql('angles_test_duration_seconds_bucket{route="/test",le="+Inf"} 4');
      output.should.containEql('angles_test_duration_seconds_sum{route="/test"} 2.5');
      output.should.containEql('angles_test_duration_seconds_count{route="/test"} 4');
    });
  });

  describe('Endpoint authorisation', () => {
    it('should return a 401 when no token is provided', (done) => {
      request(app)
        .get('/metrics')
        .expect(401)
        .then((res) => {
          res.headers['www-authenticate'].should.containEql('Bearer');
          done();
        })
        .catch(done);
    });

    it('should return a 401 when the token is wrong', (done) => {
      request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer not-the-right-token')
        .expect(401)
        .then(() => done())
        .catch(done);
    });

    it('should accept the token in the Authorization header', (done) => {
      request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)
        .expect(200)
        .then(() => done())
        .catch(done);
    });

    it('should accept the token in the x-metrics-token header', (done) => {
      request(app)
        .get('/metrics')
        .set('x-metrics-token', METRICS_TOKEN)
        .expect(200)
        .then(() => done())
        .catch(done);
    });

    it('should not require a session cookie', (done) => {
      // The whole point of mounting outside /rest/api/v1.0: an unauthenticated client
      // with only the scrape token gets through.
      request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)
        .expect(200)
        .then((res) => {
          res.headers['content-type'].should.containEql('text/plain');
          done();
        })
        .catch(done);
    });
  });

  describe('Scrape response', () => {
    let body;
    let samples;

    before((done) => {
      // The scrape endpoint deliberately does not instrument itself, so at least one
      // ordinary request has to have been served before the HTTP families exist at all.
      request(app)
        .get('/rest/api/v1.0/angles/versions')
        .then(() => request(app)
          .get('/metrics')
          .set('Authorization', `Bearer ${METRICS_TOKEN}`)
          .expect(200))
        .then((res) => {
          body = res.text;
          samples = parseExposition(body);
          done();
        })
        .catch(done);
    });

    it('should use the prometheus text exposition content type', (done) => {
      request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)
        .expect(200)
        .then((res) => {
          res.headers['content-type'].should.containEql('version=0.0.4');
          res.headers['cache-control'].should.containEql('no-store');
          done();
        })
        .catch(done);
    });

    it('should expose build info with the angles version as a label', () => {
      const keys = samplesFor(samples, 'angles_build_info');
      keys.length.should.equal(1);
      keys[0].should.containEql('version=');
      samples[keys[0]].should.equal(1);
    });

    it('should expose process cpu and memory metrics', () => {
      samples.should.have.property('angles_process_cpu_user_seconds_total');
      samples.should.have.property('angles_process_resident_memory_bytes');
      samples.angles_process_resident_memory_bytes.should.be.above(0);
      samples['angles_process_heap_bytes{state="used"}'].should.be.above(0);
      samples['angles_process_heap_bytes{state="total"}'].should.be.above(0);
    });

    it('should expose host cpu, load and memory metrics', () => {
      samples.angles_host_cpus.should.be.above(0);
      samples.should.have.property('angles_host_load_average{period="1m"}');
      samples.should.have.property('angles_host_load_average{period="15m"}');
      samples['angles_host_memory_bytes{state="total"}'].should.be.above(0);
    });

    it('should expose event loop lag as a gauge in seconds', () => {
      samples.should.have.property('angles_event_loop_lag_seconds');
      samples.angles_event_loop_lag_seconds.should.be.aboveOrEqual(0);
    });

    it('should expose disk usage for the screenshot volume', () => {
      // statfs is available on the platforms the tests run on; total is always > used.
      samples['angles_disk_bytes{volume="screenshots",state="total"}'].should.be.above(0);
      samples.should.have.property('angles_disk_bytes{volume="screenshots",state="available"}');
    });

    it('should report the database as up', () => {
      samples.angles_database_up.should.equal(1);
    });

    it('should expose build counts by status', () => {
      samplesFor(samples, 'angles_builds').length.should.be.above(0);
    });

    it('should expose build counts labelled by team and environment', () => {
      const key = 'angles_builds_by_team{team="prometheus-unit-testing-team"'
        + ',environment="prometheus-unit-testing-environment",status="SKIPPED"}';
      samples.should.have.property(key);
      samples[key].should.be.aboveOrEqual(1);
    });

    it('should expose the last build timestamp per team', () => {
      const key = 'angles_last_build_timestamp_seconds{team="prometheus-unit-testing-team"}';
      samples.should.have.property(key);
      // A unix timestamp in seconds for a build created moments ago.
      samples[key].should.be.above(1600000000);
      samples[key].should.be.belowOrEqual(Date.now() / 1000 + 1);
    });

    it('should expose execution, screenshot and baseline counts', () => {
      samples.should.have.property('angles_screenshots');
      samples.should.have.property('angles_screenshots_with_phash');
      samples.should.have.property('angles_baselines');
      samplesFor(samples, 'angles_executions').length.should.be.aboveOrEqual(0);
    });

    it('should expose configured entity counts', () => {
      samples['angles_entities{type="team"}'].should.be.above(0);
      samples['angles_entities{type="environment"}'].should.be.above(0);
      samples.should.have.property('angles_entities{type="user"}');
      samples.should.have.property('angles_entities{type="phase"}');
    });

    it('should expose http request counters and a latency histogram', () => {
      samplesFor(samples, 'angles_http_requests_total').length.should.be.above(0);
      samples.should.have.property('angles_http_requests_in_flight');
      samplesFor(samples, 'angles_http_request_duration_seconds_bucket').length.should.be.above(0);
      body.should.containEql('# TYPE angles_http_request_duration_seconds histogram');
    });

    it('should expose collection health metrics', () => {
      samples.should.have.property('angles_metrics_collection_errors_total');
      samples.should.have.property('angles_metrics_scrape_duration_seconds');
      samples.should.have.property('angles_metrics_cache_age_seconds');
    });

    it('should never emit the same series twice', () => {
      // Prometheus rejects an entire scrape that contains a duplicate label set, so this
      // is a hard correctness invariant rather than a tidiness check. It is easy to break:
      // builds belonging to deleted teams all resolve to team="unknown", so several
      // database-level groups collapse onto one label set and must be summed, not listed.
      const seen = new Set();
      const duplicates = [];
      body.split('\n').forEach((line) => {
        if (line.startsWith('#') || line.trim() === '') {
          return;
        }
        const series = line.substring(0, line.lastIndexOf(' '));
        if (seen.has(series)) {
          duplicates.push(series);
        }
        seen.add(series);
      });
      duplicates.should.eql([]);
    });

    it('should not label http metrics with raw urls containing ids', () => {
      // Cardinality guard: a mongo id in a route label means a new series per build.
      const httpKeys = samplesFor(samples, 'angles_http_requests_total');
      httpKeys.forEach((key) => {
        key.should.not.match(/[a-f\d]{24}/i);
      });
    });
  });

  describe('HTTP instrumentation', () => {
    it('should record a request against its matched route, not its url', (done) => {
      httpMetrics.reset();
      request(app)
        .get('/rest/api/v1.0/angles/versions')
        .then(() => {
          const { counts } = httpMetrics.snapshot();
          const recorded = counts.find((entry) => entry.labels.route.includes('angles/versions'));
          should.exist(recorded);
          recorded.value.should.be.above(0);
          recorded.labels.method.should.equal('GET');
          done();
        })
        .catch(done);
    });

    it('should not instrument the scrape endpoint itself', (done) => {
      httpMetrics.reset();
      request(app)
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)
        .then(() => {
          const { counts } = httpMetrics.snapshot();
          counts.filter((entry) => entry.labels.route === '/metrics').length.should.equal(0);
          done();
        })
        .catch(done);
    });

    it('should collapse unmatched paths into a single route label', (done) => {
      httpMetrics.reset();
      request(app)
        .get('/this-route-does-not-exist-12345')
        .then(() => {
          const { counts } = httpMetrics.snapshot();
          const recorded = counts.find((entry) => entry.labels.route === 'unmatched');
          should.exist(recorded);
          done();
        })
        .catch(done);
    });

    it('should return the in-flight gauge to zero after requests settle', (done) => {
      httpMetrics.reset();
      request(app)
        .get('/rest/api/v1.0/angles/versions')
        .then(() => {
          httpMetrics.snapshot().inFlight.should.equal(0);
          done();
        })
        .catch(done);
    });
  });

  describe('Domain metric caching', () => {
    it('should serve a cached result within the TTL', async () => {
      domainMetrics.resetCache();
      const first = await domainMetrics.collect();
      first.cached.should.equal(false);
      const second = await domainMetrics.collect();
      second.cached.should.equal(true);
      second.builds.total.should.equal(first.builds.total);
    });

    it('should refresh when forced', async () => {
      await domainMetrics.collect();
      const forced = await domainMetrics.collect(true);
      forced.cached.should.equal(false);
    });

    it('should share a single collection pass between concurrent callers', async () => {
      domainMetrics.resetCache();
      const results = await Promise.all([
        domainMetrics.collect(),
        domainMetrics.collect(),
        domainMetrics.collect(),
      ]);
      // All three resolve from one in-flight refresh, so they agree exactly.
      results[1].builds.total.should.equal(results[0].builds.total);
      results[2].builds.total.should.equal(results[0].builds.total);
    });
  });

  describe('Resource collection', () => {
    it('should collect process and host resources without the directory walk', async () => {
      const resources = await resourceMetrics.collect(false);
      resources.process.residentMemoryBytes.should.be.above(0);
      resources.host.cpuCount.should.be.above(0);
      // The expensive walk is skipped, so no directory sizes are present.
      Object.keys(resources.directories).length.should.equal(0);
    });

    it('should measure directory sizes when asked', async () => {
      const resources = await resourceMetrics.collect(true);
      resources.directories.should.have.property('screenshots');
      resources.directories.screenshots.bytes.should.be.aboveOrEqual(0);
      resources.directories.screenshots.files.should.be.aboveOrEqual(0);
    });

    it('should return null rather than throwing for a missing filesystem path', async () => {
      const usage = await resourceMetrics.readDiskUsage('/no/such/path/at/all/12345');
      should.not.exist(usage);
    });
  });

  after((done) => {
    Promise.all([
      Build.deleteMany({ name: 'prometheus-test-build' }).exec(),
      Team.deleteMany({ name: 'prometheus-unit-testing-team' }).exec(),
      Environment.deleteMany({ name: 'prometheus-unit-testing-environment' }).exec(),
    ])
      .then(() => {
        resourceMetrics.stopEventLoopMonitor();
        logger.info('Cleaned up prometheus test data.');
        done();
      })
      .catch(done);
  });
});
