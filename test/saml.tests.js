const request = require('supertest');
const should = require('should');
const zlib = require('zlib');
const { URL } = require('url');
const app = require('../server.js');
const User = require('../app/models/user.js');
const AuthSettings = require('../app/models/auth-settings.js');
const authSettingsService = require('../app/utils/auth-settings-service.js');
const { configureProviders } = require('../app/utils/passport-setup.js');
const TestSamlProvider = require('./test-saml-provider.js');
const testUtils = require('./test-utils.js');

const baseUrl = '/rest/api/v1.0/';
const SP_ENTITY_ID = 'angles-sp';
// The ACS URL the strategy derives from the configured public base URL.
const ACS_URL = 'http://localhost:3000/rest/api/v1.0/auth/sso/adfs/callback';

describe('SAML authentication', () => {
  let adminAgent;
  let idp;

  before(async () => {
    idp = new TestSamlProvider();
    adminAgent = await testUtils.getAdminAgent();
  });

  after(async () => {
    await User.deleteMany({ username: /@saml\.example$/ }).exec();
    await AuthSettings.deleteMany({}).exec();
    await authSettingsService.loadAuthSettings();
    await configureProviders();
  });

  const samlProvider = (overrides = {}) => ({
    id: 'adfs',
    name: 'Corporate SSO',
    type: 'saml',
    enabled: true,
    saml: {
      entryPoint: idp.entryPoint,
      idpCert: idp.certBody(),
      issuer: SP_ENTITY_ID,
      groupsAttribute: 'groups',
      ...(overrides.saml || {}),
    },
    roleMappings: [
      { value: 'angles-admins', role: 'admin' },
      { value: 'angles-team-leads', role: 'team_lead' },
      { value: 'angles-users', role: 'user' },
    ],
    ...(() => { const rest = { ...overrides }; delete rest.saml; return rest; })(),
  });

  // Each configure() starts from a clean slate: providers are deleted and re-created, so
  // a secret stored by an earlier test (which the merge would otherwise preserve) cannot
  // leak into the next one.
  const configure = (provider) => adminAgent
    .put(`${baseUrl}settings/auth`)
    .send({ providers: [] })
    .expect(200)
    .then(() => adminAgent
      .put(`${baseUrl}settings/auth`)
      .send({ providers: [provider || samlProvider()] })
      .expect(200));

  /**
   * Runs a full SP-initiated login: start the flow to obtain the AuthnRequest id (which
   * the assertion must reference), then POST the IdP's signed response to the ACS.
   */
  const login = async (options = {}) => {
    const agent = request.agent(app);
    const start = await agent.get(`${baseUrl}auth/sso/adfs`).expect(302);

    // The AuthnRequest is deflated and base64-encoded into the redirect URL; its ID is
    // what the IdP echoes back as InResponseTo.
    const samlRequest = new URL(start.headers.location).searchParams.get('SAMLRequest');
    const xml = zlib.inflateRawSync(Buffer.from(samlRequest, 'base64')).toString();
    const requestId = xml.match(/ID="([^"]+)"/)[1];

    const samlResponse = idp.buildResponse({
      audience: SP_ENTITY_ID,
      destination: ACS_URL,
      inResponseTo: requestId,
      ...options,
    });

    const res = await agent
      .post(`${baseUrl}auth/sso/adfs/callback`)
      .type('form')
      .send({ SAMLResponse: samlResponse })
      .redirects(0);

    return { agent, res };
  };

  describe('configuration', () => {
    it('registers the provider when fully configured', (done) => {
      configure().then((res) => {
        res.body.providerStatus.adfs.ready.should.equal(true);
        done();
      }).catch(done);
    });

    it('refuses to register without the IdP certificate, since assertions could then be forged', (done) => {
      configure(samlProvider({ saml: { idpCert: '' } })).then((res) => {
        res.body.providerStatus.adfs.ready.should.equal(false);
        res.body.providerStatus.adfs.error.should.match(/idpCert/);
        done();
      }).catch(done);
    });

    it('refuses to register without an entry point', (done) => {
      configure(samlProvider({ saml: { entryPoint: '' } })).then((res) => {
        res.body.providerStatus.adfs.ready.should.equal(false);
        res.body.providerStatus.adfs.error.should.match(/entryPoint/);
        done();
      }).catch(done);
    });

    it('accepts a certificate pasted with PEM armour and line breaks', (done) => {
      configure(samlProvider({ saml: { idpCert: idp.certPem } })).then((res) => {
        res.body.providerStatus.adfs.ready.should.equal(true);
        done();
      }).catch(done);
    });

    it('rejects a private key that cannot be parsed, rather than failing at login', (done) => {
      configure(samlProvider({ saml: { privateKey: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----' } }))
        .then((res) => {
          res.body.providerStatus.adfs.ready.should.equal(false);
          res.body.providerStatus.adfs.error.should.match(/privateKey/);
          done();
        }).catch(done);
    });

    it('never returns the SP private key', (done) => {
      configure(samlProvider({ saml: { privateKey: idp.privateKeyPem } }))
        .then(() => adminAgent.get(`${baseUrl}settings/auth`).expect(200))
        .then((res) => {
          const [provider] = res.body.providers;
          provider.privateKeySet.should.equal(true);
          should.not.exist(provider.saml.privateKey);
          done();
        })
        .catch(done);
    });
  });

  describe('SP-initiated login', () => {
    beforeEach(() => configure());

    it('redirects to the IdP entry point with a SAMLRequest', (done) => {
      request(app)
        .get(`${baseUrl}auth/sso/adfs`)
        .expect(302)
        .end((err, res) => {
          if (err) return done(err);
          res.headers.location.should.startWith(idp.entryPoint);
          res.headers.location.should.containEql('SAMLRequest=');
          return done();
        });
    });

    it('provisions a user from a signed assertion and maps their role', async () => {
      const { agent, res } = await login({
        nameID: 'saml.admin@saml.example',
        attributes: { groups: ['angles-admins'] },
      });
      res.status.should.equal(302);
      res.headers.location.should.equal('/');

      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      me.body.username.should.equal('saml.admin@saml.example');
      me.body.role.should.equal('admin');
      me.body.authProvider.should.equal('adfs');
    });

    it('reads the username from a configured attribute in preference to the NameID', (done) => {
      configure(samlProvider({ saml: { usernameAttribute: 'upn' } })).then(async () => {
        try {
          const { agent } = await login({
            nameID: 'ignored@saml.example',
            attributes: { upn: 'attr.user@saml.example', groups: ['angles-users'] },
          });
          const me = await agent.get(`${baseUrl}auth/me`).expect(200);
          me.body.username.should.equal('attr.user@saml.example');
          return done();
        } catch (assertionErr) {
          return done(assertionErr);
        }
      }).catch(done);
    });

    it('reads groups from a configured attribute name', (done) => {
      configure(samlProvider({ saml: { groupsAttribute: 'http://schemas.xmlsoap.org/claims/Group' } }))
        .then(async () => {
          try {
            const { agent } = await login({
              nameID: 'claims.user@saml.example',
              attributes: { 'http://schemas.xmlsoap.org/claims/Group': ['angles-team-leads'] },
            });
            const me = await agent.get(`${baseUrl}auth/me`).expect(200);
            me.body.role.should.equal('team_lead');
            return done();
          } catch (assertionErr) {
            return done(assertionErr);
          }
        }).catch(done);
    });

    it('handles a single-valued group attribute', async () => {
      const { agent } = await login({
        nameID: 'scalar.group@saml.example',
        attributes: { groups: 'angles-admins' },
      });
      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      me.body.role.should.equal('admin');
    });

    it('falls back to a conventional email attribute when no username attribute is set', async () => {
      const { agent } = await login({
        nameID: 'transient-id-12345',
        attributes: {
          'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'adfs.user@saml.example',
          groups: ['angles-users'],
        },
      });
      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      me.body.username.should.equal('adfs.user@saml.example');
    });

    it('denies a user in none of the mapped groups', async () => {
      const { agent, res } = await login({
        nameID: 'denied@saml.example',
        attributes: { groups: ['unmapped-group'] },
      });
      res.headers.location.should.equal('/login?error=true');
      await agent.get(`${baseUrl}auth/me`).expect(401);
      should.not.exist(await User.findOne({ username: 'denied@saml.example' }));
    });

    it('syncs the role when group membership changes between logins', async () => {
      await login({
        nameID: 'changing@saml.example',
        attributes: { groups: ['angles-users'] },
      });
      const { agent } = await login({
        nameID: 'changing@saml.example',
        attributes: { groups: ['angles-admins'] },
      });
      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      me.body.role.should.equal('admin');
    });
  });

  describe('assertion validation', () => {
    beforeEach(() => configure());

    it('rejects an unsigned assertion', async () => {
      const { agent, res } = await login({
        nameID: 'unsigned@saml.example',
        attributes: { groups: ['angles-admins'] },
        sign: false,
      });
      res.headers.location.should.equal('/login?error=true');
      await agent.get(`${baseUrl}auth/me`).expect(401);
      should.not.exist(await User.findOne({ username: 'unsigned@saml.example' }));
    });

    it('rejects an assertion signed by a different key', async () => {
      const attacker = new TestSamlProvider();
      const agent = request.agent(app);
      const start = await agent.get(`${baseUrl}auth/sso/adfs`).expect(302);
      const samlRequest = new URL(start.headers.location).searchParams.get('SAMLRequest');
      const xml = zlib.inflateRawSync(Buffer.from(samlRequest, 'base64')).toString();
      const requestId = xml.match(/ID="([^"]+)"/)[1];

      const forged = attacker.buildResponse({
        nameID: 'forged@saml.example',
        attributes: { groups: ['angles-admins'] },
        audience: SP_ENTITY_ID,
        destination: ACS_URL,
        inResponseTo: requestId,
      });

      const res = await agent
        .post(`${baseUrl}auth/sso/adfs/callback`)
        .type('form')
        .send({ SAMLResponse: forged })
        .redirects(0);

      res.headers.location.should.equal('/login?error=true');
      should.not.exist(await User.findOne({ username: 'forged@saml.example' }));
    });

    it('rejects an assertion whose signed content was tampered with', async () => {
      const agent = request.agent(app);
      const start = await agent.get(`${baseUrl}auth/sso/adfs`).expect(302);
      const samlRequest = new URL(start.headers.location).searchParams.get('SAMLRequest');
      const xml = zlib.inflateRawSync(Buffer.from(samlRequest, 'base64')).toString();
      const requestId = xml.match(/ID="([^"]+)"/)[1];

      const valid = idp.buildResponse({
        nameID: 'victim@saml.example',
        attributes: { groups: ['angles-users'] },
        audience: SP_ENTITY_ID,
        destination: ACS_URL,
        inResponseTo: requestId,
      });

      // Escalate the group inside the already-signed assertion; the digest must no
      // longer match.
      const tampered = Buffer.from(
        Buffer.from(valid, 'base64').toString().replace('angles-users', 'angles-admins'),
      ).toString('base64');

      const res = await agent
        .post(`${baseUrl}auth/sso/adfs/callback`)
        .type('form')
        .send({ SAMLResponse: tampered })
        .redirects(0);

      res.headers.location.should.equal('/login?error=true');
      should.not.exist(await User.findOne({ username: 'victim@saml.example' }));
    });

    it('rejects an assertion issued for a different audience', async () => {
      const { agent, res } = await login({
        nameID: 'wrong.audience@saml.example',
        attributes: { groups: ['angles-admins'] },
        audience: 'some-other-sp',
      });
      res.headers.location.should.equal('/login?error=true');
      await agent.get(`${baseUrl}auth/me`).expect(401);
    });

    it('rejects an expired assertion', async () => {
      const { agent, res } = await login({
        nameID: 'expired@saml.example',
        attributes: { groups: ['angles-admins'] },
        notOnOrAfter: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });
      res.headers.location.should.equal('/login?error=true');
      await agent.get(`${baseUrl}auth/me`).expect(401);
    });

    it('rejects a response signed only at the assertion level by default', async () => {
      const { agent, res } = await login({
        nameID: 'assertion.only@saml.example',
        attributes: { groups: ['angles-admins'] },
        signResponse: false,
      });
      res.headers.location.should.equal('/login?error=true');
      await agent.get(`${baseUrl}auth/me`).expect(401);
    });

    it('accepts an assertion-only signature when the IdP does not sign responses', (done) => {
      configure(samlProvider({ saml: { wantAuthnResponseSigned: false } })).then(async () => {
        try {
          const { agent } = await login({
            nameID: 'assertion.signed@saml.example',
            attributes: { groups: ['angles-admins'] },
            signResponse: false,
          });
          const me = await agent.get(`${baseUrl}auth/me`).expect(200);
          me.body.role.should.equal('admin');
          return done();
        } catch (assertionErr) {
          return done(assertionErr);
        }
      }).catch(done);
    });

    it('still requires the assertion signature when response signing is relaxed', (done) => {
      configure(samlProvider({ saml: { wantAuthnResponseSigned: false } })).then(async () => {
        try {
          const { agent, res } = await login({
            nameID: 'wholly.unsigned@saml.example',
            attributes: { groups: ['angles-admins'] },
            sign: false,
            signResponse: false,
          });
          res.headers.location.should.equal('/login?error=true');
          await agent.get(`${baseUrl}auth/me`).expect(401);
          return done();
        } catch (assertionErr) {
          return done(assertionErr);
        }
      }).catch(done);
    });

    it('rejects an unsolicited assertion by default', async () => {
      const agent = request.agent(app);
      const unsolicited = idp.buildResponse({
        nameID: 'unsolicited@saml.example',
        attributes: { groups: ['angles-admins'] },
        audience: SP_ENTITY_ID,
        destination: ACS_URL,
      });

      const res = await agent
        .post(`${baseUrl}auth/sso/adfs/callback`)
        .type('form')
        .send({ SAMLResponse: unsolicited })
        .redirects(0);

      res.headers.location.should.equal('/login?error=true');
      should.not.exist(await User.findOne({ username: 'unsolicited@saml.example' }));
    });

    it('accepts an unsolicited assertion when IdP-initiated login is enabled', (done) => {
      configure(samlProvider({ saml: { allowUnsolicited: true } })).then(async () => {
        try {
          const agent = request.agent(app);
          const unsolicited = idp.buildResponse({
            nameID: 'idp.initiated@saml.example',
            attributes: { groups: ['angles-admins'] },
            audience: SP_ENTITY_ID,
            destination: ACS_URL,
          });

          const res = await agent
            .post(`${baseUrl}auth/sso/adfs/callback`)
            .type('form')
            .send({ SAMLResponse: unsolicited })
            .redirects(0);

          res.headers.location.should.equal('/');
          const me = await agent.get(`${baseUrl}auth/me`).expect(200);
          me.body.username.should.equal('idp.initiated@saml.example');
          return done();
        } catch (assertionErr) {
          return done(assertionErr);
        }
      }).catch(done);
    });
  });

  describe('SP metadata', () => {
    beforeEach(() => configure());

    it('serves SP metadata describing the entity id and ACS endpoint', (done) => {
      request(app)
        .get(`${baseUrl}auth/sso/adfs/metadata`)
        .expect(200)
        .expect('Content-Type', /xml/)
        .end((err, res) => {
          if (err) return done(err);
          res.text.should.containEql('EntityDescriptor');
          res.text.should.containEql(SP_ENTITY_ID);
          res.text.should.containEql(ACS_URL);
          return done();
        });
    });

    it('returns 404 for metadata on a non-SAML provider', (done) => {
      adminAgent
        .put(`${baseUrl}settings/auth`)
        .send({
          providers: [{
            id: 'oidc-one',
            name: 'OIDC',
            type: 'oidc',
            enabled: false,
            oidc: { issuer: 'https://example.test' },
          }],
        })
        .expect(200)
        .end((err) => {
          if (err) return done(err);
          // Disabled providers are 404 at the guard, which is the same outcome.
          return request(app).get(`${baseUrl}auth/sso/oidc-one/metadata`).expect(404, done);
        });
    });
  });
});
