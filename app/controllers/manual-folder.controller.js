const debug = require('debug');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const ManualFolder = require('../models/manual-folder.js');
const ManualTestCase = require('../models/manual-test-case.js');
const { Team } = require('../models/team.js');
const authMiddleware = require('../utils/auth-middleware.js');
const manualFolderUtils = require('../utils/manual-folder-utils.js');
const historyUtils = require('../utils/history-utils.js');
const {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  InvalidRequestError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('manual-folder:controller');

// A duplicate name under the same parent is a user-facing conflict, not a server fault.
const asConflict = (error, name) => {
  if (error && error.code === 11000) {
    return new ConflictError(`A folder named "${name}" already exists here.`);
  }
  return error;
};

exports.create = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    team, name, description, parent,
  } = req.body;

  return Team.findById(team).select('_id').lean().exec()
    .then(async (teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${team}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, teamFound._id)) {
        throw new ForbiddenError('You do not have access to this team');
      }
      const placement = await manualFolderUtils.resolvePlacement(parent, teamFound._id);
      const folder = new ManualFolder({
        team: teamFound._id,
        name,
        description,
        ...placement,
        createdBy: req.user ? req.user._id : undefined,
      });
      const saved = await folder.save().catch((error) => { throw asConflict(error, name); });
      log(`Created folder ${saved._id} at depth ${saved.depth}`);
      return res.status(201).send(saved);
    })
    .catch((err) => handleError(err, res));
};

/*
The team's folder tree, with a test case count per folder.

Returned nested rather than flat: every caller wants the tree, and building it once here
keeps the shape consistent between the UI, the picker and anything else that lists folders.
 */
exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { teamId } = req.query;

  return Team.findById(teamId).select('_id').lean().exec()
    .then(async (teamFound) => {
      if (!teamFound) {
        throw new NotFoundError(`No team found with id ${teamId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, teamId)) {
        throw new ForbiddenError('You do not have access to this team');
      }
      const [folders, counts, unfiledCount] = await Promise.all([
        ManualFolder.find({ team: teamFound._id }).lean().exec(),
        ManualTestCase.aggregate([
          { $match: { team: mongoose.Types.ObjectId(teamId), folder: { $ne: null } } },
          { $group: { _id: '$folder', count: { $sum: 1 } } },
        ]).exec(),
        ManualTestCase.countDocuments({ team: teamFound._id, folder: null }).exec(),
      ]);
      const countsByFolder = {};
      counts.forEach((entry) => { countsByFolder[entry._id.toString()] = entry.count; });
      return res.status(200).send({
        folders: manualFolderUtils.buildTree(folders, countsByFolder),
        // Cases that have never been filed still have to be reachable, so the root is
        // reported alongside the tree rather than being an implicit empty folder.
        unfiledCount,
        metrics: { totalFolders: folders.length },
      });
    })
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return ManualFolder.findById(req.params.folderId)
    .populate('path', 'name')
    .lean()
    .exec()
    .then(async (folder) => {
      if (!folder) {
        throw new NotFoundError(`No folder found with id ${req.params.folderId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, folder.team)) {
        throw new ForbiddenError('You do not have access to this folder');
      }
      const contents = await manualFolderUtils.getContents(folder);
      return res.status(200).send({ ...folder, ...contents });
    })
    .catch((err) => handleError(err, res));
};

/*
Renames a folder and/or moves it under a different parent.

A move rewrites the stored paths of everything beneath it, so the guard against moving a
folder into its own subtree runs first - that would strand the whole branch.
 */
/* eslint no-param-reassign: ["error", { "props": false }] */
exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { name, description, parent } = req.body;

  return ManualFolder.findById(req.params.folderId).exec()
    .then(async (folder) => {
      if (!folder) {
        throw new NotFoundError(`No folder found with id ${req.params.folderId}`);
      }
      if (!authMiddleware.hasTeamAccess(req.user, folder.team)) {
        throw new ForbiddenError('You do not have access to this folder');
      }
      const before = folder.toObject();

      if (parent !== undefined) {
        const newParentId = parent === null || parent === '' ? null : parent;
        const currentParentId = folder.parent ? folder.parent.toString() : null;
        if (newParentId !== currentParentId) {
          if (newParentId) {
            const newParent = await ManualFolder.findById(newParentId).lean().exec();
            if (!newParent || newParent.team.toString() !== folder.team.toString()) {
              throw new NotFoundError(`No folder found for this team with id ${newParentId}`);
            }
            manualFolderUtils.assertMoveIsLegal(folder, newParent);
          }
          const oldPath = [...(folder.path || [])];
          const placement = await manualFolderUtils.resolvePlacement(newParentId, folder.team);
          folder.parent = placement.parent;
          folder.path = placement.path;
          folder.depth = placement.depth;
          // Descendants are rewritten before the folder itself is saved, so a rejected
          // depth check leaves the tree exactly as it was.
          await manualFolderUtils.rewriteSubtreePaths(folder, oldPath, placement.path);
        }
      }
      if (name !== undefined) folder.name = name;
      if (description !== undefined) folder.description = description;
      folder.updatedBy = req.user ? req.user._id : undefined;

      const saved = await folder.save()
        .catch((error) => { throw asConflict(error, name || folder.name); });

      const changes = historyUtils.diffDocuments(
        before,
        saved.toObject(),
        ['name', 'description', 'parent'],
      );
      if (changes.length > 0) {
        historyUtils.recordChange({
          entityType: 'folder',
          entityId: saved._id,
          team: saved.team,
          action: 'UPDATE',
          changes,
          user: req.user,
        });
      }
      return res.status(200).send(saved);
    })
    .catch((err) => handleError(err, res));
};

