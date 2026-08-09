const debug = require('debug');
const bcrypt = require('bcryptjs');
const User = require('../models/user.js');
const { getPasswordViolations } = require('./password-policy.js');

const log = debug('admin:seed');

// The initial admin account is seeded at startup from deployment-provided environment
// variables (never a hardcoded default). ANGLES_ADMIN_PASSWORD is required to seed;
// ANGLES_ADMIN_USERNAME is optional and defaults to 'admin'. Seeding is create-if-missing:
// once the admin exists, the password is managed through the app and is not overwritten
// on subsequent restarts, so changing the env var after first run has no effect.
const BCRYPT_ROUNDS = 10;

/**
 * Ensures a local admin user exists, creating it from environment variables on first run.
 * @returns {Promise<{ seeded: boolean, username?: string, reason?: string,
 *   violations?: string[] }>}
 * result of the attempt: seeded true when a user was created; otherwise reason is
 * 'no-password' (env var unset), 'weak-password' (fails the strength policy, with the unmet
 * requirements in violations), or 'exists' (admin already present).
 */
const ensureAdminUser = async () => {
  const password = process.env.ANGLES_ADMIN_PASSWORD;
  const username = (process.env.ANGLES_ADMIN_USERNAME || 'admin').toLowerCase();

  if (!password) {
    log('ANGLES_ADMIN_PASSWORD not set; skipping admin seed.');
    return { seeded: false, reason: 'no-password' };
  }

  // Hold the seeded admin to the same strength policy as every other local password.
  const violations = getPasswordViolations(password);
  if (violations.length > 0) {
    log('ANGLES_ADMIN_PASSWORD does not meet the strength policy; skipping admin seed.');
    return { seeded: false, reason: 'weak-password', violations };
  }

  const existing = await User.findOne({ username });
  if (existing) {
    log('Admin user %s already exists; leaving password unchanged.', username);
    return { seeded: false, username, reason: 'exists' };
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await User.create({
    username,
    password: hashedPassword,
    role: 'admin',
    teams: [],
    authProvider: 'local',
  });
  log('Seeded admin user %s.', username);
  return { seeded: true, username };
};

module.exports = {
  ensureAdminUser,
};
