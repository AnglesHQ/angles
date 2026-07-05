const request = require('supertest');
const should = require('should');
const pino = require('pino');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const authMiddleware = require('../app/utils/auth-middleware.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

describe('User & Auth API Tests', () => {
  let adminAgent;
  let selfAgent;
  let otherAgent;
  let selfUser;
  let otherUser;
  let createdUser;
  let selfTokenId;

  before((done) => {
    // clear lingering test users
    User.deleteMany({ username: /^unit-testing/ }, (err) => {
      if (err) {
        logger.error(err);
        return done(err);
      }
      logger.info('Cleared any lingering test users');

      return Promise.all([
        bcrypt.hash('unit-testing-Password1', 10),
        bcrypt.hash('unit-testing-Password2', 10),
      ]).then(([hash1, hash2]) => {
        selfUser = new User({ username: 'unit-testing-self', password: hash1, role: 'user' });
        otherUser = new User({ username: 'unit-testing-other', password: hash2, role: 'user' });

        return Promise.all([selfUser.save(), otherUser.save()]).then(() => {
          adminAgent = request.agent(app);
          selfAgent = request.agent(app);
          otherAgent = request.agent(app);

          adminAgent
            .post(`${baseUrl}auth/login`)
            .send({ username: 'admin', password: 'admin' })
            .end((adminErr) => {
              if (adminErr) return done(adminErr);
              return selfAgent
                .post(`${baseUrl}auth/login`)
                .send({ username: 'unit-testing-self', password: 'unit-testing-Password1' })
                .end((selfErr) => {
                  if (selfErr) return done(selfErr);
                  return otherAgent
                    .post(`${baseUrl}auth/login`)
                    .send({ username: 'unit-testing-other', password: 'unit-testing-Password2' })
                    .end(done);
                });
            });
        });
      }).catch(done);
    });
  });

  after(() => {
    // clean-up created users
    User.findOneAndRemove({ _id: selfUser._id }).exec();
    User.findOneAndRemove({ _id: otherUser._id }).exec();
    if (createdUser) {
      User.findOneAndRemove({ _id: createdUser._id }).exec();
    }
  });

  describe('GET /auth/config', () => {
    it('respond with json describing the enabled auth providers', (done) => {
      request(app)
        .get(`${baseUrl}auth/config`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .end((err, res) => {
          res.body.localAuthEnabled.should.equal(true);
          if (err) throw err;
          done();
        });
    });
  });

  describe('POST /auth/login', () => {
    it('respond with 200 and the user profile when credentials are valid', (done) => {
      request(app)
        .post(`${baseUrl}auth/login`)
        .send({ username: 'unit-testing-self', password: 'unit-testing-Password1' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .end((err, res) => {
          res.body.user.username.should.equal('unit-testing-self');
          should.not.exist(res.body.user.password);
          if (err) throw err;
          done();
        });
    });

    it('respond with 401 when the password is incorrect', (done) => {
      request(app)
        .post(`${baseUrl}auth/login`)
        .send({ username: 'unit-testing-self', password: 'wrong-password' })
        .set('Accept', 'application/json')
        .expect(401, done);
    });

    it('respond with 401 for an unknown username', (done) => {
      request(app)
        .post(`${baseUrl}auth/login`)
        .send({ username: 'unit-testing-does-not-exist', password: 'whatever' })
        .set('Accept', 'application/json')
        .expect(401, done);
    });

    it('respond with 422 when the username is missing', (done) => {
      request(app)
        .post(`${baseUrl}auth/login`)
        .send({ password: 'unit-testing-Password1' })
        .set('Accept', 'application/json')
        .expect(422, done);
    });
  });

  describe('GET /auth/me', () => {
    it('respond with 401 when not authenticated', (done) => {
      request(app)
        .get(`${baseUrl}auth/me`)
        .expect(401, done);
    });

    it('respond with the logged-in user profile when authenticated', (done) => {
      selfAgent
        .get(`${baseUrl}auth/me`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          res.body.username.should.equal('unit-testing-self');
          if (err) throw err;
          done();
        });
    });
  });

  describe('POST /auth/logout', () => {
    it('logs the user out so subsequent requests are unauthenticated', (done) => {
      const agent = request.agent(app);
      agent
        .post(`${baseUrl}auth/login`)
        .send({ username: 'unit-testing-other', password: 'unit-testing-Password2' })
        .end((loginErr) => {
          if (loginErr) return done(loginErr);
          return agent
            .post(`${baseUrl}auth/logout`)
            .expect(200)
            .end((logoutErr) => {
              if (logoutErr) return done(logoutErr);
              return agent
                .get(`${baseUrl}auth/me`)
                .expect(401, done);
            });
        });
    });
  });

  describe('GET /users', () => {
    it('respond with 401 when not authenticated', (done) => {
      request(app)
        .get(`${baseUrl}users`)
        .expect(401, done);
    });

    it('respond with 403 when authenticated as a non-admin user', (done) => {
      selfAgent
        .get(`${baseUrl}users`)
        .expect(403, done);
    });

    it('respond with json containing a list of all users when authenticated as admin', (done) => {
      adminAgent
        .get(`${baseUrl}users`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .end((err, res) => {
          res.body.should.be.an.Array();
          should.not.exist(res.body[0].password);
          if (err) throw err;
          done();
        });
    });
  });

  describe('POST /users', () => {
    it('respond with 201 when an admin creates a valid local user', (done) => {
      adminAgent
        .post(`${baseUrl}users`)
        .send({ username: 'unit-testing-created', password: 'unit-testing-Password3', role: 'user' })
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(201)
        .end((err, res) => {
          createdUser = res.body;
          should.not.exist(res.body.password);
          if (err) throw err;
          done();
        });
    });

    it('respond with 403 when a non-admin user attempts to create a user', (done) => {
      selfAgent
        .post(`${baseUrl}users`)
        .send({ username: 'unit-testing-blocked', password: 'unit-testing-Password4' })
        .expect(403, done);
    });

    it('respond with 422 when the username is missing', (done) => {
      adminAgent
        .post(`${baseUrl}users`)
        .send({ password: 'unit-testing-Password4' })
        .expect(422, done);
    });

    it('respond with 422 when the username contains invalid characters', (done) => {
      adminAgent
        .post(`${baseUrl}users`)
        .send({ username: 'unit testing invalid', password: 'unit-testing-Password4' })
        .expect(422, done);
    });

    it('respond with 422 when the role is not a recognised value', (done) => {
      adminAgent
        .post(`${baseUrl}users`)
        .send({ username: 'unit-testing-badrole', password: 'unit-testing-Password4', role: 'superuser' })
        .expect(422, done);
    });

    it('respond with 422 when the password is too short', (done) => {
      adminAgent
        .post(`${baseUrl}users`)
        .send({ username: 'unit-testing-shortpw', password: 'short' })
        .expect(422, done);
    });

    it('respond with 422 when creating a local user without a password', (done) => {
      adminAgent
        .post(`${baseUrl}users`)
        .send({ username: 'unit-testing-nopassword' })
        .expect(422, done);
    });

    it('respond with 409 when the username already exists', (done) => {
      adminAgent
        .post(`${baseUrl}users`)
        .send({ username: selfUser.username, password: 'unit-testing-Password5' })
        .expect(409, done);
    });
  });

  describe('GET /users/:userId', () => {
    it('respond with 200 and the user when it exists', (done) => {
      adminAgent
        .get(`${baseUrl}users/${selfUser._id}`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          res.body.username.should.equal(selfUser.username);
          if (err) throw err;
          done();
        });
    });

    it('respond with 422 for a malformed user id', (done) => {
      adminAgent
        .get(`${baseUrl}users/not-a-valid-id`)
        .expect(422, done);
    });

    it('respond with 404 for a well-formed but non-existent user id', (done) => {
      adminAgent
        .get(`${baseUrl}users/507f1f77bcf86cd799439011`)
        .expect(404, done);
    });
  });

  describe('PUT /users/:userId', () => {
    it('respond with 200 when an admin updates a user role', (done) => {
      adminAgent
        .put(`${baseUrl}users/${selfUser._id}`)
        .send({ role: 'team_lead' })
        .expect(200)
        .end((err, res) => {
          res.body.role.should.equal('team_lead');
          if (err) throw err;
          done();
        });
    });

    it('respond with 422 when the role is not a recognised value', (done) => {
      adminAgent
        .put(`${baseUrl}users/${selfUser._id}`)
        .send({ role: 'superuser' })
        .expect(422, done);
    });

    it('respond with 403 when a non-admin user attempts to update a user', (done) => {
      otherAgent
        .put(`${baseUrl}users/${selfUser._id}`)
        .send({ role: 'admin' })
        .expect(403, done);
    });
  });

  describe('DELETE /users/:userId', () => {
    it('respond with 200 when an admin deletes an existing user', (done) => {
      adminAgent
        .delete(`${baseUrl}users/${createdUser._id}`)
        .expect(200, done);
    });

    it('respond with 404 when deleting a user that no longer exists', (done) => {
      adminAgent
        .delete(`${baseUrl}users/${createdUser._id}`)
        .expect(404, done);
    });

    it('respond with 403 when a non-admin user attempts to delete a user', (done) => {
      otherAgent
        .delete(`${baseUrl}users/${otherUser._id}`)
        .expect(403, done);
    });
  });

  describe('POST /users/:userId/tokens', () => {
    it('respond with 201 when a user generates a token for themselves', (done) => {
      selfAgent
        .post(`${baseUrl}users/${selfUser._id}/tokens`)
        .send({ name: 'unit-testing-token', expiresInDays: 30 })
        .set('Accept', 'application/json')
        .expect(201)
        .end((err, res) => {
          res.body.token.should.be.a.String();
          if (err) throw err;
          done();
        });
    });

    it('respond with 201 when an admin generates a token on behalf of another user', (done) => {
      adminAgent
        .post(`${baseUrl}users/${otherUser._id}/tokens`)
        .send({ name: 'unit-testing-admin-issued', expiresInDays: 30 })
        .expect(201, done);
    });

    it('respond with 403 when a non-admin user generates a token for someone else', (done) => {
      otherAgent
        .post(`${baseUrl}users/${selfUser._id}/tokens`)
        .send({ name: 'unit-testing-forbidden', expiresInDays: 30 })
        .expect(403, done);
    });

    it('respond with 404 when generating a token for a non-existent user', (done) => {
      adminAgent
        .post(`${baseUrl}users/507f1f77bcf86cd799439011/tokens`)
        .send({ name: 'unit-testing-missing-user', expiresInDays: 30 })
        .expect(404, done);
    });

    it('respond with 422 when the token name is missing', (done) => {
      selfAgent
        .post(`${baseUrl}users/${selfUser._id}/tokens`)
        .send({ expiresInDays: 30 })
        .expect(422, done);
    });

    it('respond with 422 when expiresInDays is out of range', (done) => {
      selfAgent
        .post(`${baseUrl}users/${selfUser._id}/tokens`)
        .send({ name: 'unit-testing-token-2', expiresInDays: 400 })
        .expect(422, done);
    });
  });

  describe('GET /users/:userId/tokens', () => {
    it('respond with token metadata but never the raw token or its hash', (done) => {
      selfAgent
        .get(`${baseUrl}users/${selfUser._id}/tokens`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          res.body.should.be.an.Array();
          const token = res.body.find((t) => t.name === 'unit-testing-token');
          should.exist(token);
          selfTokenId = token._id;
          should.not.exist(token.tokenHash);
          should.not.exist(token.token);
          if (err) throw err;
          done();
        });
    });

    it("respond with 403 when a non-admin user requests another user's tokens", (done) => {
      otherAgent
        .get(`${baseUrl}users/${selfUser._id}/tokens`)
        .expect(403, done);
    });
  });

  describe('DELETE /users/:userId/tokens/:tokenId', () => {
    it("respond with 403 when a non-admin user revokes another user's token", (done) => {
      otherAgent
        .delete(`${baseUrl}users/${selfUser._id}/tokens/${selfTokenId}`)
        .expect(403, done);
    });

    it('respond with 200 when the owner revokes their own token', (done) => {
      selfAgent
        .delete(`${baseUrl}users/${selfUser._id}/tokens/${selfTokenId}`)
        .expect(200, done);
    });

    it('respond with 404 when revoking a token that no longer exists', (done) => {
      selfAgent
        .delete(`${baseUrl}users/${selfUser._id}/tokens/${selfTokenId}`)
        .expect(404, done);
    });
  });

  describe('API Token Authentication (x-api-key)', () => {
    let apiKeyTokenString;

    before((done) => {
      selfAgent
        .post(`${baseUrl}users/${selfUser._id}/tokens`)
        .send({ name: 'unit-testing-apikey', expiresInDays: 30 })
        .end((err, res) => {
          if (err) return done(err);
          apiKeyTokenString = res.body.token;
          return done();
        });
    });

    it('allows access to non-user-management routes with a valid token', (done) => {
      request(app)
        .get(`${baseUrl}team`)
        .set('x-api-key', apiKeyTokenString)
        .expect(200, done);
    });

    it('rejects an invalid token with 401', (done) => {
      request(app)
        .get(`${baseUrl}team`)
        .set('x-api-key', 'not-a-real-token')
        .expect(401, done);
    });

    it('rejects an expired token with 401', (done) => {
      User.findById(selfUser._id, (err, freshUser) => {
        if (err) return done(err);
        const expiredTokenString = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(expiredTokenString).digest('hex');
        freshUser.apiTokens.push({
          name: 'unit-testing-expired',
          tokenHash,
          expiresAt: new Date(Date.now() - 1000),
        });
        return freshUser.save((saveErr) => {
          if (saveErr) return done(saveErr);
          return request(app)
            .get(`${baseUrl}team`)
            .set('x-api-key', expiredTokenString)
            .expect(401, done);
        });
      });
    });

    it('blocks token-authenticated requests from user-management routes (preventTokenAuth)', (done) => {
      request(app)
        .get(`${baseUrl}users/${selfUser._id}/tokens`)
        .set('x-api-key', apiKeyTokenString)
        .expect(403, done);
    });
  });

  describe('auth-middleware.hasTeamAccess', () => {
    it('grants access to admins regardless of team membership', () => {
      authMiddleware.hasTeamAccess({ role: 'admin', teams: [] }, '507f1f77bcf86cd799439011').should.equal(true);
    });

    it("grants access when the team is in the user's teams", () => {
      authMiddleware.hasTeamAccess({ role: 'user', teams: ['507f1f77bcf86cd799439011'] }, '507f1f77bcf86cd799439011').should.equal(true);
    });

    it("denies access when the team is not in the user's teams", () => {
      authMiddleware.hasTeamAccess({ role: 'user', teams: ['507f1f77bcf86cd799439011'] }, '111111111111111111111111').should.equal(false);
    });

    it('denies access when there is no user', () => {
      authMiddleware.hasTeamAccess(null, '507f1f77bcf86cd799439011').should.equal(false);
    });
  });

  describe('auth-middleware.hasTeamLeadAccess', () => {
    it('grants access to admins regardless of team membership', () => {
      authMiddleware.hasTeamLeadAccess({ role: 'admin', teams: [] }, '507f1f77bcf86cd799439011').should.equal(true);
    });

    it('grants access to a team lead for their own team', () => {
      authMiddleware.hasTeamLeadAccess({ role: 'team_lead', teams: ['507f1f77bcf86cd799439011'] }, '507f1f77bcf86cd799439011').should.equal(true);
    });

    it('denies access to a team lead for a team they do not lead', () => {
      authMiddleware.hasTeamLeadAccess({ role: 'team_lead', teams: ['507f1f77bcf86cd799439011'] }, '111111111111111111111111').should.equal(false);
    });

    it('denies access to a regular user even for their own team', () => {
      authMiddleware.hasTeamLeadAccess({ role: 'user', teams: ['507f1f77bcf86cd799439011'] }, '507f1f77bcf86cd799439011').should.equal(false);
    });
  });
});
