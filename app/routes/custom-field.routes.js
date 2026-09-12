const { check, param, query } = require('express-validator');
const customFieldController = require('../controllers/custom-field.controller.js');
const authMiddleware = require('../utils/auth-middleware.js');
const { fieldTypes, fieldScopes } = require('../models/custom-field-definition.js');

// Shared by create and update. `key` and `type` are only required on create, so their
// presence rules live with the individual routes.
const definitionValidators = [
  check('label')
    .optional()
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Max length for a field label is 100 characters'),
  check('options')
    .optional()
    .isArray({ max: 100 })
    .withMessage('A field can have at most 100 options'),
  check('options.*')
    .optional()
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Max length for a field option is 100 characters'),
  check('required')
    .optional()
    .isBoolean(),
  check('order')
    .optional()
    .isNumeric(),
  check('appliesTo')
    .optional()
    .isIn(fieldScopes)
    .withMessage(`appliesTo must be one of [${fieldScopes.join(', ')}]`),
];

module.exports = (app, path) => {
  // Configuring the fields available to a team is an admin action; reading them is not,
  // so authorizeAdmin is applied per-route rather than to the whole path.
  app.post(`${path}/custom-field`, authMiddleware.authorizeAdmin, [
    check('team')
      .exists()
      .isMongoId(),
    check('key')
      .exists({ checkFalsy: true })
      .matches(/^[a-z][a-z0-9_]{0,39}$/)
      .withMessage('Field key must start with a lowercase letter and contain only lowercase letters, numbers and underscores (max 40 characters).'),
    check('label')
      .exists({ checkFalsy: true })
      .isString()
      .isLength({ min: 1, max: 100 })
      .withMessage('Max length for a field label is 100 characters'),
    check('type')
      .exists()
      .isIn(fieldTypes)
      .withMessage(`Field type must be one of [${fieldTypes.join(', ')}]`),
    ...definitionValidators,
  ], customFieldController.create);

  app.get(`${path}/custom-field`, [
    query('teamId')
      .exists()
      .isMongoId(),
    query('includeArchived')
      .optional()
      .isBoolean(),
    query('appliesTo')
      .optional()
      .isIn(fieldScopes)
      .withMessage(`appliesTo must be one of [${fieldScopes.join(', ')}]`),
  ], customFieldController.findAll);

  app.get(`${path}/custom-field/:fieldId`, [
    param('fieldId')
      .exists()
      .isMongoId(),
  ], customFieldController.findOne);

  app.put(`${path}/custom-field/:fieldId`, authMiddleware.authorizeAdmin, [
    param('fieldId')
      .exists()
      .isMongoId(),
    // Accepted so the controller can return an explanatory 400 rather than silently
    // ignoring an attempt to rename the storage key.
    check('key')
      .optional()
      .isString(),
    check('type')
      .optional()
      .isIn(fieldTypes)
      .withMessage(`Field type must be one of [${fieldTypes.join(', ')}]`),
    check('archived')
      .optional()
      .isBoolean(),
    ...definitionValidators,
  ], customFieldController.update);

  app.delete(`${path}/custom-field/:fieldId`, authMiddleware.authorizeAdmin, [
    param('fieldId')
      .exists()
      .isMongoId(),
  ], customFieldController.delete);
};
