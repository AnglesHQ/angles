const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const http = require('http');
const app = require('../server.js');
const User = require('../app/models/user.js');
const AuthSettings = require('../app/models/auth-settings.js');
const authSettingsService = require('../app/utils/auth-settings-service.js');
const testUtils = require('./test-utils.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

describe('Auth Settings API Tests', () => {
  let adminAgent;
  let userAgent;
  let regularUser;

  // A minimal fake OIDC provider so the client can perform real discovery
  // (.well-known/openid-configuration) without reaching out to a live Okta tenant.
  let oidcServer;
  let oidcIssuer;

  before((done) => {
    oidcServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer: oidcIssuer,
          authorization_endpoint: `${oidcIssuer}/v1/authorize`,
          token_endpoint: `${oidcIssuer}/v1/token`,
          userinfo_endpoint: `${oidcIssuer}/v1/userinfo`,
          jwks_uri: `${oidcIssuer}/v1/keys`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'profile', 'email', 'groups'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          code_challenge_methods_supported: ['S256'],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    oidcServer.listen(0, '127.0.0.1', () => {
      oidcIssuer = `http://127.0.0.1:${oidcServer.address().port}`;
      done();
    });
  });

  after((done) => {
    oidcServer.close(done);
  });

  before((done) => {
    User.deleteMany({ username: /^settings-testing/ }, (err) => {
      if (err) {
        logger.error(err);
        return done(err);
      }

      return bcrypt.hash('settings-testing-Password1', 10).then((hash) => {
        regularUser = new User({ username: 'settings-testing-user', password: hash, role: 'user' });

        return regularUser.save()
          .then(() => testUtils.getAdminAgent())
          .then((agent) => {
            adminAgent = agent;
            userAgent = request.agent(app);
            userAgent
              .post(`${baseUrl}auth/login`)
              .send({ username: 'settings-testing-user', password: 'settings-testing-Password1' })
              .end(done);
          });
      }).catch(done);
    });
  });

  after(async () => {
    await User.findOneAndRemove({ _id: regularUser._id }).exec();
    // Reset the singleton so the suite leaves no persisted auth config behind, then
    // reload so the in-memory authConfig returns to defaults for any other test file.
    await AuthSettings.deleteMany({}).exec();
    await authSettingsService.loadAuthSettings();
  });

  describe('GET /settings/auth', () => {
    it('respond with 401 when not authenticated', (done) => {
      request(app)
        .get(`${baseUrl}settings/auth`)
        .expect(401, done);
    });

    it('respond with 403 when authenticated as a non-admin user', (done) => {
      userAgent
        .get(`${baseUrl}settings/auth`)
        .expect(403, done);
    });

    it('respond with the settings object (and never a client secret) when admin', (done) => {
      adminAgent
        .get(`${baseUrl}settings/auth`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .end((err, res) => {
          res.body.should.have.property('localAuthEnabled');
          res.body.should.have.property('oktaAuthEnabled');
          res.body.should.have.property('oktaAdminGroup');
          res.body.should.have.property('oktaTeamLeadGroup');
          res.body.should.have.property('oktaUserGroup');
          res.body.should.have.property('oktaClientSecretSet');
          should.not.exist(res.body.oktaClientSecret);
          if (err) throw err;
          done();
        });
    });
  });

  describe('PUT /settings/auth', () => {
    it('respond with 403 when a non-admin user attempts to update settings', (done) => {
      userAgent
        .put(`${baseUrl}settings/auth`)
        .send({ oktaAdminGroup: 'hackers' })
        .expect(403, done);
    });

    it('respond with 422 when a field has an invalid type', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ oktaAuthEnabled: 'not-a-boolean' })
        .expect(422, done);
    });

    it('persists the okta group to role mapping when updated by an admin', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          oktaAuthEnabled: true,
          oktaIssuer: oidcIssuer,
          oktaClientId: 'test-client-id',
          oktaAdminGroup: 'angles-admins',
          oktaTeamLeadGroup: 'angles-team-leads',
          oktaUserGroup: 'angles-users',
        })
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          res.body.oktaAuthEnabled.should.equal(true);
          res.body.oktaAdminGroup.should.equal('angles-admins');
          res.body.oktaTeamLeadGroup.should.equal('angles-team-leads');
          res.body.oktaUserGroup.should.equal('angles-users');
          if (err) throw err;
          done();
        });
    });

    it('reflects the persisted values on a subsequent GET', (done) => {
      adminAgent
        .get(`${baseUrl}settings/auth`)
        .expect(200)
        .end((err, res) => {
          res.body.oktaAdminGroup.should.equal('angles-admins');
          res.body.oktaTeamLeadGroup.should.equal('angles-team-leads');
          res.body.oktaUserGroup.should.equal('angles-users');
          if (err) throw err;
          done();
        });
    });

    it('surfaces the oktaAuthEnabled toggle through /auth/config', (done) => {
      request(app)
        .get(`${baseUrl}auth/config`)
        .expect(200)
        .end((err, res) => {
          res.body.oktaAuthEnabled.should.equal(true);
          if (err) throw err;
          done();
        });
    });
  });

  describe('PUT /settings/auth (write-only client secret)', () => {
    it('stores the client secret but never returns its value', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ oktaClientSecret: 'super-secret-value' })
        .expect(200)
        .end((err, res) => {
          res.body.oktaClientSecretSet.should.equal(true);
          should.not.exist(res.body.oktaClientSecret);
          if (err) throw err;
          done();
        });
    });

    it('persists the secret value to the database (with select override)', async () => {
      const doc = await AuthSettings.findOne({ singleton: 'auth' }).select('+oktaClientSecret').exec();
      doc.oktaClientSecret.should.equal('super-secret-value');
    });

    it('does not expose the secret via a normal query (select: false)', async () => {
      const doc = await AuthSettings.findOne({ singleton: 'auth' }).exec();
      should.not.exist(doc.oktaClientSecret);
    });

    it('preserves the existing secret when saved with a blank secret field', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ oktaClientSecret: '', oktaAdminGroup: 'angles-admins-changed' })
        .expect(200)
        .end(async (err, res) => {
          if (err) return done(err);
          try {
            res.body.oktaClientSecretSet.should.equal(true);
            res.body.oktaAdminGroup.should.equal('angles-admins-changed');
            const doc = await AuthSettings.findOne({ singleton: 'auth' }).select('+oktaClientSecret').exec();
            doc.oktaClientSecret.should.equal('super-secret-value');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });

    it('replaces the secret when a new non-empty value is supplied', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ oktaClientSecret: 'rotated-secret' })
        .expect(200)
        .end(async (err) => {
          if (err) return done(err);
          try {
            const doc = await AuthSettings.findOne({ singleton: 'auth' }).select('+oktaClientSecret').exec();
            doc.oktaClientSecret.should.equal('rotated-secret');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });
  });

  describe('GET /auth/okta (runtime enablement)', () => {
    it('returns 404 when Okta is disabled', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ oktaAuthEnabled: false })
        .expect(200)
        .end((err) => {
          if (err) return done(err);
          return request(app).get(`${baseUrl}auth/okta`).expect(404, done);
        });
    });

    it('redirects to the discovered Okta authorize endpoint with PKCE once enabled and configured', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          oktaAuthEnabled: true,
          // Deliberately include a trailing slash to verify issuer normalisation before discovery.
          oktaIssuer: `${oidcIssuer}/`,
          oktaClientId: 'test-client-id',
          oktaClientSecret: 'test-secret',
        })
        .expect(200)
        .end((err) => {
          if (err) return done(err);
          return request(app)
            .get(`${baseUrl}auth/okta`)
            .expect(302)
            .end((redirectErr, res) => {
              if (redirectErr) return done(redirectErr);
              const { location } = res.headers;
              // Endpoint comes from OIDC discovery, built on the normalised issuer.
              location.should.startWith(`${oidcIssuer}/v1/authorize`);
              // PKCE (S256) code challenge and CSRF state are present.
              location.should.containEql('code_challenge=');
              location.should.containEql('code_challenge_method=S256');
              location.should.containEql('state=');
              // The required openid scope is present exactly once (not duplicated).
              location.should.containEql('scope=openid%20profile%20email%20groups');
              return done();
            });
        });
    });
  });
});
