const mongoose = require('mongoose');

const { Schema } = mongoose;

const IgnoreBox = new Schema({
  left: {
    type: Number,
    required: true,
  },
  top: {
    type: Number,
    required: true,
  },
  right: {
    type: Number,
    required: true,
  },
  bottom: {
    type: Number,
    required: true,
  },
}, { _id: false });

const Platform = new Schema({
  platformName: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  browserName: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
  deviceName: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
  },
}, { _id: false });

const BaselineSchema = mongoose.Schema({
  // The team that owns the baseline: the team of the build its screenshot came from. View
  // names are chosen freely by each team, so without this two teams using the same view
  // name would compare against (and could edit) each other's baselines. Absent only on
  // baselines written before teams were recorded until the startup backfill has run (see
  // baselineUtils.backfillTeams); those are visible to admins only.
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: false,
  },
  screenshot: {
    type: Schema.Types.ObjectId,
    ref: 'Screenshot',
    required: true,
  },
  view: {
    type: String,
    required: true,
    lowercase: true,
  },
  platform: {
    type: Platform,
    required: true,
  },
  screenHeight: {
    type: Number,
    required: false,
  },
  screenWidth: {
    type: Number,
    required: false,
  },
  ignoreBoxes: [{
    type: IgnoreBox,
    required: false,
  }],
}, {
  timestamps: true,
  collection: 'baselines',
});

BaselineSchema.index({ view: 1 }, { unique: false });
BaselineSchema.index({ team: 1, view: 1 }, { unique: false });
BaselineSchema.index({
  view: 1,
  'platform.platformName': 1,
  'platform.browserName': 1,
  'platform.deviceName': 1,
}, { unique: false });

module.exports = mongoose.model('Baseline', BaselineSchema);
