require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../app/models/user');
const dbConfig = require('../config/database.config.js');

const mongoURL = process.env.MONGO_URL || dbConfig.url;

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.error('Usage: node create-admin.js <username> <password>');
  process.exit(1);
}

mongoose.set('strictQuery', false);
mongoose.connect(mongoURL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(async () => {
  console.log('Connected to database.');

  const existingAdmin = await User.findOne({ username: username.toLowerCase() });
  if (existingAdmin) {
    console.error(`User '${username}' already exists.`);
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  
  const admin = new User({
    username: username.toLowerCase(),
    password: hashedPassword,
    role: 'admin',
    teams: [],
    authProvider: 'local'
  });

  await admin.save();
  console.log(`Successfully created admin user: ${username}`);
  process.exit(0);

}).catch((err) => {
  console.error('Database connection error:', err);
  process.exit(1);
});
