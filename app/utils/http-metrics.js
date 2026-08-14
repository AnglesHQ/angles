/**
 * In-process HTTP request instrumentation.
 *
 * Counters live in module state for the lifetime of the process. That is exactly what
 * Prometheus expects of a counter: it resets to zero on restart, and PromQL's `rate()`
 * and `increase()` detect and handle that reset. Nothing here is persisted.
 */

// Route *paths* (`/rest/api/v1.0/build/:buildId`), never request URLs. A metric labelled
// with the raw URL would mint a new time series per build id, which is the classic way to
// take down a Prometheus server. Express exposes the matched route on `req.route.path`.
const requestCounts = new Map();
const requestDurations = new Map();
const inFlightGauge = { value: 0 };

// Histogram buckets in seconds. Chosen for this API's actual shape: most reads are tens
// of milliseconds, screenshot uploads and image compares are the long tail, and the image
// engine's task timeout is 120s - so the top finite bucket sits above it and anything
// slower falls into +Inf.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];

// Guard against unbounded label growth from 404s on unmatched paths, which have no route
// and would otherwise be labelled with whatever the caller sent.
const MAX_ROUTE_SERIES = 500;

const seriesKey = (method, route, status) => `${method} ${route} ${status}`;

/**
 * The route label for a request.
 *
 * `req.route` is only populated once express has entered the matched route's handler
 * chain. Angles rejects unauthenticated calls in an `app.use('/rest/api/v1.0', ...)`
 * middleware that runs *before* that, so every 401 would otherwise collapse into a single
 * `unmatched` series - losing exactly the breakdown you want when diagnosing a client
 * that is failing to authenticate.
 *
 * So when `req.route` is absent, the request is matched against the app's own router
 * stack to recover the route pattern it *would* have hit. Anything that matches no
 * declared route falls back to `unmatched` (one fixed series), so a scanner probing
 * random URLs still cannot inflate cardinality.
 */
const matchRouteFromStack = (req) => {
  // express 4 exposes the router stack only as the private `_router`; there is no public
  // accessor for it. Guarded above and below so an express upgrade that removes it
  // degrades to the `unmatched` label rather than throwing inside the middleware.
  // eslint-disable-next-line no-underscore-dangle
  const router = req.app && req.app._router;
  if (!router || !Array.isArray(router.stack)) {
    return null;
  }
  // When a request is rejected inside a mounted middleware - which is where Angles'
  // `app.use('/rest/api/v1.0', isAuthenticated)` returns its 401 - express has already
  // stripped the mount prefix from `req.path` and moved it to `req.baseUrl`. The routes in
  // the stack are declared with their full path, so the prefix has to be put back before
  // matching or nothing ever matches. `req.originalUrl` keeps the prefix but also carries
  // the query string, so it is trimmed at the first `?`.
  const [fullPath] = (req.originalUrl || `${req.baseUrl || ''}${req.path}`).split('?');
  const found = router.stack.find((layer) => layer.route
    && layer.route.methods
    && layer.route.methods[req.method.toLowerCase()]
    && layer.regexp
    && layer.regexp.test(fullPath));
  return found ? found.route.path : null;
};

const routeLabel = (req) => {
  if (req.route && req.route.path) {
    // req.baseUrl is set when the route was mounted on a router; for this app's
    // `app.get('/rest/api/v1.0/build', ...)` style it is empty and route.path is full.
    return `${req.baseUrl || ''}${req.route.path}`;
  }
  return matchRouteFromStack(req) || 'unmatched';
};

const emptyHistogram = () => ({
  buckets: new Array(DURATION_BUCKETS.length).fill(0),
  sum: 0,
  count: 0,
});

const observeDuration = (key, seconds) => {
  let histogram = requestDurations.get(key);
  if (!histogram) {
    if (requestDurations.size >= MAX_ROUTE_SERIES) {
      return;
    }
    histogram = emptyHistogram();
    requestDurations.set(key, histogram);
  }
  // Cumulative buckets: each bucket counts every observation <= its upper bound, which is
  // what the exposition format requires (`le` is inclusive and monotonic).
  for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
    if (seconds <= DURATION_BUCKETS[i]) {
      histogram.buckets[i] += 1;
    }
  }
  histogram.sum += seconds;
  histogram.count += 1;
};

const incrementCount = (key) => {
  if (!requestCounts.has(key) && requestCounts.size >= MAX_ROUTE_SERIES) {
    return;
  }
  requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
};

/**
 * Express middleware recording request count, duration and in-flight gauge.
 *
 * Hooks `res.on('finish')` rather than wrapping `res.end`: `finish` fires once the
 * response has been flushed, and also fires for requests the client aborts, so the
 * in-flight gauge cannot leak.
 */
const middleware = (req, res, next) => {
  // The scrape endpoint does not instrument itself - it would add a request to every
  // scrape and make the API look busier than it is.
  if (req.path === '/metrics') {
    return next();
  }
  const start = process.hrtime.bigint();
  inFlightGauge.value += 1;
  let settled = false;
  const record = () => {
    if (settled) return;
    settled = true;
    inFlightGauge.value -= 1;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const key = seriesKey(req.method, routeLabel(req), res.statusCode);
    incrementCount(key);
    observeDuration(key, seconds);
  };
  res.on('finish', record);
  // A connection dropped before the response was flushed never emits `finish`.
  res.on('close', record);
  return next();
};

/** Snapshot of the collected request metrics, keyed into label objects. */
const snapshot = () => {
  const counts = [];
  requestCounts.forEach((value, key) => {
    const [method, route, status] = key.split(' ');
    counts.push({
      value, labels: { method, route, status },
    });
  });
  const durations = [];
  requestDurations.forEach((histogram, key) => {
    const [method, route, status] = key.split(' ');
    durations.push({
      labels: { method, route, status },
      buckets: histogram.buckets,
      sum: histogram.sum,
      count: histogram.count,
    });
  });
  return { counts, durations, inFlight: inFlightGauge.value };
};

/** Test helper - clears all collected series. */
const reset = () => {
  requestCounts.clear();
  requestDurations.clear();
  inFlightGauge.value = 0;
};

module.exports = {
  middleware,
  snapshot,
  reset,
  DURATION_BUCKETS,
  MAX_ROUTE_SERIES,
};
