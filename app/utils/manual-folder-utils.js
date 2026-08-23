const debug = require('debug');
const ManualFolder = require('../models/manual-folder.js');
const ManualTestCase = require('../models/manual-test-case.js');
const { NotFoundError, InvalidRequestError } = require('../exceptions/errors.js');

const log = debug('manual-folder:utils');

const manualFolderUtils = {};

// A guard rather than a design limit. Nesting is arbitrary by intent, but a cycle or a
// runaway client should not be able to build a path the tree view cannot render.
manualFolderUtils.MAX_DEPTH = 20;

/*
Resolves a parent id to the path and depth a child of it would have.

A null parent means a root folder: empty path, depth 0.
 */
manualFolderUtils.resolvePlacement = async (parentId, team) => {
  if (!parentId) {
    return { parent: null, path: [], depth: 0 };
  }
  const parent = await ManualFolder.findById(parentId).lean().exec();
  if (!parent || parent.team.toString() !== team.toString()) {
    throw new NotFoundError(`No folder found for this team with id ${parentId}`);
  }
  const path = [...(parent.path || []), parent._id];
  if (path.length > manualFolderUtils.MAX_DEPTH) {
    throw new InvalidRequestError(`Folders cannot be nested more than ${manualFolderUtils.MAX_DEPTH} levels deep.`);
  }
  return { parent: parent._id, path, depth: path.length };
};

/*
Every folder at or below the given one, the folder itself included.

One indexed query rather than a walk per level - this is what the materialised path buys.
 */
manualFolderUtils.getSubtree = async (folder) => {
  const descendants = await ManualFolder
    .find({ team: folder.team, path: folder._id })
    .lean()
    .exec();
  return [folder, ...descendants];
};

/*
What a folder still holds, counting the whole subtree.

Used by the delete guard: deleting is refused while anything is inside, and the counts are
what let the message say what is in the way rather than just refusing.
 */
manualFolderUtils.getContents = async (folder) => {
  const subtree = await manualFolderUtils.getSubtree(folder);
  const folderIds = subtree.map((entry) => entry._id);
  const [testCaseCount, subFolderCount] = await Promise.all([
    ManualTestCase.countDocuments({ folder: { $in: folderIds } }).exec(),
    Promise.resolve(subtree.length - 1),
  ]);
  return { testCaseCount, subFolderCount };
};

/*
Rejects a move that would put a folder inside itself.

Re-parenting a folder under its own descendant detaches the whole subtree from the tree:
it becomes a ring that no root can reach, invisible to every query that starts from the
top and impossible to fix through the UI.
 */
manualFolderUtils.assertMoveIsLegal = (folder, newParent) => {
  if (!newParent) return;
  if (newParent._id.toString() === folder._id.toString()) {
    throw new InvalidRequestError('A folder cannot be moved inside itself.');
  }
  const ancestors = (newParent.path || []).map((id) => id.toString());
  if (ancestors.includes(folder._id.toString())) {
    throw new InvalidRequestError('A folder cannot be moved inside one of its own sub-folders.');
  }
};

/*
Rewrites the stored paths of a moved folder's descendants.

The subtree keeps its shape - only the ancestors above the moved folder change - so each
descendant's path has the old prefix swapped for the new one. Done in bulk: a team can
have a lot of folders and this is a single round trip.
 */
manualFolderUtils.rewriteSubtreePaths = async (folder, oldPath, newPath) => {
  const descendants = await ManualFolder
    .find({ team: folder.team, path: folder._id })
    .exec();
  if (descendants.length === 0) return 0;

  // Everything from the moved folder down keeps its shape; only the prefix above it moves.
  const rewritten = descendants.map((descendant) => {
    const suffix = (descendant.path || []).slice(oldPath.length);
    return { _id: descendant._id, path: [...newPath, ...suffix] };
  });

  // Checked before anything is written, so a move that would nest too deeply leaves the
  // tree exactly as it was.
  const deepest = Math.max(...rewritten.map((entry) => entry.path.length));
  if (deepest > manualFolderUtils.MAX_DEPTH) {
    throw new InvalidRequestError(`That move would nest folders more than ${manualFolderUtils.MAX_DEPTH} levels deep.`);
  }

  const operations = rewritten.map((entry) => ({
    updateOne: {
      filter: { _id: entry._id },
      update: { $set: { path: entry.path, depth: entry.path.length } },
    },
  }));
  await ManualFolder.bulkWrite(operations);
  log(`Rewrote paths for ${operations.length} descendant folder(s) of ${folder._id}`);
  return operations.length;
};

/*
Builds the nested tree the UI renders from a flat list.

Done here rather than in the browser so every consumer sees the same shape, and so the
counts can be attached in the same pass.
 */
manualFolderUtils.buildTree = (folders, countsByFolder = {}) => {
  const byId = new Map();
  folders.forEach((folder) => {
    byId.set(folder._id.toString(), {
      ...folder,
      testCaseCount: countsByFolder[folder._id.toString()] || 0,
      children: [],
    });
  });
  const roots = [];
  byId.forEach((node) => {
    const parentId = node.parent ? node.parent.toString() : null;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      // A folder whose parent is missing is surfaced at the root rather than dropped -
      // losing it silently would hide every test case filed under it.
      roots.push(node);
    }
  });
  const sortByName = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sortByName(node.children));
  };
  sortByName(roots);
  return roots;
};

module.exports = manualFolderUtils;
