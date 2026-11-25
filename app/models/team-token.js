const mongoose = require('mongoose');

const { Schema } = mongoose;

/*
 * An API token that belongs to a team rather than to a person, for the automation
 * pipelines that report the team's test results.
 *
 * A personal token acts as the user who created it: it can reach every team that user
 * can, and it stops working when they leave or their access changes. A team token acts
 * as a member of its one team, keeps working whoever comes and goes, and can only report
 * results (see auth-middleware.js for what exactly it may do).
 *
 * Only the SHA-256 hash of the token is stored; the token itself is shown once, when it
 * is created. Team leads of the team and admins manage them (see team.controller.js).
 */
const TeamTokenSchema = new Schema({
  team: {
    type: Schema.Types.ObjectId,
    ref: 'Team',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  tokenHash: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  // Who created it, kept by name too so the list still reads well after the account is
  // deleted.
  createdBy: {
    type: new Schema({
      user: { type: Schema.Types.ObjectId, ref: 'User', required: false },
      username: { type: String, required: false },
    }, { _id: false }),
    required: false,
  },
  // When a request last authenticated with it, to the hour (see auth-middleware.js): enough
  // to tell whether a pipeline still uses it, without a write on every request.
  lastUsedAt: {
    type: Date,
    required: false,
  },
}, {
  timestamps: true,
  collection: 'teamtokens',
});

// Every team-token request looks the token up by its hash.
TeamTokenSchema.index({ tokenHash: 1 }, { unique: true });
// A team's tokens are listed by team, and their names must be told apart in that list.
TeamTokenSchema.index({ team: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('TeamToken', TeamTokenSchema);
