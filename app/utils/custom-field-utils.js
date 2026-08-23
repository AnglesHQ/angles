const mongoose = require('mongoose');
const debug = require('debug');
const CustomFieldDefinition = require('../models/custom-field-definition.js');
const User = require('../models/user.js');
const { InvalidRequestError } = require('../exceptions/errors.js');

const log = debug('custom-field:utils');
const customFieldUtils = {};

const MONGO_ID_PATTERN = /^[a-f\d]{24}$/i;

/*
Coerces one submitted value to the type its definition declares, returning either
{ value } or { error }.

Coercion is deliberate rather than strict-typing: values arrive from JSON bodies and from
form inputs, so a number field legitimately receives "42" and a boolean receives "true".
What is not accepted is anything ambiguous - "" for a number, or an unparseable date -
because storing those silently would surface much later as a broken render.
 */
const coerceValue = (definition, value) => {
  const { type, options } = definition;

  switch (type) {
    case 'text':
    case 'textarea': {
      if (typeof value !== 'string') return { error: 'must be a string' };
      return { value };
    }
    case 'number': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return { error: 'must be a finite number' };
        return { value };
      }
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return { value: parsed };
      }
      return { error: 'must be a number' };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { value };
      if (value === 'true') return { value: true };
      if (value === 'false') return { value: false };
      return { error: 'must be a boolean' };
    }
    case 'date': {
      const parsed = new Date(value);
      // An invalid Date still constructs; its time is NaN.
      if (Number.isNaN(parsed.getTime())) return { error: 'must be a valid ISO-8601 date' };
      return { value: parsed };
    }
    case 'select': {
      if (typeof value !== 'string') return { error: 'must be a string' };
      if (!options.includes(value)) {
        return { error: `must be one of: ${options.join(', ')}` };
      }
      return { value };
    }
    case 'multiselect': {
      if (!Array.isArray(value)) return { error: 'must be an array' };
      const invalid = value.filter((entry) => !options.includes(entry));
      if (invalid.length > 0) {
        return { error: `contains values that are not options: ${invalid.join(', ')}` };
      }
      // Duplicates would render as repeated chips and mean nothing distinct.
      return { value: [...new Set(value)] };
    }
    case 'user': {
      if (typeof value !== 'string' || !MONGO_ID_PATTERN.test(value)) {
        return { error: 'must be a user id' };
      }
      // Existence is checked separately - it needs a database round trip, which this
      // synchronous coercion step deliberately does not do.
      return { value, needsUserCheck: true };
    }
    default:
      return { error: `has an unknown field type "${type}"` };
  }
};

/*
Treats a submitted value as "not provided". Used for the required check and to decide
whether a default applies. `false` and `0` are real values, so only null, undefined, an
empty string and an empty array count as absent.
 */
const isEmpty = (value) => value === undefined
  || value === null
  || value === ''
  || (Array.isArray(value) && value.length === 0);

customFieldUtils.isEmpty = isEmpty;

/*
Validates and coerces a customFields object against a team's field definitions.

Every problem is collected and reported together rather than throwing on the first one: a
QA filling in six fields should see all six mistakes at once, not fix one 400 per save.

`enforceRequired` is passed by the caller rather than derived here, because whether a
required field must be present depends on the status the test case is being saved with -
drafts are exempt so that authoring can be incremental.

Returns a plain object suitable for assigning to a Mongoose Map.
 */
customFieldUtils.validateCustomFields = async (definitions, values, enforceRequired = false) => {
  const errors = [];
  const result = {};
  const submitted = values || {};

  const byKey = new Map(definitions.map((definition) => [definition.key, definition]));

  // Unknown keys are rejected rather than dropped, so a typo in the admin UI or client
  // surfaces immediately instead of silently discarding the value.
  Object.keys(submitted).forEach((key) => {
    if (!byKey.has(key)) {
      errors.push(`"${key}" is not a configured custom field for this team`);
    }
  });

  const userChecks = [];

  definitions.forEach((definition) => {
    const { key } = definition;
    const submittedValue = submitted[key];

    if (isEmpty(submittedValue)) {
      // An archived field never receives a default - it is on its way out, and applying
      // one would quietly reintroduce it on every save.
      if (!definition.archived && !isEmpty(definition.defaultValue)) {
        const coerced = coerceValue(definition, definition.defaultValue);
        if (!coerced.error) {
          result[key] = coerced.value;
          return;
        }
        // A default that does not satisfy its own definition is an admin configuration
        // problem, not the author's. Log it and treat the field as empty rather than
        // failing a save the author cannot fix.
        log(`Default value for custom field "${key}" is invalid (${coerced.error}); ignoring it.`);
      }
      if (enforceRequired && definition.required && !definition.archived) {
        errors.push(`"${definition.label}" is required`);
      }
      return;
    }

    const coerced = coerceValue(definition, submittedValue);
    if (coerced.error) {
      errors.push(`"${definition.label}" ${coerced.error}`);
      return;
    }
    if (coerced.needsUserCheck) {
      userChecks.push({ key, label: definition.label, value: coerced.value });
    }
    result[key] = coerced.value;
  });

  // One query for every user-typed field rather than one per field.
  if (userChecks.length > 0) {
    const ids = userChecks.map((check) => mongoose.Types.ObjectId(check.value));
    const found = await User.find({ _id: { $in: ids } }).select('_id').lean().exec();
    const foundIds = new Set(found.map((user) => user._id.toString()));
    userChecks.forEach((check) => {
      if (!foundIds.has(check.value)) {
        errors.push(`"${check.label}" refers to a user that does not exist`);
        delete result[check.key];
      }
    });
  }

  if (errors.length > 0) {
    throw new InvalidRequestError(`Invalid custom fields: ${errors.join('; ')}`);
  }

  return result;
};

/*
Loads the field definitions that apply to a team's test cases.

Archived fields are included: a test case may still carry a value for one, and that value
has to survive a round trip through validation rather than being rejected as an unknown
key. They are excluded from the required check and never receive defaults.
 */
customFieldUtils.getDefinitionsForTeam = (teamId) => CustomFieldDefinition
  .find({
    team: teamId,
    appliesTo: { $in: ['testcase', 'both'] },
  })
  .sort('order')
  .lean()
  .exec();

/*
Builds the fieldDefinitions snapshot stored on a frozen version, so an archived or
relabelled field still renders historical values with the label and type they had at the
time. Only the definitions the case actually holds a value for are recorded - snapshotting
the rest would bloat every version with fields the case never used.
 */
customFieldUtils.buildDefinitionSnapshot = (definitions, customFields) => {
  if (!customFields) return [];
  const keys = customFields instanceof Map
    ? [...customFields.keys()]
    : Object.keys(customFields);
  return definitions
    .filter((definition) => keys.includes(definition.key))
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      type: definition.type,
      options: definition.options,
    }));
};

module.exports = customFieldUtils;
