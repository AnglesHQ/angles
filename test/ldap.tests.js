const request = require('supertest');
const should = require('should');
const app = require('../server.js');
const User = require('../app/models/user.js');
const AuthSettings = require('../app/models/auth-settings.js');
const authSettingsService = require('../app/utils/auth-settings-service.js');
const { configureProviders } = require('../app/utils/passport-setup.js');
const TestLdapServer = require('./test-ldap-server.js');
const { groupNameFromDn, extractGroups } = require('../app/utils/strategies/ldap-strategy.js');
const testUtils = require('./test-utils.js');

const baseUrl = '/rest/api/v1.0/';

describe('LDAP authentication', () => {
  let adminAgent;
  let directory;

  before(async () => {
    directory = await new TestLdapServer().start();

    directory.addUser('alice', 'alice-password', { cn: 'Alice Example', mail: 'alice@example.com' });
    directory.addUser('bob', 'bob-password', { cn: 'Bob Example', mail: 'bob@example.com' });
    directory.addUser('carol', 'carol-password', { cn: 'Carol Example' });

    const adminsDn = directory.addGroup('angles-admins', ['alice']);
    const usersDn = directory.addGroup('angles-users', ['bob']);
    directory.addGroup('unrelated', ['carol']);

    // Alice and Bob carry memberOf, as Active Directory populates it.
    directory.setMemberOf('alice', [adminsDn]);
    directory.setMemberOf('bob', [usersDn]);

    adminAgent = await testUtils.getAdminAgent();
  });

  after(async () => {
    await directory.stop();
    await User.deleteMany({ username: { $in: ['alice', 'bob', 'carol', 'alice@example.com'] } }).exec();
    await AuthSettings.deleteMany({}).exec();
    await authSettingsService.loadAuthSettings();
    await configureProviders();
  });

  const ldapProvider = (overrides = {}) => ({
    id: 'corp-ad',
    name: 'Corporate Directory',
    type: 'ldap',
    enabled: true,
    ldap: {
      url: directory.url,
      bindDN: 'cn=service,dc=example,dc=com',
      bindCredentials: 'service-password',
      searchBase: directory.searchBase,
      searchFilter: '(uid={{username}})',
      usernameAttribute: 'uid',
      // The test directory serves real LDAPS with a self-signed certificate, so the
      // transport matches a correct deployment; validation is relaxed only because the
      // certificate is generated per run and trusted by nothing.
      tlsRejectUnauthorized: false,
      ...(overrides.ldap || {}),
    },
    roleMappings: [
      { value: 'angles-admins', role: 'admin' },
      { value: 'angles-users', role: 'user' },
    ],
    ...(() => { const rest = { ...overrides }; delete rest.ldap; return rest; })(),
  });

  const configure = (provider) => adminAgent
    .put(`${baseUrl}settings/auth`)
    .send({ providers: [] })
    .expect(200)
    .then(() => adminAgent
      .put(`${baseUrl}settings/auth`)
      .send({ providers: [provider || ldapProvider()] })
      .expect(200));

  const login = (username, password) => request(app)
    .post(`${baseUrl}auth/sso/corp-ad/login`)
    .send({ username, password });

  describe('configuration', () => {
    it('registers the provider when fully configured', () => configure()
      .then((res) => {
        res.body.providerStatus['corp-ad'].ready.should.equal(true);
      }));

    it('refuses a plaintext ldap:// URL without StartTLS, which would expose passwords', () => configure(ldapProvider({
      ldap: { url: 'ldap://directory.example.com:389', startTLS: false },
    })).then((res) => {
      res.body.providerStatus['corp-ad'].ready.should.equal(false);
      res.body.providerStatus['corp-ad'].error.should.match(/ldaps|startTLS/i);
    }));

    it('accepts a plaintext URL when StartTLS is enabled', () => configure(ldapProvider({
      ldap: { url: 'ldap://directory.example.com:389', startTLS: true },
    })).then((res) => {
      res.body.providerStatus['corp-ad'].ready.should.equal(true);
    }));

    it('requires a search base', () => configure(ldapProvider({ ldap: { searchBase: '' } }))
      .then((res) => {
        res.body.providerStatus['corp-ad'].ready.should.equal(false);
        res.body.providerStatus['corp-ad'].error.should.match(/searchBase/);
      }));

    it('never returns the bind credentials', () => configure()
      .then(() => adminAgent.get(`${baseUrl}settings/auth`).expect(200))
      .then((res) => {
        const [provider] = res.body.providers;
        provider.bindCredentialsSet.should.equal(true);
        should.not.exist(provider.ldap.bindCredentials);
      }));

    it('advertises a credential login URL rather than a redirect', () => configure()
      .then(() => request(app).get(`${baseUrl}auth/config`).expect(200))
      .then((res) => {
        const [provider] = res.body.providers;
        provider.type.should.equal('ldap');
        provider.loginUrl.should.equal('/rest/api/v1.0/auth/sso/corp-ad/login');
      }));
  });

  describe('login', () => {
    beforeEach(() => configure());

    it('authenticates a valid user and maps their role from memberOf', () => login('alice', 'alice-password')
      .expect(200)
      .then((res) => {
        res.body.user.username.should.equal('alice');
        res.body.user.role.should.equal('admin');
      }));

    it('maps a different group to a different role', () => login('bob', 'bob-password')
      .expect(200)
      .then((res) => {
        res.body.user.role.should.equal('user');
      }));

    it('records the provider id as the auth provider', async () => {
      await login('alice', 'alice-password').expect(200);
      const user = await User.findOne({ username: 'alice' });
      user.authProvider.should.equal('corp-ad');
    });

    it('establishes a session usable on subsequent requests', async () => {
      const agent = request.agent(app);
      await agent
        .post(`${baseUrl}auth/sso/corp-ad/login`)
        .send({ username: 'alice', password: 'alice-password' })
        .expect(200);
      const me = await agent.get(`${baseUrl}auth/me`).expect(200);
      me.body.username.should.equal('alice');
      me.body.role.should.equal('admin');
    });

    it('rejects a wrong password', () => login('alice', 'wrong-password').expect(401));

    it('rejects an unknown user', () => login('nobody', 'any-password').expect(401));

    it('denies a user in none of the mapped groups', async () => {
      await login('carol', 'carol-password').expect(401);
      should.not.exist(await User.findOne({ username: 'carol' }));
    });

    it('requires both a username and a password', async () => {
      await request(app).post(`${baseUrl}auth/sso/corp-ad/login`).send({ username: 'alice' }).expect(422);
      await request(app).post(`${baseUrl}auth/sso/corp-ad/login`).send({ password: 'x' }).expect(422);
    });

    it('syncs the role when directory group membership changes', async () => {
      await login('alice', 'alice-password').expect(200);
      (await User.findOne({ username: 'alice' })).role.should.equal('admin');

      // Alice is moved from the admins group to the users group.
      directory.setMemberOf('alice', [`cn=angles-users,${directory.groupBase}`]);
      await login('alice', 'alice-password').expect(200);
      (await User.findOne({ username: 'alice' })).role.should.equal('user');

      directory.setMemberOf('alice', [`cn=angles-admins,${directory.groupBase}`]);
    });

    it('uses a configured username attribute', () => configure(ldapProvider({ ldap: { usernameAttribute: 'mail' } }))
      .then(() => login('alice', 'alice-password').expect(200))
      .then((res) => {
        res.body.user.username.should.equal('alice@example.com');
      }));

    it('resolves groups through a group search when configured', () => configure(ldapProvider({
      ldap: {
        groupSearchBase: directory.groupBase,
        groupSearchFilter: '(member={{dn}})',
        groupNameAttribute: 'cn',
      },
    })).then(() => login('bob', 'bob-password').expect(200))
      .then((res) => {
        res.body.user.role.should.equal('user');
      }));
  });

  describe('route shape', () => {
    beforeEach(() => configure());

    it('does not offer the redirect flow for an LDAP provider', () => request(app)
      .get(`${baseUrl}auth/sso/corp-ad`)
      .expect(404));

    it('returns 404 for a credential login against a non-LDAP provider', () => adminAgent
      .put(`${baseUrl}settings/auth`)
      .send({
        providers: [{
          id: 'saml-one',
          name: 'SAML',
          type: 'saml',
          enabled: false,
          saml: { entryPoint: 'https://idp.example/sso' },
        }],
      })
      .expect(200)
      .then(() => request(app)
        .post(`${baseUrl}auth/sso/saml-one/login`)
        .send({ username: 'a', password: 'b' })
        .expect(404)));

    it('returns 404 for an unknown provider', () => request(app)
      .post(`${baseUrl}auth/sso/nope/login`)
      .send({ username: 'a', password: 'b' })
      .expect(404));
  });

  describe('group name extraction', () => {
    it('takes the leading RDN value from a distinguished name', () => {
      groupNameFromDn('CN=Angles Admins,OU=Groups,DC=example,DC=com').should.equal('Angles Admins');
      groupNameFromDn('cn=angles-users,ou=groups,dc=example,dc=com').should.equal('angles-users');
    });

    it('passes a bare group name through unchanged', () => {
      groupNameFromDn('angles-admins').should.equal('angles-admins');
    });

    it('unescapes DN escaping in the group name', () => {
      groupNameFromDn('CN=Admins\\, Global,OU=Groups,DC=example,DC=com').should.equal('Admins, Global');
    });

    it('reads memberOf whether it is a single value or an array', () => {
      extractGroups({ memberOf: 'CN=One,OU=G,DC=x' }, {}).should.eql(['One']);
      extractGroups({ memberOf: ['CN=One,OU=G,DC=x', 'CN=Two,OU=G,DC=x'] }, {}).should.eql(['One', 'Two']);
    });

    it('prefers group search results over memberOf when both are present', () => {
      const groups = extractGroups({
        _groups: [{ cn: 'Searched' }],
        memberOf: ['CN=FromMemberOf,OU=G,DC=x'],
      }, {});
      groups.should.eql(['Searched']);
    });

    it('returns an empty list when the entry has no group information', () => {
      extractGroups({ uid: 'someone' }, {}).should.eql([]);
    });
  });
});
