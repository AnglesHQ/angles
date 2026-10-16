/**
 * Team membership managed by team leads, the last-login timestamp, who triggered a build,
 * and the build report's theme toggle.
 */
const request = require('supertest');
const should = require('should');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const Build = require('../app/models/build.js');
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');
const testUtils = require('./test-utils.js');

const baseUrl = '/rest/api/v1.0/';
const PASSWORD = 'unit-testing-Members1!';
const PREFIX = 'unit-testing-tm';

describe('Team members, last login and build trigger Tests', () => {
  let adminAgent;
  let leadAgent;
  let memberAgent;
  let team;
  let otherTeam;
  let environment;
  let lead;
  let otherLead;
  let member;
  let candidate;
  let teamLead2;
  let outsider;
  let leadToken;

  const login = (username) => new Promise((resolve, reject) => {
    const agent = request.agent(app);
    agent.post(`${baseUrl}auth/login`).send({ username, password: PASSWORD }).end((err, res) => {
      if (err) return reject(err);
      if (res.status !== 200) return reject(new Error(`login failed for ${username}: ${res.status}`));
      return resolve(agent);
    });
  });

  const createUser = async (suffix, role, teams) => {
    const user = new User({
      username: `${PREFIX}-${suffix}`,
      password: await bcrypt.hash(PASSWORD, 10),
      role,
      teams: teams || [],
    });
    return user.save();
  };

  const members = async (agent, teamId) => {
    const res = await agent.get(`${baseUrl}team/${teamId}/members`).expect(200);
    return res.body;
  };

  before(async () => {
    await User.deleteMany({ username: new RegExp(`^${PREFIX}`) });
    await Team.deleteMany({ name: new RegExp(`^${PREFIX}`) });
    await Environment.deleteMany({ name: new RegExp(`^${PREFIX}`) });
    await Build.deleteMany({ name: new RegExp(`^${PREFIX}`) });

    team = await new Team({ name: `${PREFIX}-team`, components: [{ name: 'component1' }] }).save();
    otherTeam = await new Team({ name: `${PREFIX}-other-team`, components: [{ name: 'component1' }] }).save();
    environment = await new Environment({ name: `${PREFIX}-environment` }).save();

    lead = await createUser('lead', 'team_lead', [team._id]);
    otherLead = await createUser('other-lead', 'team_lead', [otherTeam._id]);
    member = await createUser('member', 'user', [team._id, otherTeam._id]);
    candidate = await createUser('candidate', 'user');
    teamLead2 = await createUser('lead-two', 'team_lead', [team._id]);
    outsider = await createUser('outsider', 'user');

    adminAgent = await testUtils.getAdminAgent();
    leadAgent = await login(lead.username);
    memberAgent = await login(member.username);

    const tokenRes = await adminAgent
      .post(`${baseUrl}users/${lead._id}/tokens`)
      .send({ name: 'unit-testing-ci', expiresInDays: 1 })
      .expect(201);
    leadToken = tokenRes.body.token;
  });

  after(async () => {
    await User.deleteMany({ username: new RegExp(`^${PREFIX}`) });
    await Team.deleteMany({ name: new RegExp(`^${PREFIX}`) });
    await Environment.deleteMany({ name: new RegExp(`^${PREFIX}`) });
    await Build.deleteMany({ name: new RegExp(`^${PREFIX}`) });
  });

  describe('GET /team/:teamId/members', () => {
    it('lists the members of the team to its team lead, without sensitive fields', async () => {
      const list = await members(leadAgent, team._id);
      const names = list.map((u) => u.username);
      names.should.containDeep([lead.username, member.username, teamLead2.username]);
      names.should.not.containEql(otherLead.username);
      list.forEach((u) => {
        should.not.exist(u.password);
        should.not.exist(u.apiTokens);
        should.not.exist(u.teams);
        should.exist(u.role);
      });
    });

    it('lets an admin list any team', async () => {
      const list = await members(adminAgent, otherTeam._id);
      list.map((u) => u.username).should.containDeep([otherLead.username, member.username]);
    });

    it('respond with 403 for a plain member of the team', async () => {
      await memberAgent.get(`${baseUrl}team/${team._id}/members`).expect(403);
    });

    it('respond with 403 for a team lead of a different team', async () => {
      await leadAgent.get(`${baseUrl}team/${otherTeam._id}/members`).expect(403);
    });

    it('respond with 404 for an unknown team (admin)', async () => {
      await adminAgent.get(`${baseUrl}team/507f1f77bcf86cd799439011/members`).expect(404);
    });

    it('respond with 422 for a malformed team id', async () => {
      await adminAgent.get(`${baseUrl}team/not-an-id/members`).expect(422);
    });

    it('respond with 403 when called with an API token rather than a session', async () => {
      await request(app)
        .get(`${baseUrl}team/${team._id}/members`)
        .set('x-api-key', leadToken)
        .expect(403);
    });
  });

  describe('GET /team/:teamId/members/candidates', () => {
    const search = (agent, teamId, q) => agent
      .get(`${baseUrl}team/${teamId}/members/candidates`)
      .query({ q });

    it('finds users to add by part of their username, case-insensitively', async () => {
      const res = await search(leadAgent, team._id, 'CAND').expect(200);
      res.body.map((u) => u.username).should.eql([candidate.username]);
      Object.keys(res.body[0]).sort().should.eql(['_id', 'role', 'username']);
    });

    it('matches in the middle of a username, not only the start', async () => {
      const res = await search(leadAgent, team._id, 'tm-out').expect(200);
      res.body.map((u) => u.username).should.eql([outsider.username]);
    });

    it('offers a team lead only plain users who are not already in the team', async () => {
      const res = await search(leadAgent, team._id, `${PREFIX}`).expect(200);
      const names = res.body.map((u) => u.username);
      names.should.containDeep([candidate.username, outsider.username]);
      // already a member / a team lead of this team / a team lead elsewhere
      names.should.not.containEql(member.username);
      names.should.not.containEql(lead.username);
      names.should.not.containEql(teamLead2.username);
      names.should.not.containEql(otherLead.username);
      res.body.forEach((u) => u.role.should.equal('user'));
    });

    it('also offers team leads to an admin, who may add them', async () => {
      const res = await search(adminAgent, team._id, `${PREFIX}`).expect(200);
      const names = res.body.map((u) => u.username);
      names.should.containDeep([candidate.username, outsider.username, otherLead.username]);
      names.should.not.containEql(member.username);
    });

    it('returns an empty list when nothing matches', async () => {
      const res = await search(leadAgent, team._id, 'zzzzzz-no-such-user').expect(200);
      res.body.should.eql([]);
    });

    it('caps the number of suggestions', async () => {
      const bulk = await Promise.all(Array.from({ length: 12 }, (_, i) => createUser(`bulk-${String(i).padStart(2, '0')}`, 'user')));
      try {
        const res = await search(leadAgent, team._id, 'tm-bulk').expect(200);
        res.body.should.have.length(10);
      } finally {
        await User.deleteMany({ _id: { $in: bulk.map((u) => u._id) } });
      }
    });

    it('respond with 422 for fewer than three characters, or characters outside a username', async () => {
      await search(leadAgent, team._id, 'ca').expect(422);
      await search(leadAgent, team._id, '').expect(422);
      await search(leadAgent, team._id, 'a.*').expect(422);
      await leadAgent.get(`${baseUrl}team/${team._id}/members/candidates`).expect(422);
    });

    it('respond with 403 for a plain member and for a lead of another team', async () => {
      await search(memberAgent, team._id, 'cand').expect(403);
      await search(leadAgent, otherTeam._id, 'cand').expect(403);
    });

    it('respond with 403 when called with an API token, and 404 for an unknown team', async () => {
      await request(app)
        .get(`${baseUrl}team/${team._id}/members/candidates`)
        .query({ q: 'cand' })
        .set('x-api-key', leadToken)
        .expect(403);
      await search(adminAgent, '507f1f77bcf86cd799439011', 'cand').expect(404);
    });
  });

  describe('POST /team/:teamId/members', () => {
    it('lets a team lead add a user by username (case-insensitively)', async () => {
      const res = await leadAgent
        .post(`${baseUrl}team/${team._id}/members`)
        .send({ username: candidate.username.toUpperCase() })
        .expect(201);
      res.body.username.should.equal(candidate.username);
      should.not.exist(res.body.password);

      const list = await members(leadAgent, team._id);
      list.map((u) => u.username).should.containEql(candidate.username);
      const stored = await User.findById(candidate._id).lean();
      stored.teams.map(String).should.eql([String(team._id)]);
    });

    it('respond with 409 when the user is already a member', async () => {
      await leadAgent
        .post(`${baseUrl}team/${team._id}/members`)
        .send({ username: candidate.username })
        .expect(409);
      const stored = await User.findById(candidate._id).lean();
      stored.teams.should.have.length(1);
    });

    it('respond with 404 when the username does not exist', async () => {
      await leadAgent
        .post(`${baseUrl}team/${team._id}/members`)
        .send({ username: `${PREFIX}-nobody` })
        .expect(404);
    });

    it('respond with 422 when the username is missing or malformed', async () => {
      await leadAgent.post(`${baseUrl}team/${team._id}/members`).send({}).expect(422);
      await leadAgent.post(`${baseUrl}team/${team._id}/members`).send({ username: 'a b!' }).expect(422);
    });

    it('respond with 403 when a team lead adds someone to a team they do not lead', async () => {
      await leadAgent
        .post(`${baseUrl}team/${otherTeam._id}/members`)
        .send({ username: outsider.username })
        .expect(403);
      const stored = await User.findById(outsider._id).lean();
      stored.teams.should.have.length(0);
    });

    it('respond with 403 when a plain user tries to add a member', async () => {
      await memberAgent
        .post(`${baseUrl}team/${team._id}/members`)
        .send({ username: outsider.username })
        .expect(403);
    });

    it('respond with 403 when a team lead tries to add another team lead, but an admin can', async () => {
      await leadAgent
        .post(`${baseUrl}team/${team._id}/members`)
        .send({ username: otherLead.username })
        .expect(403);
      (await User.findById(otherLead._id).lean()).teams.map(String)
        .should.not.containEql(String(team._id));

      await adminAgent
        .post(`${baseUrl}team/${team._id}/members`)
        .send({ username: otherLead.username })
        .expect(201);
      (await User.findById(otherLead._id).lean()).teams.map(String)
        .should.containEql(String(team._id));
    });

    it('does not let an API token manage membership', async () => {
      await request(app)
        .post(`${baseUrl}team/${team._id}/members`)
        .set('x-api-key', leadToken)
        .send({ username: outsider.username })
        .expect(403);
    });
  });

  describe('DELETE /team/:teamId/members/:userId', () => {
    it('lets a team lead remove a user, leaving their other teams intact', async () => {
      await leadAgent.delete(`${baseUrl}team/${team._id}/members/${member._id}`).expect(200);
      const list = await members(leadAgent, team._id);
      list.map((u) => u.username).should.not.containEql(member.username);
      const stored = await User.findById(member._id).lean();
      stored.teams.map(String).should.eql([String(otherTeam._id)]);
    });

    it('respond with 404 when the user is not a member of the team', async () => {
      await leadAgent.delete(`${baseUrl}team/${team._id}/members/${member._id}`).expect(404);
    });

    it('respond with 403 when a team lead removes themselves', async () => {
      await leadAgent.delete(`${baseUrl}team/${team._id}/members/${lead._id}`).expect(403);
      (await User.findById(lead._id).lean()).teams.map(String).should.containEql(String(team._id));
    });

    it('respond with 403 when a team lead removes another team lead, but an admin can', async () => {
      await leadAgent.delete(`${baseUrl}team/${team._id}/members/${teamLead2._id}`).expect(403);
      await adminAgent.delete(`${baseUrl}team/${team._id}/members/${teamLead2._id}`).expect(200);
      (await User.findById(teamLead2._id).lean()).teams.should.have.length(0);
    });

    it('respond with 403 when a team lead removes a member from a team they do not lead', async () => {
      await leadAgent.delete(`${baseUrl}team/${otherTeam._id}/members/${member._id}`).expect(403);
      (await User.findById(member._id).lean()).teams.map(String)
        .should.containEql(String(otherTeam._id));
    });

    it('respond with 422 for a malformed user id', async () => {
      await leadAgent.delete(`${baseUrl}team/${team._id}/members/not-an-id`).expect(422);
    });
  });

  describe('last login', () => {
    it('is unset until the user signs in and is recorded when they do', async () => {
      const fresh = await createUser('fresh', 'user');
      should.not.exist((await User.findById(fresh._id).lean()).lastLoginAt);

      const before = Date.now();
      await login(fresh.username);
      const stored = await User.findById(fresh._id).lean();
      should.exist(stored.lastLoginAt);
      stored.lastLoginAt.getTime().should.be.within(before - 1000, Date.now() + 1000);
    });

    it('does not move on a failed login', async () => {
      const fresh = await createUser('fresh-failed', 'user');
      await request(app)
        .post(`${baseUrl}auth/login`)
        .send({ username: fresh.username, password: 'wrong-password' })
        .expect(401);
      should.not.exist((await User.findById(fresh._id).lean()).lastLoginAt);
    });

    it('is not treated as an account edit (updatedAt is unchanged)', async () => {
      const fresh = await createUser('fresh-updated', 'user');
      const { updatedAt } = await User.findById(fresh._id).lean();
      await login(fresh.username);
      (await User.findById(fresh._id).lean()).updatedAt.getTime().should.equal(updatedAt.getTime());
    });

    it('is returned to an admin in the user list', async () => {
      const res = await adminAgent.get(`${baseUrl}users`).expect(200);
      const listed = res.body.find((u) => u.username === lead.username);
      should.exist(listed.lastLoginAt);
      const never = res.body.find((u) => u.username === outsider.username);
      should.not.exist(never.lastLoginAt);
    });
  });

  describe('who triggered a build', () => {
    const buildRequest = (name) => ({
      environment: environment.name,
      team: team.name,
      name,
      component: 'component1',
      start: new Date().toISOString(),
    });

    it('records the user of a session-created build', async () => {
      const res = await leadAgent
        .post(`${baseUrl}build`)
        .send(buildRequest(`${PREFIX}-session-build`))
        .expect(201);
      res.body.triggeredBy.username.should.equal(lead.username);
      String(res.body.triggeredBy.user).should.equal(String(lead._id));
      should.not.exist(res.body.triggeredBy.tokenName);
    });

    it('records the user and the token name of a build created with an API key', async () => {
      const created = await request(app)
        .post(`${baseUrl}build`)
        .set('x-api-key', leadToken)
        .send(buildRequest(`${PREFIX}-token-build`))
        .expect(201);
      created.body.triggeredBy.username.should.equal(lead.username);
      created.body.triggeredBy.tokenName.should.equal('unit-testing-ci');
      should.not.exist(JSON.stringify(created.body).match(leadToken));

      const fetched = await leadAgent.get(`${baseUrl}build/${created.body._id}`).expect(200);
      fetched.body.triggeredBy.tokenName.should.equal('unit-testing-ci');
    });

    it('keeps the username after the account is deleted', async () => {
      const throwaway = await createUser('throwaway', 'user', [team._id]);
      const throwawayAgent = await login(throwaway.username);
      const created = await throwawayAgent
        .post(`${baseUrl}build`)
        .send(buildRequest(`${PREFIX}-throwaway-build`))
        .expect(201);
      await User.deleteOne({ _id: throwaway._id });
      const fetched = await adminAgent.get(`${baseUrl}build/${created.body._id}`).expect(200);
      fetched.body.triggeredBy.username.should.equal(throwaway.username);
    });

    it('shows who triggered the build in the HTML report', async () => {
      const created = await leadAgent
        .post(`${baseUrl}build`)
        .send(buildRequest(`${PREFIX}-report-build`))
        .expect(201);
      const report = await leadAgent.get(`${baseUrl}build/${created.body._id}/report`).expect(200);
      report.text.should.containEql('Triggered by');
      report.text.should.containEql(lead.username);
    });
  });

  describe('GET /build/:buildId/report theme', () => {
    let reportHtml;

    before(async () => {
      const created = await leadAgent
        .post(`${baseUrl}build`)
        .send({
          environment: environment.name,
          team: team.name,
          name: `${PREFIX}-theme-build`,
          component: 'component1',
          start: new Date().toISOString(),
        })
        .expect(201);
      reportHtml = (await leadAgent.get(`${baseUrl}build/${created.body._id}/report`).expect(200)).text;
    });

    it('includes the dark/light toggle, hidden until the script enables it', () => {
      reportHtml.should.match(/<button[^>]*id="theme-toggle"[^>]*hidden/);
    });

    it('selects the theme with data-theme and falls back to the OS only when unset', () => {
      reportHtml.should.containEql(":root[data-theme='dark']");
      reportHtml.should.containEql(':root:not([data-theme])');
    });

    it('applies a remembered choice before first paint, under the report nonce', () => {
      reportHtml.should.match(/<script nonce="[^"]+">\s*try \{\s*var savedTheme/);
    });
  });
});
