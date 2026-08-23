const { validationResult } = require('express-validator');
const debug = require('debug');

const CustomFieldDefinition = require('../models/custom-field-definition.js');
const ManualTestCase = require('../models/manual-test-case.js');
const ManualTestCaseVersion = require('../models/manual-test-case-version.js');
const { Team } = require('../models/team.js');
const { optionBackedTypes } = require('../models/custom-field-definition.js');
const historyUtils = require('../utils/history-utils.js');
const authMiddleware = require('../utils/auth-middleware.js');
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidRequestError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('custom-field:controller');

// select/multiselect are meaningless without something to select from, and a field of any
// other type carrying options would silently ignore them.
const validateOptions = (type, options) => {
  if (optionBackedTypes.includes(type)) {
    if (!Array.isArray(options) || options.length === 0) {
      throw new InvalidRequestError(`A field of type "${type}" requires at least one option.`);
    }
    const unique = new Set(options);
    if (unique.size !== options.length) {
      throw new InvalidRequestError('Field options must be unique.');
    }
  } else if (options !== undefined && options !== null && options.length > 0) {
    throw new InvalidRequestError(`A field of type "${type}" cannot have options.`);
  }
};

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    team,
    key,
    label,
    type,
    options,
    required,
    defaultValue,
    order,
    appliesTo,
  } = req.body;

  return Team.findById(team).select('_id').lean().exec()
    .then(async (teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${team}`);
      }
      validateOptions(type, options);

      // Checked explicitly rather than relying on the unique index, so the caller gets a
      // 409 explaining which key collided instead of a driver error. The index is still
      // the backstop against a concurrent create.
      const existing = await CustomFieldDefinition
        .findOne({ team: teamFound._id, key })
        .lean()
        .exec();
      if (existing) {
        const suffix = existing.archived ? ' (it is archived)' : '';
        throw new ConflictError(`A custom field with key "${key}" already exists for this team${suffix}.`);
      }

      const definition = new CustomFieldDefinition({
        team: teamFound._id,
        key,
        label,
        type,
        options,
        required,
        defaultValue,
        order,
        appliesTo,
      });
      const saved = await definition.save();
      log(`Created custom field "${key}" for team ${teamFound._id}`);
      historyUtils.recordChange({
        entityType: 'customfield',
        entityId: saved._id,
        team: saved.team,
        action: 'CREATE',
        user: req.user ? req.user._id : undefined,
        comment: `Created custom field "${saved.label}" (${saved.type})`,
      });
      return saved;
    })
    .then((saved) => res.status(201).send(saved))
    .catch((err) => handleError(err, res));
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId, includeArchived, appliesTo } = req.query;

  return Team.findById(teamId).select('_id').lean().exec()
    .then((teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${teamId}`);
      }
      // Readable by anyone with team access - the authoring UI needs the definitions to
      // render its form. Only writes are admin-only.
      if (!authMiddleware.hasTeamAccess(req.user, teamId)) {
        throw new ForbiddenError('You do not have access to this team');
      }
      const query = { team: teamFound._id };
      if (includeArchived !== 'true') {
        query.archived = false;
      }
      if (appliesTo) {
        query.appliesTo = { $in: [appliesTo, 'both'] };
      }
      return CustomFieldDefinition.find(query).sort('order').lean().exec();
    })
    .then((definitions) => res.status(200).send({ customFields: definitions }))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { fieldId } = req.params;

  return CustomFieldDefinition.findById(fieldId).lean().exec()
    .then((definition) => {
      if (!definition) {
        throw new NotFoundError(`No custom field found with id ${fieldId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, definition.team)) {
        throw new ForbiddenError('You do not have access to this custom field');
      }
      return res.status(200).send(definition);
    })
    .catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { fieldId } = req.params;

  /* eslint no-param-reassign: ["error", { "props": false }] */
  return CustomFieldDefinition.findById(fieldId)
    .then(async (definition) => {
      if (!definition) {
        throw new NotFoundError(`No custom field found with id ${fieldId}`);
      }

      // Captured before the document is mutated, so the diff sees what was persisted.
      const before = definition.toObject();

      // The key is the storage key: every test case's customFields map and every frozen
      // version is keyed by it, so changing it would orphan all existing values. The
      // label is what the UI shows and can be changed freely.
      if (req.body.key !== undefined && req.body.key !== definition.key) {
        throw new InvalidRequestError('A custom field key cannot be changed once created. Create a new field instead.');
      }

      // Changing the type would leave existing values in the old representation, which
      // then fail validation on the next save of a case that has never touched this field.
      if (req.body.type !== undefined && req.body.type !== definition.type) {
        const inUse = await ManualTestCase.countDocuments({
          team: definition.team,
          [`customFields.${definition.key}`]: { $exists: true },
        }).exec();
        if (inUse > 0) {
          throw new ConflictError(`Cannot change the type of "${definition.label}" because ${inUse} test case(s) already hold a value for it. Archive this field and create a new one instead.`);
        }
      }

      const nextType = req.body.type === undefined ? definition.type : req.body.type;
      if (req.body.options !== undefined || req.body.type !== undefined) {
        const nextOptions = req.body.options === undefined ? definition.options : req.body.options;
        validateOptions(nextType, nextOptions);

        // Removing an option that existing cases still hold would make those values
        // invalid on their next save, which the author of the case cannot fix.
        if (optionBackedTypes.includes(nextType) && req.body.options !== undefined) {
          const removed = (definition.options || [])
            .filter((option) => !req.body.options.includes(option));
          if (removed.length > 0) {
            const stillUsed = await ManualTestCase.countDocuments({
              team: definition.team,
              [`customFields.${definition.key}`]: { $in: removed },
            }).exec();
            if (stillUsed > 0) {
              throw new ConflictError(`Cannot remove option(s) [${removed.join(', ')}] because ${stillUsed} test case(s) still use them.`);
            }
          }
        }
      }

      ['label', 'type', 'options', 'required', 'defaultValue', 'order', 'appliesTo', 'archived']
        .forEach((field) => {
          if (req.body[field] !== undefined) {
            definition[field] = req.body[field];
          }
        });
      log(`Updated custom field ${fieldId}`);
      const saved = await definition.save();
      const changes = historyUtils.diffDocuments(
        before,
        saved.toObject(),
        historyUtils.TRACKED_PATHS.customfield,
      );
      if (changes.length > 0) {
        historyUtils.recordChange({
          entityType: 'customfield',
          entityId: saved._id,
          team: saved.team,
          action: 'UPDATE',
          changes,
          user: req.user ? req.user._id : undefined,
        });
      }
      return saved;
    })
    .then((saved) => res.status(200).send(saved))
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { fieldId } = req.params;

  return CustomFieldDefinition.findById(fieldId)
    .then(async (definition) => {
      if (!definition) {
        throw new NotFoundError(`No custom field found with id ${fieldId}`);
      }

      // A field whose values appear anywhere - on a live case or in a frozen version - is
      // archived rather than removed. Deleting the definition would leave those values
      // with no label, type or options to render them by, which for a frozen version
      // means silently losing part of what a tester saw.
      const key = `customFields.${definition.key}`;
      const [liveUses, versionUses] = await Promise.all([
        ManualTestCase.countDocuments({
          team: definition.team,
          [key]: { $exists: true },
        }).exec(),
        ManualTestCaseVersion.countDocuments({
          team: definition.team,
          [key]: { $exists: true },
        }).exec(),
      ]);

      if (liveUses > 0 || versionUses > 0) {
        if (definition.archived) {
          return { definition, archived: true, alreadyArchived: true };
        }
        definition.archived = true;
        const saved = await definition.save();
        log(`Archived custom field ${fieldId} (in use by ${liveUses} case(s) and ${versionUses} version(s))`);
        historyUtils.recordChange({
          entityType: 'customfield',
          entityId: saved._id,
          team: saved.team,
          action: 'ARCHIVE',
          changes: [{ field: 'archived', from: false, to: true }],
          user: req.user ? req.user._id : undefined,
          comment: `Archived rather than deleted: in use by ${liveUses} test case(s) and ${versionUses} frozen version(s)`,
        });
        return {
          definition: saved, archived: true, liveUses, versionUses,
        };
      }

      await CustomFieldDefinition.findByIdAndRemove(fieldId).exec();
      log(`Deleted unused custom field ${fieldId}`);
      historyUtils.recordChange({
        entityType: 'customfield',
        entityId: definition._id,
        team: definition.team,
        action: 'DELETE',
        user: req.user ? req.user._id : undefined,
        comment: `Deleted unused custom field "${definition.label}"`,
      });
      return { archived: false };
    })
    .then((result) => {
      if (result.archived) {
        const message = result.alreadyArchived
          ? 'Custom field is in use and was already archived.'
          : 'Custom field is in use by existing test cases and has been archived rather than deleted.';
        return res.status(200).send({ message, archived: true, customField: result.definition });
      }
      return res.status(200).send({ message: 'Custom field deleted successfully!', archived: false });
    })
    .catch((err) => handleError(err, res));
};
