// Centralised password strength policy, shared by the admin user-management routes and
// the self-service password-change route so a single definition governs every place a
// local password is set.
const MIN_LENGTH = 10;
const MAX_LENGTH = 100;

// Each requirement is checked independently so the validation error can list every rule
// the supplied password fails, rather than only the first.
const REQUIREMENTS = [
  { test: (v) => v.length >= MIN_LENGTH, message: `be at least ${MIN_LENGTH} characters long` },
  { test: (v) => v.length <= MAX_LENGTH, message: `be at most ${MAX_LENGTH} characters long` },
  { test: (v) => /[A-Za-z]/.test(v), message: 'contain at least one letter' },
  { test: (v) => /[A-Z]/.test(v), message: 'contain at least one uppercase letter' },
  { test: (v) => /[^A-Za-z0-9]/.test(v), message: 'contain at least one special character' },
];

/**
 * Returns the list of unmet-requirement messages for a password (empty when it complies).
 * @param {string} value
 * @returns {string[]}
 */
const getPasswordViolations = (value) => REQUIREMENTS
  .filter((requirement) => !requirement.test(String(value)))
  .map((requirement) => requirement.message);

/**
 * express-validator custom validator: throws a single, human-readable error listing every
 * unmet requirement so the client can display all of them at once.
 * @param {string} value
 * @returns {boolean} true when the password complies
 */
const passwordStrength = (value) => {
  const violations = getPasswordViolations(value);
  if (violations.length > 0) {
    throw new Error(`Password must ${violations.join(', ')}.`);
  }
  return true;
};

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  getPasswordViolations,
  passwordStrength,
};
