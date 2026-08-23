const { check, param, query } = require('express-validator');
const manualFolderController = require('../controllers/manual-folder.controller.js');

module.exports = (app, path) => {
  app.post(`${path}/manual-folder`, [
    check('team')
      .exists()
      .isMongoId(),
    check('name')
      .exists()
      .isString()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('A folder name is required (max 100 characters)'),
    check('description')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Max length for a folder description is 500 characters'),
    // Absent or null files the folder at the root.
    check('parent')
      .optional({ nullable: true })
      .isMongoId(),
  ], manualFolderController.create);

  app.get(`${path}/manual-folder`, [
    query('teamId')
      .exists()
      .isMongoId(),
  ], manualFolderController.findAll);

  // Declared before /:folderId so "move" is not captured as an id.
  app.put(`${path}/manual-folder/move`, [
    check('testCaseIds')
      .exists()
      .custom((ids) => Array.isArray(ids) && ids.length > 0)
      .withMessage('At least one test case id is required'),
    check('testCaseIds.*')
      .isMongoId(),
    check('folder')
      .optional({ nullable: true })
      .isMongoId(),
  ], manualFolderController.moveTestCases);

  app.get(`${path}/manual-folder/:folderId`, [
    param('folderId')
      .exists()
      .isMongoId(),
  ], manualFolderController.findOne);

  app.put(`${path}/manual-folder/:folderId`, [
    param('folderId')
      .exists()
      .isMongoId(),
    check('name')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('A folder name is required (max 100 characters)'),
    check('description')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Max length for a folder description is 500 characters'),
    // null moves the folder to the root.
    check('parent')
      .optional({ nullable: true })
      .isMongoId(),
  ], manualFolderController.update);

  app.delete(`${path}/manual-folder/:folderId`, [
    param('folderId')
      .exists()
      .isMongoId(),
  ], manualFolderController.delete);
};
