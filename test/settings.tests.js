const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const AuthSettings = require('../app/models/auth-settings.js');
const authSettingsService = require('../app/utils/auth-settings-service.js');
const { configureProviders } = require('../app/utils/passport-setup.js');
const TestOidcProvider = require('./test-oidc-provider.js');
const testUtils = require('./test-utils.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

describe('Auth Settings API Tests', () => {
  let adminAgent;
  let userAgent;
  let regularUser;
  let idp;

  before(async () => {
    idp = await new TestOidcProvider().start();
    idp.registerClient('test-client-id', 'test-secret');
  });

  after(async () => {
    await idp.stop();
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
    await User.deleteMany({ username: /@example\.(com|org)$/ }).exec();
    // Reset the singleton so the suite leaves no persisted auth config behind, then
    // reload so the in-memory authConfig returns to defaults for any other test file.
    await AuthSettings.deleteMany({}).exec();
    await authSettingsService.loadAuthSettings();
    await configureProviders();
  });

  // Builds a well-formed OIDC provider payload, overridable per test.
  const oidcProvider = (overrides = {}) => ({
    id: 'okta',
    name: 'Okta',
    type: 'oidc',
    enabled: true,
    oidc: {
      issuer: idp.issuer,
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      scopes: 'openid profile email groups',
      groupsClaim: 'groups',
      usernameClaim: 'email',
      ...(overrides.oidc || {}),
    },
    roleMappings: [
      { value: 'angles-admins', role: 'admin' },
      { value: 'angles-team-leads', role: 'team_lead' },
      { value: 'angles-users', role: 'user' },
    ],
    ...(() => { const rest = { ...overrides }; delete rest.oidc; return rest; })(),
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

    it('respond with the settings object when admin', (done) => {
      adminAgent
        .get(`${baseUrl}settings/auth`)
        .set('Accept', 'application/json')
        .expect('Content-Type', /json/)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.should.have.property('localAuthEnabled');
          res.body.should.have.property('providers');
          res.body.providers.should.be.an.Array();
          return done();
        });
    });
  });

  describe('PUT /settings/auth validation', () => {
    it('respond with 403 when a non-admin user attempts to update settings', (done) => {
      userAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [] })
        .expect(403, done);
    });

    it('respond with 422 when localAuthEnabled has an invalid type', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ localAuthEnabled: 'not-a-boolean' })
        .expect(422, done);
    });

    it('respond with 422 for an unknown provider type', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [{ id: 'weird', name: 'Weird', type: 'carrier-pigeon' }] })
        .expect(422, done);
    });

    it('respond with 422 for an invalid provider id', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [{ id: 'Not Valid!', name: 'Bad', type: 'oidc' }] })
        .expect(422, done);
    });

    it('respond with 422 for duplicate provider ids', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          providers: [
            { id: 'dupe', name: 'One', type: 'oidc' },
            { id: 'dupe', name: 'Two', type: 'oidc' },
          ],
        })
        .expect(422, done);
    });

    it('respond with 422 for an unrecognised config key', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          providers: [{
            id: 'typo', name: 'Typo', type: 'oidc', oidc: { issuerr: 'https://example.com' },
          }],
        })
        .expect(422, done);
    });

    it('respond with 422 for an invalid role in a role mapping', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          providers: [{
            id: 'roles',
            name: 'Roles',
            type: 'oidc',
            roleMappings: [{ value: 'some-group', role: 'superuser' }],
          }],
        })
        .expect(422, done);
    });
  });

  describe('PUT /settings/auth (providers)', () => {
    it('persists an OIDC provider with its role mappings', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider()] })
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.providers.should.have.length(1);
          const [provider] = res.body.providers;
          provider.id.should.equal('okta');
          provider.type.should.equal('oidc');
          provider.enabled.should.equal(true);
          provider.roleMappings.should.have.length(3);
          provider.oidc.issuer.should.equal(idp.issuer);
          // Discovery against the test IdP should have succeeded.
          res.body.providerStatus.okta.ready.should.equal(true);
          return done();
        });
    });

    it('never returns the client secret, only a flag that one is set', (done) => {
      adminAgent
        .get(`${baseUrl}settings/auth`)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          const [provider] = res.body.providers;
          provider.clientSecretSet.should.equal(true);
          should.not.exist(provider.oidc.clientSecret);
          return done();
        });
    });

    it('does not expose the secret via a normal query (select: false)', async () => {
      const doc = await AuthSettings.findOne({ singleton: 'auth' }).exec();
      should.not.exist(doc.providers[0].oidc.clientSecret);
    });

    it('persists the secret value to the database (with select override)', async () => {
      const doc = await AuthSettings.findOne({ singleton: 'auth' })
        .select('+providers.oidc.clientSecret').exec();
      doc.providers[0].oidc.clientSecret.should.equal('test-secret');
    });

    it('preserves the existing secret when saved with a blank secret field', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider({ oidc: { clientSecret: '' }, name: 'Okta Renamed' })] })
        .expect(200)
        .end(async (err, res) => {
          if (err) return done(err);
          try {
            res.body.providers[0].clientSecretSet.should.equal(true);
            res.body.providers[0].name.should.equal('Okta Renamed');
            const doc = await AuthSettings.findOne({ singleton: 'auth' })
              .select('+providers.oidc.clientSecret').exec();
            doc.providers[0].oidc.clientSecret.should.equal('test-secret');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });

    it('replaces the secret when a new non-empty value is supplied', (done) => {
      idp.registerClient('test-client-id', 'rotated-secret');
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider({ oidc: { clientSecret: 'rotated-secret' } })] })
        .expect(200)
        .end(async (err) => {
          if (err) return done(err);
          try {
            const doc = await AuthSettings.findOne({ singleton: 'auth' })
              .select('+providers.oidc.clientSecret').exec();
            doc.providers[0].oidc.clientSecret.should.equal('rotated-secret');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });

    it('removes providers that are absent from the payload', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [] })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.providers.should.have.length(0);
          return done();
        });
    });

    it('supports several providers at once', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          providers: [
            oidcProvider(),
            oidcProvider({ id: 'entra', name: 'Entra ID' }),
          ],
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.providers.should.have.length(2);
          res.body.providerStatus.okta.ready.should.equal(true);
          res.body.providerStatus.entra.ready.should.equal(true);
          return done();
        });
    });

    it('reports a provider that fails discovery without affecting the others', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          providers: [
            oidcProvider(),
            oidcProvider({ id: 'broken', name: 'Broken', oidc: { issuer: 'http://127.0.0.1:1/nope' } }),
          ],
        })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.providerStatus.okta.ready.should.equal(true);
          res.body.providerStatus.broken.ready.should.equal(false);
          should.exist(res.body.providerStatus.broken.error);
          return done();
        });
    });
  });

  describe('GET /auth/config', () => {
    before((done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider()] })
        .expect(200)
        .end(done);
    });

    it('lists the enabled providers with their login URLs and no secrets', (done) => {
      request(app)
        .get(`${baseUrl}auth/config`)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.localAuthEnabled.should.equal(true);
          res.body.providers.should.have.length(1);
          const [provider] = res.body.providers;
          provider.id.should.equal('okta');
          provider.name.should.equal('Okta');
          provider.ready.should.equal(true);
          provider.loginUrl.should.equal('/rest/api/v1.0/auth/sso/okta');
          should.not.exist(provider.oidc);
          return done();
        });
    });

    it('omits disabled providers', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider({ enabled: false })] })
        .expect(200)
        .end((err) => {
          if (err) return done(err);
          return request(app)
            .get(`${baseUrl}auth/config`)
            .expect(200)
            .end((configErr, res) => {
              if (configErr) return done(configErr);
              res.body.providers.should.have.length(0);
              return done();
            });
        });
    });
  });

  // Drives a complete authorization-code login: start at /auth/sso/:id, follow the
  // redirect to the IdP, and follow its redirect back to the callback. The ID token is
  // genuinely signed by the test IdP, so signature, issuer, audience and nonce
  // validation all run for real.
  const completeLogin = async (providerId, claims) => {
    idp.nextClaims = claims;
    // A fresh agent per login, so the PKCE verifier and state stored in the session are
    // the ones this flow created.
    const agent = request.agent(app);

    const start = await agent.get(`${baseUrl}auth/sso/${providerId}`).expect(302);

    // Follow the redirect to the IdP itself - a different server, so it needs its own
    // request rather than the app agent.
    const authorize = await request(idp.issuer)
      .get(start.headers.location.replace(idp.issuer, ''))
      .redirects(0)
      .expect(302);

    // The IdP redirects to the absolute callback URL registered with it; strip the origin
    // and replay the path against the app under test.
    const callback = authorize.headers.location.replace(/^https?:\/\/[^/]+/, '');
    const res = await agent.get(callback).redirects(0);
    return { agent, res };
  };

  describe('OIDC login flow (end to end)', () => {
    beforeEach((done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider()] })
        .expect(200)
        .end(done);
    });

    it('provisions a new user with the role mapped from the groups claim', async () => {
      const { agent, res } = await completeLogin('okta', {
        sub: 'okta-1',
        email: 'Mapped.Admin@example.com',
        groups: ['angles-admins'],
      });
      res.status.should.equal(302);
      res.headers.location.should.equal('/');

      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      // The username is normalised to lower case.
      me.body.username.should.equal('mapped.admin@example.com');
      me.body.role.should.equal('admin');
      me.body.authProvider.should.equal('okta');
    });

    it('grants the strongest role when the user matches several mappings', async () => {
      const { agent } = await completeLogin('okta', {
        sub: 'okta-2',
        email: 'multi@example.com',
        groups: ['angles-users', 'angles-admins', 'angles-team-leads'],
      });
      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      me.body.role.should.equal('admin');
    });

    it('matches group names case-insensitively', async () => {
      const { agent } = await completeLogin('okta', {
        sub: 'okta-3',
        email: 'casing@example.com',
        groups: ['ANGLES-Team-Leads'],
      });
      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      me.body.role.should.equal('team_lead');
    });

    it('syncs the role on a subsequent login when group membership changes', async () => {
      await completeLogin('okta', {
        sub: 'okta-4', email: 'promoted@example.com', groups: ['angles-users'],
      });
      const first = await User.findOne({ username: 'promoted@example.com' });
      first.role.should.equal('user');

      const { agent } = await completeLogin('okta', {
        sub: 'okta-4', email: 'promoted@example.com', groups: ['angles-admins'],
      });
      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      me.body.role.should.equal('admin');
    });

    it('denies a user who is in none of the mapped groups', async () => {
      const { agent, res } = await completeLogin('okta', {
        sub: 'okta-5', email: 'nobody@example.com', groups: ['some-other-group'],
      });
      res.headers.location.should.equal('/login?error=true');
      await agent.get(`${baseUrl}auth/me`).expect(401);
      should.not.exist(await User.findOne({ username: 'nobody@example.com' }));
    });

    it('grants defaultRole when configured and no mapping matches', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider({ defaultRole: 'user' })] })
        .expect(200)
        .end(async (err) => {
          if (err) return done(err);
          try {
            const { agent } = await completeLogin('okta', {
              sub: 'okta-6', email: 'fallback@example.com', groups: ['unmapped'],
            });
            const me = await agent.get(`${baseUrl}auth/me`).expect(200);
            me.body.role.should.equal('user');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });

    it('refuses to take over a username held by a local account', async () => {
      const { agent, res } = await completeLogin('okta', {
        sub: 'okta-7',
        email: testUtils.ADMIN_USERNAME,
        groups: ['angles-users'],
      });
      res.headers.location.should.equal('/login?error=true');
      await agent.get(`${baseUrl}auth/me`).expect(401);
      // The local admin is untouched.
      const admin = await User.findOne({ username: testUtils.ADMIN_USERNAME });
      admin.role.should.equal('admin');
      admin.authProvider.should.equal('local');
    });

    it('reads groups from a namespaced claim when configured', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          providers: [oidcProvider({
            oidc: { groupsClaim: 'https://angles.example/groups' },
          })],
        })
        .expect(200)
        .end(async (err) => {
          if (err) return done(err);
          try {
            const { agent } = await completeLogin('okta', {
              sub: 'okta-8',
              email: 'namespaced@example.com',
              'https://angles.example/groups': ['angles-admins'],
            });
            const me = await agent.get(`${baseUrl}auth/me`).expect(200);
            me.body.role.should.equal('admin');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });

    it('supports a non-email username claim', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider({ oidc: { usernameClaim: 'preferred_username' } })] })
        .expect(200)
        .end(async (err) => {
          if (err) return done(err);
          try {
            const { agent } = await completeLogin('okta', {
              sub: 'okta-9',
              preferred_username: 'sam.tester',
              email: 'ignored@example.com',
              groups: ['angles-users'],
            });
            const me = await agent.get(`${baseUrl}auth/me`).expect(200);
            me.body.username.should.equal('sam.tester');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });

    it('matches Entra-style group GUIDs when mapped by GUID', (done) => {
      const guid = '11111111-2222-3333-4444-555555555555';
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          providers: [oidcProvider({
            roleMappings: [{ value: guid, role: 'admin' }],
          })],
        })
        .expect(200)
        .end(async (err) => {
          if (err) return done(err);
          try {
            const { agent } = await completeLogin('okta', {
              sub: 'entra-1', email: 'guid@example.com', groups: [guid],
            });
            const me = await agent.get(`${baseUrl}auth/me`).expect(200);
            me.body.role.should.equal('admin');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });

    it('keeps separate accounts for the same email from different providers', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider(), oidcProvider({ id: 'entra', name: 'Entra ID' })] })
        .expect(200)
        .end(async (err) => {
          if (err) return done(err);
          try {
            await completeLogin('okta', {
              sub: 's1', email: 'shared@example.org', groups: ['angles-users'],
            });
            // The second provider must not silently adopt the first provider's user.
            const { agent, res } = await completeLogin('entra', {
              sub: 's2', email: 'shared@example.org', groups: ['angles-admins'],
            });
            res.headers.location.should.equal('/login?error=true');
            await agent.get(`${baseUrl}auth/me`).expect(401);
            const user = await User.findOne({ username: 'shared@example.org' });
            user.authProvider.should.equal('okta');
            user.role.should.equal('user');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        });
    });
  });

  describe('GET /auth/sso/:providerId (runtime enablement)', () => {
    it('returns 404 for an unknown provider', (done) => {
      request(app).get(`${baseUrl}auth/sso/does-not-exist`).expect(404, done);
    });

    it('returns 404 when the provider is disabled', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider({ enabled: false })] })
        .expect(200)
        .end((err) => {
          if (err) return done(err);
          return request(app).get(`${baseUrl}auth/sso/okta`).expect(404, done);
        });
    });

    it('returns 503 when the provider is enabled but misconfigured', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider({ id: 'broken', name: 'Broken', oidc: { issuer: 'http://127.0.0.1:1/nope' } })] })
        .expect(200)
        .end((err) => {
          if (err) return done(err);
          return request(app).get(`${baseUrl}auth/sso/broken`).expect(503, done);
        });
    });

    it('redirects to the discovered authorize endpoint with PKCE once configured', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        // Deliberately include a trailing slash to verify issuer normalisation.
        .send({ providers: [oidcProvider({ oidc: { issuer: `${idp.issuer}/` } })] })
        .expect(200)
        .end((err) => {
          if (err) return done(err);
          return request(app)
            .get(`${baseUrl}auth/sso/okta`)
            .expect(302)
            .end((redirectErr, res) => {
              if (redirectErr) return done(redirectErr);
              const { location } = res.headers;
              location.should.startWith(`${idp.issuer}/v1/authorize`);
              location.should.containEql('code_challenge=');
              location.should.containEql('code_challenge_method=S256');
              location.should.containEql('state=');
              location.should.containEql('scope=openid%20profile%20email%20groups');
              return done();
            });
        });
    });

    it('adds the mandatory openid scope when an admin omits it', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({ providers: [oidcProvider({ oidc: { scopes: 'profile email' } })] })
        .expect(200)
        .end((err) => {
          if (err) return done(err);
          return request(app)
            .get(`${baseUrl}auth/sso/okta`)
            .expect(302)
            .end((redirectErr, res) => {
              if (redirectErr) return done(redirectErr);
              res.headers.location.should.containEql('scope=openid%20profile%20email');
              return done();
            });
        });
    });
  });
});
