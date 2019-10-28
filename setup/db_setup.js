// create dashboard user
db.createUser( { user: 'qac', pwd: 'Q@cPassword', roles: ['readWrite'] });
db.auth('qac', 'Q@cPassword');

// create collections (which don't require setup)
db.createCollection('builds');
db.createCollection('executions');
db.createCollection('teams');
db.createCollection('environments');
