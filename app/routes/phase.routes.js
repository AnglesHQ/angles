const { check, param, oneOf } = require('express-validator');
const phaseController = require('../controllers/phase.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/phase`, [
    check('name')
      .exists()
      .isLength({ max: 30 })
      .withMessage('Max length for phase name is 30 characters')
      .matches(/^[A-Za-z0-9-]+$/)
      .withMessage('Name must only contain letters, numbers and hyphens.'),
    check('orderNumber')
      .optional()
      .isNumeric(),
  ], phaseController.create);

  app.get(`${path}/phase`, phaseController.findAll);

  app.get(`${path}/phase/:phaseId`, [
    param('phaseId').isMongoId(),
  ], phaseController.findOne);

  app.put(`${path}/phase/:phaseId`, [
    param('phaseId').isMongoId(),
    oneOf([
      check('name')
        .exists()
        .isLength({ max: 30 })
        .withMessage('Max length for phase name is 30 characters')
        .matches(/^[A-Za-z0-9-]+$/)
        .withMessage('Name must only contain letters, numbers and hyphens.'),
      check('orderNumber')
        .exists()
        .isNumeric(),
    ]),

  ], phaseController.update);

  app.delete(`${path}/phase/:phaseId`, [
    param('phaseId').isMongoId(),
  ], phaseController.delete);
};
