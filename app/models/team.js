const mongoose = require('mongoose');

const TeamSchema = mongoose.Schema({
    id: String,
    name: String
}, {
    timestamps: true
});

module.exports = mongoose.model('Team', TeamSchema);
