const debug = require('debug');

const log = debug('auth:throttle');

/*
 * Slows down password guessing against the credential logins (local and LDAP).
 *
 * Two limits, both counting failed sign-ins within a sliding window:
 *
 *  - per client IP + username (default 5): stops one client guessing one account's
 *    password. Reached, that pair is refused until the window passes.
 *  - per client IP (default 50): stops one client spraying a few guesses at many
 *    accounts.
 *
 * There is deliberately no limit on a username alone. It would also stop a distributed
 * guess at one account, but it would let anyone lock any user (an admin, say) out simply
 * by failing to sign in as them from a few addresses.
 *
 * A successful sign-in clears that client's count for the username. Counts are kept in
 * memory, so each API instance limits on its own and a restart clears them.
 *
 * Behind a reverse proxy, set TRUST_PROXY=true so the client's address (from
 * X-Forwarded-For) is used; otherwise every request appears to come from the proxy and
 * the per-IP limit applies to everyone at once.
 */

const positiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const defaults = () => ({
  maxFailuresPerAccount: positiveInt(process.env.ANGLES_LOGIN_MAX_FAILURES, 5),
  maxFailuresPerIp: positiveInt(process.env.ANGLES_LOGIN_MAX_FAILURES_PER_IP, 50),
  windowMs: positiveInt(process.env.ANGLES_LOGIN_LOCKOUT_MINUTES, 15) * 60 * 1000,
});

let settings = defaults();

// key -> timestamps (ms) of failures still inside the window
const failures = new Map();
// Bound the memory a flood of distinct addresses/usernames can take.
const MAX_KEYS = 10000;

const accountKey = (ip, username) => `account:${ip}:${String(username || '').toLowerCase().trim()}`;
const ipKey = (ip) => `ip:${ip}`;

const recent = (key, now) => {
  const timestamps = (failures.get(key) || []).filter((t) => now - t < settings.windowMs);
  if (timestamps.length) failures.set(key, timestamps);
  else failures.delete(key);
  return timestamps;
};

const prune = (now) => {
  if (failures.size < MAX_KEYS) return;
  [...failures.keys()].forEach((key) => recent(key, now));
  // Still full of live entries: drop the oldest keys (Map keeps insertion order).
  const excess = failures.size - MAX_KEYS + 1;
  [...failures.keys()].slice(0, Math.max(0, excess)).forEach((key) => failures.delete(key));
};

// Seconds until the oldest counted failure leaves the window.
const retryAfterSeconds = (timestamps, now) => Math.max(
  1,
  Math.ceil((timestamps[0] + settings.windowMs - now) / 1000),
);

/**
 * Whether this client may attempt to sign in as `username` now. Returns
 * `{ allowed: true }` or `{ allowed: false, retryAfter }` (seconds).
 */
const check = (ip, username, now = Date.now()) => {
  const perAccount = recent(accountKey(ip, username), now);
  if (perAccount.length >= settings.maxFailuresPerAccount) {
    return { allowed: false, retryAfter: retryAfterSeconds(perAccount, now) };
  }
  const perIp = recent(ipKey(ip), now);
  if (perIp.length >= settings.maxFailuresPerIp) {
    return { allowed: false, retryAfter: retryAfterSeconds(perIp, now) };
  }
  return { allowed: true };
};

const recordFailure = (ip, username, now = Date.now()) => {
  prune(now);
  [accountKey(ip, username), ipKey(ip)].forEach((key) => {
    failures.set(key, [...recent(key, now), now]);
  });
  log('Failed sign-in for %s from %s', username, ip);
};

const recordSuccess = (ip, username) => {
  failures.delete(accountKey(ip, username));
};

/**
 * Express middleware for a credential login route: refuses with 429 (and Retry-After)
 * while the client is over a limit for the posted username.
 */
const guard = (req, res, next) => {
  const result = check(req.ip, req.body && req.body.username);
  if (result.allowed) return next();
  res.set('Retry-After', String(result.retryAfter));
  return res.status(429).json({
    error: `Too many failed sign-in attempts. Try again in ${Math.ceil(result.retryAfter / 60)} minute(s).`,
  });
};

module.exports = {
  guard,
  check,
  recordFailure,
  recordSuccess,
  // Tests only: replace the limits, and forget every recorded failure.
  configure: (overrides) => { settings = { ...defaults(), ...overrides }; },
  reset: () => { failures.clear(); settings = defaults(); },
};
