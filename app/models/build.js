const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const BuildSchema = Schema({
    environment: { type: Schema.Types.ObjectId, ref: 'Environment' },
    team: { type: Schema.Types.ObjectId, ref: 'Team' },
    name: { type: String, required: false }
}, {
    timestamps: true
});

module.exports = mongoose.model('Build', BuildSchema);
