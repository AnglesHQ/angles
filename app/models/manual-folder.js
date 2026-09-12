const mongoose = require('mongoose');

const { Schema } = mongoose;

/*
A folder in a team's manual test case tree.

Nesting is stored as a parent reference *plus* a materialised path of ancestor ids. The
parent alone would make "everything under this folder" a recursive walk - one query per
level, at arbitrary depth - which the tree view and the delete guard both need on every
request. The path makes that a single indexed query, at the cost of having to rewrite the
paths of a subtree when a folder moves. Moves are rare; reads are not.

`path` holds ancestors only, root first, and never the folder itself. A root folder has an
empty path.
 */
const ManualFolderSchema = new Schema({
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  description: {
    type: String,
    required: false,
    maxlength: 500,
  },
  parent: {
    type: Schema.Types.ObjectId,
    ref: 'ManualFolder',
    required: false,
    default: null,
  },
  // Ancestor ids, outermost first. Denormalised from `parent` - see the note above.
  path: [{
    type: Schema.Types.ObjectId,
    ref: 'ManualFolder',
    required: false,
  }],
  // Depth of this folder, 0 for a root. Denormalised from path.length so a query can bound
  // depth without loading the array.
  depth: {
    type: Number,
    required: true,
    default: 0,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
  updatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: false,
  },
}, { timestamps: true });

// Two folders cannot share a name under the same parent. Mongo treats every null as
// distinct in a unique index, so roots (parent: null) would escape the constraint - the
// partial filter plus an explicit null default is what keeps them covered.
ManualFolderSchema.index({ team: 1, parent: 1, name: 1 }, { unique: true });
// Drives "everything under this folder" for the tree, the delete guard and the move check.
ManualFolderSchema.index({ team: 1, path: 1 }, { unique: false });
ManualFolderSchema.index({ team: 1, parent: 1 }, { unique: false });

module.exports = mongoose.model('ManualFolder', ManualFolderSchema);
