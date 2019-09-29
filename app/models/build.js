const mongoose = require('mongoose');

const BuildSchema = mongoose.Schema({
    environment: String,
    team: String
}, {
    timestamps: true
});

module.exports = mongoose.model('Build', BuildSchema);
