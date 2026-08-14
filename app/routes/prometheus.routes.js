const crypto = require('crypto');
const debug = require('debug');
const prometheusController = require('../controllers/prometheus.controller.js');

const log = debug('metrics:prometheus');

/**
 * The scrape endpoint is mounted at the root (`/metrics`), *outside* `/rest/api/v1.0`, so
 * it is not covered by the session/API-key middleware that protects the rest of the API.
 * That is deliberate - Prometheus cannot hold a session cookie and the existing
 * `/rest/api/v1.0/metrics` routes explicitly reject API tokens - but it means this route
 * has to bring its own access control.
 *
 * Three modes, chosen by environment:
 *   ANGLES_METRICS_TOKEN=<secret>  bearer token required (recommended)
 *   ANGLES_METRICS_PUBLIC=true     no auth; only for a network where the port is not
 *                                  reachable from outside (a Kubernetes ClusterIP, a
 *                                  docker network with no published port)
 *   neither                        endpoint returns 404 - disabled by default
 *
 * Defaulting to disabled rather than public is the important part: the scrape body
 * carries team and environment names, and enabling it must be a deliberate act.
 */
const metricsToken = process.env.ANGLES_METRICS_TOKEN;
const metricsPublic = process.env.ANGLES_METRICS_PUBLIC === 'true';

/**
 * Compares the presented token against the configured one in constant time.
 *
 * Both sides are hashed to a fixed 32 bytes first: `crypto.timingSafeEqual` throws when
 * the two buffers differ in length, and comparing lengths beforehand would itself leak
 * the token length.
 */
const tokenMatches = (presented, expected) => {
  const presentedHash = crypto.createHash('sha256').update(presented).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(presentedHash, expectedHash);
};

/** Extracts the token from `Authorization: Bearer <token>` or the `x-metrics-token` header. */
const presentedToken = (req) => {
  const { authorization } = req.headers;
  if (authorization && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim();
  }
  const header = req.headers['x-metrics-token'];
  return typeof header === 'string' ? header.trim() : null;
};

const authorizeScrape = (req, res, next) => {
  if (metricsPublic) {
    return next();
  }
  const presented = presentedToken(req);
  // `metricsToken` is always set here when the route is mounted, but the guard is kept
  // explicit so an unconfigured token can never be treated as "matches anything".
  if (metricsToken && presented && tokenMatches(presented, metricsToken)) {
    return next();
  }
  // `WWW-Authenticate` so the 401 is a well-formed challenge; Prometheus' bearer_token
  // config responds to it correctly.
  res.set('WWW-Authenticate', 'Bearer realm="angles-metrics"');
  return res.status(401).json({ error: 'Unauthorized. A valid metrics token is required.' });
};

module.exports = (app) => {
  if (!metricsToken && !metricsPublic) {
    log('Prometheus metrics endpoint is disabled (set ANGLES_METRICS_TOKEN or ANGLES_METRICS_PUBLIC)');
    return;
  }
  if (metricsPublic && !metricsToken) {
    log('Prometheus metrics endpoint is exposed without authentication (ANGLES_METRICS_PUBLIC=true)');
  }
  app.get('/metrics', authorizeScrape, prometheusController.scrape);
};

module.exports.authorizeScrape = authorizeScrape;
module.exports.tokenMatches = tokenMatches;
