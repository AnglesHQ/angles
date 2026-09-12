const debug = require('debug');
const ManualChangeHistory = require('../models/manual-change-history.js');
const { normaliseValue } = require('./manual-test-case-utils.js');

const log = debug('history:utils');
const historyUtils = {};

// Fields worth auditing per entity type. Deliberately explicit rather than "every key
// that differs": timestamps, version counters and audit fields change on every save and
// would bury the changes a reader actually cares about.
historyUtils.TRACKED_PATHS = {
  testcase: [
    'title',
    'description',
    'preconditions',
    'status',
    'priority',
    'tags',
    'steps',
    'customFields',
    'component',
    'folder',
  ],
  sharedstep: ['name', 'description', 'steps'],
  customfield: [
    'label',
    'type',
    'options',
    'required',
    'defaultValue',
    'order',
    'appliesTo',
    'archived',
  ],
};

// A steps array or customFields map compared as one blob would report "steps changed" and
// nothing more. These get broken down into per-entry changes instead.
const STEP_FIELDS = ['action', 'expected', 'data', 'order'];

/*
Summarises a step for display in a history entry. The full subdocument carries _ids and
attachment arrays that make a diff unreadable; what a reader wants is the text.
 */
const summariseStep = (step) => {
  if (!step) return null;
  const plain = typeof step.toObject === 'function' ? step.toObject() : step;
  return STEP_FIELDS.reduce((accumulator, field) => {
    if (plain[field] !== undefined && plain[field] !== null && plain[field] !== '') {
      // eslint-disable-next-line no-param-reassign
      accumulator[field] = plain[field];
    }
    return accumulator;
  }, {});
};

/*
Diffs two steps arrays into one change per position, rather than a single opaque entry.

Compared by position because that is what an author sees: moving a step is a change to
both positions, which is accurate - the tester now does something different at step 3.
 */
const diffSteps = (before, after) => {
  const beforeSteps = before || [];
  const afterSteps = after || [];
  const changes = [];
  const length = Math.max(beforeSteps.length, afterSteps.length);

  for (let index = 0; index < length; index += 1) {
    const from = beforeSteps[index];
    const to = afterSteps[index];
    const fromNormalised = JSON.stringify(normaliseValue(from));
    const toNormalised = JSON.stringify(normaliseValue(to));
    if (fromNormalised !== toNormalised) {
      changes.push({
        field: `steps[${index}]`,
        from: summariseStep(from),
        to: summariseStep(to),
      });
    }
  }
  return changes;
};

/*
Diffs two customFields maps into one change per key, so "which field did they change?" is
answerable without eyeballing two JSON blobs.
 */
const diffCustomFields = (before, after) => {
  const toPlain = (value) => {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value.entries());
    return typeof value.toObject === 'function' ? value.toObject() : value;
  };
  const beforePlain = toPlain(before);
  const afterPlain = toPlain(after);
  const keys = Array.from(new Set([...Object.keys(beforePlain), ...Object.keys(afterPlain)]));

  return keys.reduce((changes, key) => {
    const from = beforePlain[key];
    const to = afterPlain[key];
    if (JSON.stringify(normaliseValue(from)) !== JSON.stringify(normaliseValue(to))) {
      changes.push({ field: `customFields.${key}`, from, to });
    }
    return changes;
  }, []);
};

/*
Returns the field-level changes between two states of an entity.

Only paths present on `after` are compared, so a partial update does not report every
field the caller omitted as having been cleared.
 */
historyUtils.diffDocuments = (before, after, trackedPaths) => {
  const changes = [];
  const beforeDoc = before || {};
  const afterDoc = after || {};

  trackedPaths.forEach((field) => {
    const from = beforeDoc[field];
    const to = afterDoc[field];
    if (to === undefined && from === undefined) return;

    if (field === 'steps') {
      changes.push(...diffSteps(from, to));
      return;
    }
    if (field === 'customFields') {
      changes.push(...diffCustomFields(from, to));
      return;
    }
    if (JSON.stringify(normaliseValue(from)) !== JSON.stringify(normaliseValue(to))) {
      changes.push({ field, from, to });
    }
  });

  return changes;
};

/*
Writes one history entry.

Never awaited by the request path. History is an audit trail, not part of the write it
describes: the change has already been saved and committed by the time this runs, so
failing the user's request because the log could not be written would be strictly worse
than losing the log line. Failures are logged and swallowed.
 */
historyUtils.recordChange = ({
  entityType,
  entityId,
  team,
  action,
  version,
  changes,
  user,
  comment,
  causedBy,
}) => {
  const entry = new ManualChangeHistory({
    entityType,
    entityId,
    team,
    action,
    version,
    changes: changes || [],
    changedBy: user,
    comment,
    causedBy,
  });
  return entry.save()
    .catch((error) => {
      log(`Could not record ${action} history for ${entityType} ${entityId}: ${error.message}`);
    });
};

/*
Convenience wrapper: diffs the two states and records the entry in one call.
 */
historyUtils.recordDiff = ({
  entityType,
  entityId,
  team,
  action,
  version,
  before,
  after,
  user,
  comment,
  causedBy,
}) => historyUtils.recordChange({
  entityType,
  entityId,
  team,
  action,
  version,
  changes: historyUtils.diffDocuments(before, after, historyUtils.TRACKED_PATHS[entityType]),
  user,
  comment,
  causedBy,
});

/*
Reads an entity's history, newest first.

`changedBy` is populated to username only - the user document carries apiTokens, which
must never leave the server through an audit endpoint.
 */
historyUtils.findHistory = async (entityId, limit = 20, skip = 0) => {
  const query = { entityId };
  const [entries, count] = await Promise.all([
    ManualChangeHistory.find(query, null, { limit, skip })
      .populate('changedBy', 'username')
      .populate('causedBy', 'name')
      .sort('-changedAt')
      .lean()
      .exec(),
    ManualChangeHistory.countDocuments(query).exec(),
  ]);
  return { entries, count };
};

module.exports = historyUtils;
