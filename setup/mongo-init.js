// create angles dashboard use
db.createUser( { user: 'angleshq', pwd: '@nglesPassword', roles: ['readWrite'] });
db.auth('angleshq', '@nglesPassword');


// create collections (which don't require setup)
db.createCollection('builds');
db.createCollection('testexecutions');
db.createCollection('teams');
db.createCollection('environments');
db.createCollection('baselines');
db.createCollection('screenshots');

db.testexecutions.createIndex({ "build": 1 });
db.build.createIndex({ "team": 1 });
db.team.createIndex({"name": 1});
db.environment.createIndex({"name": 1});
db.screenshots.createIndex({ "build": 1 });
db.screenshots.createIndex({ "view": 1 });
