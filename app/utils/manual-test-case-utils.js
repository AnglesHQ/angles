const debug = require('debug');
const ManualTestCaseVersion = require('../models/manual-test-case-version.js');

const log = debug('manual-test-case:utils');
const manualTestCaseUtils = {};

// The fields that make up a test case's *content*. A change to any of them produces a new
// immutable version; a change to anything else does not.
//
// `status` is deliberately absent: moving a case from DRAFT to ACTIVE is workflow state,
// not content, and versioning it would burn a version without changing what a tester sees.
// Same for `component` and the audit fields.
manualTestCaseUtils.CONTENT_FIELDS = [
  'title',
  'description',
  'preconditions',
  'priority',
  'tags',
  'steps',
  'customFields',
];

/*
Normalises a value for content comparison so that differences which do not change what a
tester sees do not burn a version.

Mongoose Maps, subdocument arrays and plain objects all have to compare equal to the plain
JSON the client sends, which is why this cannot just be a === or a JSON.stringify of the
raw values.
 */
const normaliseValue = (value) => {
  if (value === undefined || value === null) return null;
  // Mongoose Map -> plain object
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normaliseValue(entry));
  }
  if (typeof value === 'object') {
    // Mongoose subdocuments expose toObject; plain request bodies do not.
    const plain = typeof value.toObject === 'function' ? value.toObject() : value;
    return Object.keys(plain)
      .filter((key) => !['_id', '__v', 'id'].includes(key))
      .sort()
      .reduce((accumulator, key) => {
        const normalised = normaliseValue(plain[key]);
        // Treat an absent key and an explicitly empty one as the same, so a client that
        // omits `expected` and one that sends '' do not produce different versions.
        if (normalised !== null && normalised !== '') {
          // eslint-disable-next-line no-param-reassign
          accumulator[key] = normalised;
        }
        return accumulator;
      }, {});
  }
  return value;
};

manualTestCaseUtils.normaliseValue = normaliseValue;

/*
Returns true when the incoming body changes any content field of the existing case.

Only fields actually present on the body are compared, so a PUT that omits a field leaves
it untouched rather than being read as "clear this field" (and so cannot silently burn a
version by blanking content the caller never mentioned).
 */
manualTestCaseUtils.hasContentChanged = (existingCase, body) => manualTestCaseUtils
  .CONTENT_FIELDS
  .filter((field) => body[field] !== undefined)
  .some((field) => {
    const before = JSON.stringify(normaliseValue(existingCase[field]));
    const after = JSON.stringify(normaliseValue(body[field]));
    return before !== after;
  });

/*
Builds (but does not save) the immutable version document for the given case.

`fieldDefinitions` is passed in rather than looked up here: phase 2 owns the definitions,
and until then every version is written with an empty array.
 */
manualTestCaseUtils.buildVersionDocument = (testCase, userId, fieldDefinitions = []) => (
  new ManualTestCaseVersion({
    testCase: testCase._id,
    version: testCase.version,
    team: testCase.team,
    title: testCase.title,
    description: testCase.description,
    preconditions: testCase.preconditions,
    priority: testCase.priority,
    tags: testCase.tags,
    steps: testCase.steps,
    customFields: testCase.customFields,
    fieldDefinitions,
    createdBy: userId,
  })
);

/*
Writes the frozen version document for a case.

The version is always inserted *before* the head is saved by the caller, so a crash
between the two leaves an orphan version rather than a head whose `version` points at a
document that does not exist. An orphan is harmless - nothing references a version until
an execution binds to it - whereas a dangling head pointer would make the case
unreadable at that version.
 */
manualTestCaseUtils.saveVersion = (testCase, userId, fieldDefinitions = []) => {
  const version = manualTestCaseUtils.buildVersionDocument(testCase, userId, fieldDefinitions);
  log(`Writing version ${testCase.version} for manual test case ${testCase._id}`);
  return version.save();
};

/*
Resolves a specific frozen version of a case.

Falls back to the head only when the case has no version documents at all, which can only
happen for data written before this collection existed. The fallback is logged because it
means that read is *not* guaranteed immutable, and a deployment seeing it regularly has
un-migrated data.
 */
manualTestCaseUtils.getVersion = async (testCase, versionNumber) => {
  const version = await ManualTestCaseVersion
    .findOne({ testCase: testCase._id, version: versionNumber })
    .lean()
    .exec();
  if (version) {
    return version;
  }
  const versionCount = await ManualTestCaseVersion
    .countDocuments({ testCase: testCase._id })
    .exec();
  if (versionCount === 0) {
    log(`No version documents exist for manual test case ${testCase._id}; falling back to the head. This case predates version tracking.`);
    return null;
  }
  return undefined;
};

module.exports = manualTestCaseUtils;
