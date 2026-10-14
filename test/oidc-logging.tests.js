/**
 * The diagnostics logged on an OIDC login. They exist to explain group-mapping problems,
 * so they must show the shape of what the IdP sent while never leaking tokens, the
 * userinfo payload or other claim values.
 */
const should = require('should');
const debug = require('debug');
const util = require('util');
const User = require('../app/models/user.js');
const { buildVerify, describeGroupsClaim, sanitiseForLog } = require('../app/utils/strategies/oidc-strategy.js');
const { explainRole } = require('../app/utils/role-mapper.js');

const SECRET_TOKEN = 'eyJSECRET.ID.TOKEN';
const SECRET_EMAIL_LOCAL = 'private.person';

const provider = {
  id: 'okta-1',
  name: 'Okta',
  type: 'oidc',
  defaultRole: '',
  roleMappings: [{ value: 'Angles-Admins', role: 'admin' }],
  oidc: { groupsClaim: 'groups', usernameClaim: 'email' },
};

const tokenSetFor = (claims, scope = 'openid profile groups') => ({
  claims: () => claims,
  scope,
  id_token: SECRET_TOKEN,
  access_token: SECRET_TOKEN,
  refresh_token: SECRET_TOKEN,
});

describe('OIDC login logging', () => {
  let lines;
  let savedLog;
  let savedNamespaces;
  let savedFindOne;
  let savedSave;

  const login = (claims, userInfo, config = provider) => new Promise((resolve) => {
    buildVerify(config)(
      tokenSetFor(claims),
      userInfo,
      (err, user, info) => resolve({ err, user, info }),
    );
  });

  beforeEach(() => {
    lines = [];
    savedLog = debug.log;
    savedNamespaces = debug.disable();
    debug.log = (...args) => lines.push(util.format(...args));
    // No database: the user lookup finds nothing and saving is a no-op.
    savedFindOne = User.findOne;
    savedSave = User.prototype.save;
    User.findOne = async () => null;
    User.prototype.save = async function save() { return this; };
  });

  afterEach(() => {
    User.findOne = savedFindOne;
    User.prototype.save = savedSave;
    debug.log = savedLog;
    debug.enable(savedNamespaces || '');
    if (!savedNamespaces) debug.disable();
  });

  describe('describeGroupsClaim', () => {
    it('reports an id_token array', () => {
      describeGroupsClaim({ groups: ['a', 'b'] }, {}, 'groups')
        .should.eql({ source: 'id_token', type: 'array', count: 2 });
    });

    it('reports a claim found only in userinfo', () => {
      describeGroupsClaim({}, { groups: ['a'] }, 'groups')
        .should.eql({ source: 'userinfo', type: 'array', count: 1 });
    });

    it('reports a scalar group as a string', () => {
      describeGroupsClaim({ groups: 'solo' }, {}, 'groups')
        .should.eql({ source: 'id_token', type: 'string', count: 1 });
    });

    it('reports a missing claim as none', () => {
      describeGroupsClaim({ email: 'a@b.c' }, {}, 'groups')
        .should.eql({ source: 'none', type: 'undefined', count: 0 });
    });

    it('reports none when no claim name is configured', () => {
      describeGroupsClaim({ groups: ['a'] }, {}, undefined).source.should.equal('none');
    });
  });

  describe('sanitiseForLog', () => {
    it('strips control characters so a value cannot forge log lines', () => {
      sanitiseForLog('grp\nFAKE LOG LINE\r\u0000end').should.equal('grpFAKE LOG LINEend');
    });

    it('caps the length', () => {
      sanitiseForLog('x'.repeat(500)).length.should.equal(100);
    });
  });

  describe('explainRole', () => {
    it('reports matched mappings and counts without raw group values', () => {
      const result = explainRole(['angles-admins', 'other', 'another'], provider.roleMappings);
      result.should.eql({
        role: 'admin',
        matchedValues: ['Angles-Admins'],
        usedDefault: false,
        groupCount: 3,
        unmatchedCount: 2,
      });
    });

    it('flags when the default role was used', () => {
      const result = explainRole(['nothing'], provider.roleMappings, 'user');
      result.role.should.equal('user');
      result.usedDefault.should.equal(true);
    });

    it('reports a denial', () => {
      should.equal(explainRole([], provider.roleMappings).role, null);
    });
  });

  describe('verify callback', () => {
    it('logs claim names, groups shape and the resolved role', async () => {
      debug.enable('auth:*,-auth:oidc:groups');
      const { user } = await login(
        { sub: '1', email: `${SECRET_EMAIL_LOCAL}@example.com`, groups: ['Angles-Admins', 'Unrelated'] },
        { sub: '1', name: 'Private Person' },
      );
      user.role.should.equal('admin');

      const output = lines.join('\n');
      output.should.containEql('idTokenClaims=[email,groups,sub]');
      output.should.containEql('userinfoClaims=[name,sub]');
      output.should.containEql('scopes=[openid profile groups]');
      output.should.containEql('groupsClaim=groups groupsSource=id_token groupsType=array groupsCount=2');
      output.should.containEql('role=admin matchedMappings=[Angles-Admins] defaultRoleUsed=false groups=2 unmatchedGroups=1');
    });

    it('makes a missing groups claim visible', async () => {
      debug.enable('auth:*,-auth:oidc:groups');
      const { user } = await login({ sub: '1', email: 'a@example.com' }, {});
      user.should.equal(false);
      const output = lines.join('\n');
      output.should.containEql('groupsSource=none groupsType=undefined groupsCount=0');
      output.should.containEql('role=none');
    });

    it('never logs tokens, claim values or the userinfo payload', async () => {
      debug.enable('auth:*,-auth:oidc:groups');
      await login(
        {
          sub: '1',
          email: `${SECRET_EMAIL_LOCAL}@example.com`,
          phone_number: '+441234567890',
          groups: ['Angles-Admins'],
        },
        { name: 'Private Person', address: { street: '1 Secret Road' } },
      );
      const output = lines.join('\n');
      output.should.not.containEql(SECRET_TOKEN);
      output.should.not.containEql('+441234567890');
      output.should.not.containEql('Private Person');
      output.should.not.containEql('Secret Road');
    });

    it('keeps raw group names out unless auth:oidc:groups is enabled', async () => {
      debug.enable('auth:*,-auth:oidc:groups');
      await login(
        { sub: '1', email: 'a@example.com', groups: ['Angles-Admins', 'Finance-Secret'] },
        {},
      );
      lines.join('\n').should.not.containEql('Finance-Secret');
    });

    it('logs sanitised group names when auth:oidc:groups is enabled', async () => {
      debug.enable('auth:oidc:groups');
      await login(
        { sub: '1', email: 'a@example.com', groups: ['Angles-Admins', 'bad\nINJECTED'] },
        {},
      );
      const output = lines.join('\n');
      output.should.containEql('Angles-Admins, badINJECTED');
      output.split('\n').filter((line) => line.startsWith('INJECTED')).should.have.length(0);
    });
  });
});
