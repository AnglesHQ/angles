const mongoose = require('mongoose');

const { Schema } = mongoose;

const fieldTypes = ['text', 'textarea', 'number', 'date', 'boolean', 'select', 'multiselect', 'user'];
const fieldScopes = ['testcase', 'execution', 'both'];

// Types whose value must come from the definition's `options` list.
const optionBackedTypes = ['select', 'multiselect'];

// An admin-configured extra field for a team's manual test cases.
//
// `key` is the stable storage key - it is what a test case's `customFields` map is keyed
// by, and what a frozen version records - so it is immutable once created. `label` is the
// display name and can be changed freely; every version snapshot keeps the label that was
// in force when it was written, so relabelling never rewrites history.
const CustomFieldDefinitionSchema = mongoose.Schema({
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  key: {
    type: String,
    required: true,
    trim: true,
    match: [
      /^[a-z][a-z0-9_]{0,39}$/,
      'Field key must start with a lowercase letter and contain only lowercase letters, numbers and underscores (max 40 characters).',
    ],
  },
  label: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },
  type: {
    type: String,
    enum: fieldTypes,
    required: true,
  },
  // Required for select/multiselect, ignored otherwise.
  options: [{
    type: String,
    required: false,
    trim: true,
  }],
  // Enforced only when a test case is saved with a status other than DRAFT, so a
  // half-written draft can always be saved.
  required: {
    type: Boolean,
    default: false,
  },
  defaultValue: {
    type: Schema.Types.Mixed,
    required: false,
  },
  order: {
    type: Number,
    required: false,
  },
  // Which entity the field applies to. Only 'testcase' and 'both' are consumed today;
  // 'execution' becomes meaningful when manual runs land.
  appliesTo: {
    type: String,
    enum: fieldScopes,
    default: 'testcase',
  },
  // Archived fields are hidden from authoring but still resolve for historical values, so
  // a field that has been used somewhere is archived rather than deleted.
  archived: {
    type: Boolean,
    default: false,
  },
}, {
  timestamps: true,
  collection: 'customfielddefinitions',
});

// A key identifies a field within a team, including archived ones - reusing the key of an
// archived field would make its historical values ambiguous.
CustomFieldDefinitionSchema.index({ team: 1, key: 1 }, { unique: true });
CustomFieldDefinitionSchema.index({ team: 1, archived: 1 }, { unique: false });

module.exports = mongoose.model('CustomFieldDefinition', CustomFieldDefinitionSchema);
module.exports.fieldTypes = fieldTypes;
module.exports.fieldScopes = fieldScopes;
module.exports.optionBackedTypes = optionBackedTypes;
