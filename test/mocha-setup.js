/**
 * Mocha global setup, loaded via `--require` in .mocharc.json before any test file.
 *
 * The Prometheus scrape endpoint reads its configuration once, when
 * `app/routes/prometheus.routes.js` is required, and stays unregistered when no token is
 * configured. Mocha loads test files alphabetically and they all share a single
 * `server.js` instance, so whichever suite requires it first fixes that decision for the
 * whole run - setting the token inside prometheus.tests.js is already too late.
 *
 * Set here so the endpoint is enabled regardless of file ordering. Anything that is
 * already set in the environment wins, so a targeted run can still override it.
 */
process.env.ANGLES_METRICS_TOKEN = process.env.ANGLES_METRICS_TOKEN
  || 'unit-testing-metrics-token';
