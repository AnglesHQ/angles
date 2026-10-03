/**
 * Login throttling and security headers.
 *
 * Throttling: repeated failed sign-ins from one client are refused with 429 per IP and
 * username, and per IP across usernames, without ever locking an account for everyone.
 * Headers: every API response forbids framing and loading anything; the HTML report runs
 * only its own nonced script.
 */
const request = require('supertest');
const should = require('should');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const Build = require('../app/models/build.js');
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');
const buildUtils = require('../app/utils/build-utils.js');
const loginThrottle = require('../app/utils/login-throttle.js');

const baseUrl = '/rest/api/v1.0/';
const PASSWORD = 'unit-testing-ShPass1!';
const USERS = ['unit-testing-sh-alice', 'unit-testing-sh-bob', 'unit-testing-sh-carol', 'unit-testing-sh-dave'];

const login = (username, password) => new Promise((resolve, reject) => {
  request(app).post(`${baseUrl}auth/login`).send({ username, password })
    .end((err, res) => (err ? reject(err) : resolve(res)));
});

describe('Security hardening Tests', () => {
  let team;
  let environment;
  let build;

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-sh-/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-sh-/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-sh-/ }).exec(),
    ]);
    const hash = await bcrypt.hash(PASSWORD, 10);
    team = await new Team({ name: 'unit-testing-sh-team', components: [{ name: 'sh-component' }] }).save();
    environment = await new Environment({ name: 'unit-testing-sh-env' }).save();
    await User.create(USERS.map((username) => ({
      username, password: hash, role: 'user', teams: [team._id],
    })));
    build = await new Build({
      name: 'unit-testing-sh-build',
      team,
      environment,
      status: buildUtils.executionStates[0],
      component: team.components[0]._id,
      suites: [],
      result: new Map(buildUtils.defaultResultMap),
    }).save();
  });

  after(async () => {
    loginThrottle.reset();
    await Promise.all([
      Build.deleteMany({ _id: build._id }).exec(),
      User.deleteMany({ username: /^unit-testing-sh-/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-sh-/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-sh-/ }).exec(),
    ]);
  });

  describe('Login throttling', () => {
    beforeEach(() => loginThrottle.reset());

    it('refuses a client after 5 failed sign-ins for one account, even with the right password', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await login(USERS[0], 'wrong-password');
        should(res.status).equal(401);
      }
      const blocked = await login(USERS[0], PASSWORD);
      should(blocked.status).equal(429);
      should(Number(blocked.headers['retry-after'])).be.above(0);
      should(blocked.body.error).match(/Too many failed sign-in attempts/);
    });

    it('does not lock the account for other clients, nor other accounts for this client', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await login(USERS[0], 'wrong-password');
      }
      // Same client, another account: still allowed.
      should((await login(USERS[1], PASSWORD)).status).equal(200);
      // Another client, the same account: still allowed.
      should(loginThrottle.check('203.0.113.7', USERS[0]).allowed).equal(true);
    });

    it('counts the username case-insensitively', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await login(USERS[0].toUpperCase(), 'wrong-password');
      }
      should((await login(USERS[0], PASSWORD)).status).equal(429);
    });

    it('clears the count after a successful sign-in', async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        await login(USERS[2], 'wrong-password');
      }
      should((await login(USERS[2], PASSWORD)).status).equal(200);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        should((await login(USERS[2], 'wrong-password')).status).equal(401);
      }
      should((await login(USERS[2], PASSWORD)).status).equal(200);
    });

    it('refuses a client that fails across many accounts', async () => {
      loginThrottle.configure({ maxFailuresPerIp: 3 });
      await login(USERS[0], 'wrong-password');
      await login(USERS[1], 'wrong-password');
      await login(USERS[2], 'wrong-password');
      should((await login(USERS[3], PASSWORD)).status).equal(429);
    });

    it('forgets failures once the window has passed', () => {
      loginThrottle.configure({ maxFailuresPerAccount: 2, windowMs: 1000 });
      const start = 1000000;
      loginThrottle.recordFailure('198.51.100.1', 'someone', start);
      loginThrottle.recordFailure('198.51.100.1', 'someone', start + 10);
      should(loginThrottle.check('198.51.100.1', 'someone', start + 20).allowed).equal(false);
      should(loginThrottle.check('198.51.100.1', 'someone', start + 1011).allowed).equal(true);
    });

    it('also guards the LDAP credential login', async () => {
      loginThrottle.configure({ maxFailuresPerAccount: 1 });
      loginThrottle.recordFailure('::ffff:127.0.0.1', 'directory-user');
      loginThrottle.recordFailure('127.0.0.1', 'directory-user');
      const res = await new Promise((resolve, reject) => {
        request(app).post(`${baseUrl}auth/sso/any-provider/login`)
          .send({ username: 'directory-user', password: 'x' })
          .end((err, response) => (err ? reject(err) : resolve(response)));
      });
      should(res.status).equal(429);
    });
  });

  describe('Security headers', () => {
    let agent;

    before(async () => {
      loginThrottle.reset();
      agent = request.agent(app);
      const res = await agent.post(`${baseUrl}auth/login`).send({ username: USERS[0], password: PASSWORD });
      should(res.status).equal(200);
    });

    it('API responses forbid framing, sniffing and loading anything', async () => {
      const res = await request(app).get(`${baseUrl}auth/config`);
      should(res.headers['content-security-policy']).equal("default-src 'none'; frame-ancestors 'none'");
      should(res.headers['x-frame-options']).equal('DENY');
      should(res.headers['x-content-type-options']).equal('nosniff');
      should(res.headers['referrer-policy']).equal('no-referrer');
      should(res.headers).not.have.property('x-powered-by');
    });

    it('error responses carry the same headers', async () => {
      const res = await request(app).get(`${baseUrl}build`);
      should(res.status).equal(401);
      should(res.headers['content-security-policy']).equal("default-src 'none'; frame-ancestors 'none'");
    });

    it('the Swagger UI can still load its own scripts, but cannot be framed', async () => {
      const res = await request(app).get('/api-docs/');
      should(res.headers['content-security-policy']).equal("frame-ancestors 'none'");
    });

    it('the HTML report only runs its own script, by nonce', async () => {
      const res = await agent.get(`${baseUrl}build/${build._id}/report`);
      should(res.status).equal(200);
      const csp = res.headers['content-security-policy'];
      const nonce = /'nonce-([^']+)'/.exec(csp)[1];
      should(csp).match(/default-src 'none'/);
      should(csp).match(/img-src data:/);
      should(res.text).containEql(`<script nonce="${nonce}">`);
      const other = await agent.get(`${baseUrl}build/${build._id}/report`);
      should(other.headers['content-security-policy']).not.equal(csp);
    });
  });
});
