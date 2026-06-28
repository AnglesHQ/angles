// create angles dashboard use
db.createUser({ user: 'angleshq', pwd: '@nglesPassword', roles: ['readWrite'] });
db.auth('angleshq', '@nglesPassword');


// create collections (which don't require setup)
db.createCollection('builds');
db.createCollection('testexecutions');
db.createCollection('teams');
db.createCollection('phase');
db.createCollection('environments');
db.createCollection('baselines');
db.createCollection('screenshots');
db.createCollection('users');

// Insert a default admin user with username 'admin' and password 'admin'
// The password must be pre-hashed using bcrypt since mongo shell cannot run bcrypt.
db.users.insertOne({
  username: "admin",
  password: "$2b$10$OeYsxUK5BMB2mFDU9BKc1..n17Rqdu7kAg9rAYNQUxqfVA1f2193W", // 'admin'
  role: "admin",
  teams: [],
  authProvider: "local",
  createdAt: new Date(),
  updatedAt: new Date()
});

db.testexecutions.createIndex({ build: 1 });
db.testexecutions.createIndex({ suite: 1, title: 1 });
db.build.createIndex({ team: 1 });
db.team.createIndex({ name: 1 });
db.phase.createIndex({ name: 1 });
db.environment.createIndex({ name: 1 });
db.screenshots.createIndex({ build: 1 });
db.screenshots.createIndex({ view: 1 });