/*
Deletes an empty folder.

Refused with a 409 while anything is still inside, naming the counts. The alternatives -
re-parenting the contents or cascading the delete - both rearrange or destroy work in one
click with no warning, and a test case carries execution history that should not disappear
because a folder was tidied up.
 */
exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return ManualFolder.findById(req.params.folderId).lean().exec()
    .then(async (folder) => {
      if (!folder) {
        throw new NotFoundError(`No folder found with id ${req.params.folderId}`);
      }
      if (!authMiddleware.hasTeamLeadAccess(req.user, folder.team)) {
        throw new ForbiddenError('You do not have permission to delete folders for this team');
      }
      const { testCaseCount, subFolderCount } = await manualFolderUtils.getContents(folder);
      if (testCaseCount > 0 || subFolderCount > 0) {
        const parts = [];
        if (testCaseCount > 0) parts.push(`${testCaseCount} test case(s)`);
        if (subFolderCount > 0) parts.push(`${subFolderCount} sub-folder(s)`);
        throw new ConflictError(`Folder "${folder.name}" still contains ${parts.join(' and ')}. Move or delete them first.`);
      }
      await ManualFolder.deleteOne({ _id: folder._id }).exec();
      historyUtils.recordChange({
        entityType: 'folder',
        entityId: folder._id,
        team: folder.team,
        action: 'DELETE',
        changes: [{ field: 'name', from: folder.name, to: undefined }],
        user: req.user,
      });
      return res.status(200).send({ message: 'Folder deleted successfully.' });
    })
    .catch((err) => handleError(err, res));
};

/*
Files a set of test cases into a folder (or to the root, with a null folder).

Bulk rather than one call per case because moving is how a team reorganises - doing it a
case at a time would be a request per row and a partially-moved selection on any failure.
 */
exports.moveTestCases = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { testCaseIds, folder } = req.body;

  return ManualTestCase.find({ _id: { $in: testCaseIds } }).select('_id team folder title').lean()
    .exec()
    .then(async (testCases) => {
      if (testCases.length !== testCaseIds.length) {
        const found = new Set(testCases.map((testCase) => testCase._id.toString()));
        const missing = testCaseIds.filter((id) => !found.has(id.toString()));
        throw new NotFoundError(`No manual test case found with id(s): ${missing.join(', ')}`);
      }
      const teams = new Set(testCases.map((testCase) => testCase.team.toString()));
      if (teams.size > 1) {
        throw new InvalidRequestError('All test cases in a move must belong to the same team.');
      }
      const [team] = Array.from(teams);
      if (!authMiddleware.hasTeamAccess(req.user, team)) {
        throw new ForbiddenError('You do not have access to this team');
      }

      let target = null;
      if (folder) {
        const targetFolder = await ManualFolder.findById(folder).lean().exec();
        if (!targetFolder || targetFolder.team.toString() !== team) {
          throw new NotFoundError(`No folder found for this team with id ${folder}`);
        }
        target = targetFolder._id;
      }

      await ManualTestCase.updateMany(
        { _id: { $in: testCaseIds } },
        { $set: { folder: target, updatedBy: req.user ? req.user._id : undefined } },
      ).exec();

      // Filing is not content, so it burns no version - but "who moved this, and when?"
      // is still a question the history exists to answer.
      testCases.forEach((testCase) => {
        historyUtils.recordChange({
          entityType: 'testcase',
          entityId: testCase._id,
          team: testCase.team,
          action: 'MOVE',
          changes: [{
            field: 'folder',
            from: testCase.folder || null,
            to: target,
          }],
          user: req.user,
        });
      });

      log(`Moved ${testCases.length} test case(s) to folder ${target || 'root'}`);
      return res.status(200).send({
        message: `Moved ${testCases.length} test case(s).`,
        moved: testCases.length,
        folder: target,
      });
    })
    .catch((err) => handleError(err, res));
};
