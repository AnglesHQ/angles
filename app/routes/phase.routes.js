const { check, param } = require('express-validator');
const phaseController = require('../controllers/phase.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/phase`, [
    check('name')
      .exists()
      .isLength({ max: 15 })
      .withMessage('Max length for phase name is 15 characters')
      .matches(/^[A-Za-z0-9-]+$/)
      .withMessage('Name must only contain letters, numbers and hyphens.'),
  ], phaseController.create);

  app.get(`${path}/phase`, phaseController.findAll);

  app.get(`${path}/phase/:phaseId`, [
    param('phaseId').isMongoId(),
  ], phaseController.findOne);

  app.put(`${path}/phase/:phaseId`, [
    param('phaseId').isMongoId(),
    check('name')
      .exists()
      .isLength({ max: 15 })
      .withMessage('Max length for phase name is 15 characters')
      .matches(/^[A-Za-z0-9-]+$/)
      .withMessage('Name must only contain letters, numbers and hyphens.'),
  ], phaseController.update);

  app.delete(`${path}/phase/:phaseId`, [
    param('phaseId').isMongoId(),
  ], phaseController.delete);
};
