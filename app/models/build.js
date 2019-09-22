const mongoose = require('mongoose');

const BuildSchema = mongoose.Schema({
    id: String,
    environment: String
}, {
    timestamps: true
});

module.exports = mongoose.model('Build', BuildSchema);