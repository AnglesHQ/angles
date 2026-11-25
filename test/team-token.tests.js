/**
 * Team tokens: API tokens that belong to a team rather than a person, for its pipelines.
 *
 * Management: only the team's leads and admins, from a session, can list, create and
 * revoke them; the token itself is returned once.
 * Use: a team token acts as a member of its one team. It can report results (everything
 * the clients' reporters do) and read its team's data, and nothing else.
 */
const fs = require('fs');
const request = require('supertest');
const should = require('should');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const Build = require('../app/models/build.js');
const Screenshot = require('../app/models/screenshot.js');
const TestExecution = require('../app/models/execution.js');
const Environment = require('../app/models/environment.js');
const TeamToken = require('../app/models/team-token.js');
const { Team } = require('../app/models/team.js');
const authMiddleware = require('../app/utils/auth-middleware.js');
const attachmentUtils = require('../app/utils/attachment-utils.js');
const buildUtils = require('../app/utils/build-utils.js');
const testUtils = require('./test-utils.js');

const baseUrl = '/rest/api/v1.0/';
const IMAGE = './test/resources/angles_home_page.jpg';
const PASSWORD = 'unit-testing-TtPass1!';

describe('Team token Tests', () => {
  let adminAgent;
  let leadAgent;
  let otherLeadAgent;
  let memberAgent;
  let team;
  let otherTeam;
  let otherBuild;
  let environment;

  const login = (username) => new Promise((resolve, reject) => {
    const agent = request.agent(app);
    agent.post(`${baseUrl}auth/login`).send({ username, password: PASSWORD }).end((err, res) => {
      if (err) return reject(err);
      if (res.status !== 200) return reject(new Error(`login failed for ${username}: ${res.status}`));
      return resolve(agent);
    });
  });

  // A request authenticated with an x-api-key and no session.
  const withKey = (key, method, url) => request(app)[method](`${baseUrl}${url}`)
    .set('x-api-key', key)
    .set('Accept', 'application/json');

  const createToken = (agent, teamId, body) => agent
    .post(`${baseUrl}team/${teamId}/tokens`)
    .send({ name: 'nightly-pipeline', expiresInDays: 30, ...body });

  const removeFixtures = async () => {
    const teams = await Team.find({ name: /^unit-testing-tt-/ }).select('_id').lean();
    const teamIds = teams.map((t) => t._id);
    const builds = await Build.find({ team: { $in: teamIds } }).select('_id').lean();
    const buildIds = builds.map((b) => b._id);
    const screenshots = await Screenshot.find({ build: { $in: buildIds } }).lean();
    screenshots.forEach((s) => { try { fs.unlinkSync(s.path); } catch (e) { /* gone */ } });
    await attachmentUtils.removeAttachmentsForBuilds(buildIds);
    await Promise.all([
      Screenshot.deleteMany({ build: { $in: buildIds } }).exec(),
      TestExecution.deleteMany({ build: { $in: buildIds } }).exec(),
      Build.deleteMany({ _id: { $in: buildIds } }).exec(),
      TeamToken.deleteMany({ team: { $in: teamIds } }).exec(),
      Environment.deleteMany({ name: /^unit-testing-tt-/ }).exec(),
      User.deleteMany({ username: /^unit-testing-tt-/ }).exec(),
      Team.deleteMany({ _id: { $in: teamIds } }).exec(),
    ]);
  };

  before(async () => {
    await removeFixtures();
    team = await new Team({ name: 'unit-testing-tt-team', components: [{ name: 'tt-web' }] }).save();
    otherTeam = await new Team({ name: 'unit-testing-tt-other', components: [{ name: 'tt-other' }] }).save();
    environment = await new Environment({ name: 'unit-testing-tt-env' }).save();
    otherBuild = await new Build({
      name: 'unit-testing-tt-other-build',
      team: otherTeam,
      environment,
      status: buildUtils.executionStates[0],
      component: otherTeam.components[0]._id,
      suites: [],
      result: new Map(buildUtils.defaultResultMap),
    }).save();
    const hash = await bcrypt.hash(PASSWORD, 10);
    await User.create([
      {
        username: 'unit-testing-tt-lead', password: hash, role: 'team_lead', teams: [team._id],
      },
      {
        username: 'unit-testing-tt-other-lead', password: hash, role: 'team_lead', teams: [otherTeam._id],
      },
      {
        username: 'unit-testing-tt-member', password: hash, role: 'user', teams: [team._id],
      },
    ]);
    adminAgent = await testUtils.getAdminAgent();
    leadAgent = await login('unit-testing-tt-lead');
    otherLeadAgent = await login('unit-testing-tt-other-lead');
    memberAgent = await login('unit-testing-tt-member');
  });

  after(removeFixtures);

  afterEach(() => TeamToken.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec());

  describe('Managing team tokens', () => {
    it('lets a team lead create a token, returned once with the team-token prefix', async () => {
      const res = await createToken(leadAgent, team._id).expect(201);
      should(res.body.token).startWith(authMiddleware.TEAM_TOKEN_PREFIX);
      res.body.name.should.equal('nightly-pipeline');
      res.body.createdBy.username.should.equal('unit-testing-tt-lead');
      const days = (new Date(res.body.expiresAt) - Date.now()) / 86400000;
      days.should.be.within(29.9, 30.1);
      // Only the hash is stored.
      const stored = await TeamToken.findById(res.body._id).lean();
      stored.tokenHash.should.not.equal(res.body.token);
      stored.team.toString().should.equal(team._id.toString());
    });

    it('lists tokens without the token or its hash', async () => {
      await createToken(leadAgent, team._id).expect(201);
      const res = await leadAgent.get(`${baseUrl}team/${team._id}/tokens`).expect(200);
      res.body.should.have.length(1);
      res.body[0].name.should.equal('nightly-pipeline');
      res.body[0].should.not.have.properties('token', 'tokenHash');
    });

    it('lets a team lead revoke a token, which then stops working', async () => {
      const { body } = await createToken(leadAgent, team._id).expect(201);
      await withKey(body.token, 'get', `build/${otherBuild._id}`).expect(403);
      await leadAgent.delete(`${baseUrl}team/${team._id}/tokens/${body._id}`).expect(200);
      await withKey(body.token, 'get', 'team').expect(401);
    });

    it('lets an admin manage any team\'s tokens', async () => {
      const { body } = await createToken(adminAgent, otherTeam._id).expect(201);
      body.createdBy.username.should.equal(testUtils.ADMIN_USERNAME);
      await adminAgent.get(`${baseUrl}team/${otherTeam._id}/tokens`).expect(200);
      await adminAgent.delete(`${baseUrl}team/${otherTeam._id}/tokens/${body._id}`).expect(200);
    });

    it('refuses members who are not leads, and leads of other teams', async () => {
      await createToken(memberAgent, team._id).expect(403);
      await memberAgent.get(`${baseUrl}team/${team._id}/tokens`).expect(403);
      await createToken(otherLeadAgent, team._id).expect(403);
      await otherLeadAgent.get(`${baseUrl}team/${team._id}/tokens`).expect(403);
      const { body } = await createToken(leadAgent, team._id).expect(201);
      await otherLeadAgent.delete(`${baseUrl}team/${team._id}/tokens/${body._id}`).expect(403);
      // A token id from another team is not found under this one.
      await otherLeadAgent.delete(`${baseUrl}team/${otherTeam._id}/tokens/${body._id}`).expect(404);
      should.exist(await TeamToken.findById(body._id));
    });

    it('refuses a second token with the same name in a team, but not in another team', async () => {
      await createToken(leadAgent, team._id).expect(201);
      const res = await createToken(leadAgent, team._id).expect(409);
      res.body.message.should.match(/already has a token named "nightly-pipeline"/);
      await createToken(otherLeadAgent, otherTeam._id).expect(201);
    });

    it('validates the name and the expiry', async () => {
      await createToken(leadAgent, team._id, { name: '' }).expect(422);
      await createToken(leadAgent, team._id, { name: 'x'.repeat(101) }).expect(422);
      await createToken(leadAgent, team._id, { expiresInDays: 0 }).expect(422);
      await createToken(leadAgent, team._id, { expiresInDays: 366 }).expect(422);
      await leadAgent.post(`${baseUrl}team/not-an-id/tokens`).send({ name: 'a', expiresInDays: 1 }).expect(422);
    });

    it('cannot be done with an API token, personal or team', async () => {
      const { body } = await createToken(leadAgent, team._id).expect(201);
      await withKey(body.token, 'get', `team/${team._id}/tokens`).expect(403);
      await withKey(body.token, 'post', `team/${team._id}/tokens`)
        .send({ name: 'minted', expiresInDays: 1 }).expect(403);
      await withKey(body.token, 'delete', `team/${team._id}/tokens/${body._id}`).expect(403);

      const lead = await User.findOne({ username: 'unit-testing-tt-lead' });
      const personal = await leadAgent.post(`${baseUrl}users/${lead._id}/tokens`)
        .send({ name: 'personal', expiresInDays: 1 }).expect(201);
      await withKey(personal.body.token, 'post', `team/${team._id}/tokens`)
        .send({ name: 'minted', expiresInDays: 1 }).expect(403);
      await User.updateOne({ _id: lead._id }, { $set: { apiTokens: [] } });
    });

    it('deletes a team\'s tokens with the team', async () => {
      const doomed = await new Team({ name: 'unit-testing-tt-doomed', components: [{ name: 'tt-doomed' }] }).save();
      const { body } = await createToken(adminAgent, doomed._id).expect(201);
      await adminAgent.delete(`${baseUrl}team/${doomed._id}`).expect(200);
      should.not.exist(await TeamToken.findById(body._id));
      await withKey(body.token, 'get', 'team').expect(401);
    });
  });

  describe('Using a team token', () => {
    let token;

    beforeEach(async () => {
      ({ body: { token } } = await createToken(leadAgent, team._id).expect(201));
    });

    const startBuild = (teamName = team.name, component = 'tt-web') => withKey(token, 'post', 'build').send({
      name: 'unit-testing-tt-pipeline-build',
      environment: environment.name,
      team: teamName,
      component,
      start: new Date().toISOString(),
    });

    it('reports a whole run the way the clients do', async () => {
      const build = (await startBuild().expect(201)).body;
      // The build records the token as what triggered it, with no user.
      build.triggeredBy.should.eql({
        username: 'nightly-pipeline', tokenName: 'nightly-pipeline', teamToken: true,
      });

      // Attachments are uploaded against the build while the test runs.
      const attachment = await withKey(token, 'post', `build/${build._id}/attachment`)
        .attach('attachment', Buffer.from('a log line\n'), 'console.log')
        .expect(201);
      await withKey(token, 'post', 'execution/')
        .send({
          title: 'checkout works', suite: 'checkout', build: build._id, attachments: [attachment.body._id],
        })
        .expect(201);
      await withKey(token, 'put', `build/${build._id}/executions`)
        .send({ executions: [{ title: 'refund works', suite: 'refunds' }] })
        .expect(200);
      await withKey(token, 'put', `build/${build._id}/artifacts`)
        .send({ artifacts: [{ groupId: 'com.example', artifactId: 'shop', version: '1.2.3' }] })
        .expect(200);
      await withKey(token, 'put', `build/${build._id}/keep`).send({ keep: true }).expect(200);
      const screenshot = await withKey(token, 'post', 'screenshot/')
        .field('buildId', build._id.toString())
        .field('timestamp', new Date().toISOString())
        .field('view', 'unit-testing-tt-view')
        .field('platformName', 'linux')
        .field('browserName', 'chrome')
        .attach('screenshot', IMAGE)
        .expect(201);
      // No baseline yet: answered rather than refused.
      const compare = await withKey(token, 'get', `screenshot/${screenshot.body._id}/baseline/compare`);
      compare.status.should.not.equal(403);
      compare.status.should.not.equal(401);

      // And it can read the results back, and download the report for the pipeline.
      const stored = (await withKey(token, 'get', `build/${build._id}`).expect(200)).body;
      stored.keep.should.equal(true);
      await withKey(token, 'get', `build/${build._id}/report`).expect(200);
    });

    it('cannot report into another team', async () => {
      await startBuild(otherTeam.name, 'tt-other').expect(403);
      await withKey(token, 'post', 'execution')
        .send({ title: 't', suite: 's', build: otherBuild._id }).expect(403);
      await withKey(token, 'put', `build/${otherBuild._id}/keep`).send({ keep: true }).expect(403);
    });

    it('reads only its own team', async () => {
      const teams = (await withKey(token, 'get', 'team').expect(200)).body;
      teams.map((t) => t.name).should.eql([team.name]);
      await withKey(token, 'get', `build/${otherBuild._id}`).expect(403);
    });

    it('refuses every other kind of change, even ones a member could make', async () => {
      const build = (await startBuild().expect(201)).body;
      const refused = [
        ['delete', `build/${build._id}`],
        ['put', `build/${build._id}`],
        ['put', `team/${team._id}`],
        ['put', `team/${team._id}/components`],
        ['post', `team/${team._id}/members`],
        ['post', 'environment'],
        ['post', 'manual-test-case'],
        ['post', 'baseline'],
        ['put', 'settings/auth'],
        ['post', `build/${build._id}/attachment/extra`],
      ];
      // eslint-disable-next-line no-restricted-syntax
      for (const [method, url] of refused) {
        // eslint-disable-next-line no-await-in-loop
        const res = await withKey(token, method, url).send({});
        res.status.should.equal(403, `${method.toUpperCase()} ${url} answered ${res.status}`);
      }
      should.exist(await Build.findById(build._id));
    });

    it('cannot reach the user routes', async () => {
      const lead = await User.findOne({ username: 'unit-testing-tt-lead' });
      await withKey(token, 'get', `users/${lead._id}/tokens`).expect(403);
    });

    it('stops working once expired', async () => {
      const past = new Date(Date.now() - 1000);
      await TeamToken.updateOne({ team: team._id }, { $set: { expiresAt: past } });
      await withKey(token, 'get', 'team').expect(401);
    });

    it('is refused when unknown, even with the team-token prefix', async () => {
      await withKey(`${authMiddleware.TEAM_TOKEN_PREFIX}${'0'.repeat(64)}`, 'get', 'team').expect(401);
    });

    it('records when it was last used, at most once an hour', async () => {
      await withKey(token, 'get', 'team').expect(200);
      // Recorded without holding up the request.
      let stored;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        stored = await TeamToken.findOne({ team: team._id }).lean();
        if (stored.lastUsedAt) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 25); });
      }
      should.exist(stored.lastUsedAt);
      const first = stored.lastUsedAt.getTime();
      await withKey(token, 'get', 'team').expect(200);
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      const again = await TeamToken.findOne({ team: team._id }).lean();
      again.lastUsedAt.getTime().should.equal(first);
      const list = await leadAgent.get(`${baseUrl}team/${team._id}/tokens`).expect(200);
      should.exist(list.body[0].lastUsedAt);
    });
  });

  describe('isTeamTokenRequestAllowed', () => {
    const allowed = (method, fullPath) => authMiddleware.isTeamTokenRequestAllowed({
      method, baseUrl: '/rest/api/v1.0', path: fullPath,
    });

    it('allows reads and the reporting writes, with or without a trailing slash', () => {
      allowed('GET', '/anything/at/all').should.equal(true);
      allowed('POST', '/build').should.equal(true);
      allowed('POST', '/build/').should.equal(true);
      allowed('PUT', '/build/abc/executions').should.equal(true);
      allowed('PUT', '/build/abc/artifacts/').should.equal(true);
      allowed('PUT', '/build/abc/keep').should.equal(true);
      allowed('POST', '/build/abc/attachment').should.equal(true);
      allowed('POST', '/execution/').should.equal(true);
      allowed('POST', '/screenshot').should.equal(true);
    });

    it('refuses everything else', () => {
      allowed('DELETE', '/build/abc').should.equal(false);
      allowed('PUT', '/build/abc').should.equal(false);
      allowed('PUT', '/build//executions').should.equal(false);
      allowed('POST', '/build/abc/executions').should.equal(false);
      allowed('PUT', '/execution/abc').should.equal(false);
      allowed('POST', '/screenshot/abc/find').should.equal(false);
      allowed('PATCH', '/build').should.equal(false);
      // Outside the API prefix.
      authMiddleware.isTeamTokenRequestAllowed({ method: 'POST', baseUrl: '', path: '/build' })
        .should.equal(false);
    });
  });
});
