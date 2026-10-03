/**
 * Team scoping of screenshots, baselines, metrics and writes into builds.
 *
 * Each test acts as a plain user of one team ("other") against data that belongs to
 * another team ("owner"), and checks that it can neither read nor change it. These all
 * returned the other team's data (or a 2xx) before the fix.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const should = require('should');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const Build = require('../app/models/build.js');
const Screenshot = require('../app/models/screenshot.js');
const TestExecution = require('../app/models/execution.js');
const Baseline = require('../app/models/baseline.js');
const Environment = require('../app/models/environment.js');
const Phase = require('../app/models/phase.js');
const { Team } = require('../app/models/team.js');
const buildUtils = require('../app/utils/build-utils.js');
const baselineUtils = require('../app/utils/baseline-utils.js');

const baseUrl = '/rest/api/v1.0/';
const IMAGE = './test/resources/angles_home_page.jpg';
const OWNER_PASSWORD = 'unit-testing-TsOwner1!';
const OTHER_PASSWORD = 'unit-testing-TsOther1!';

const SHARED_VIEW = 'unit-testing-ts-shared-view';
const OWNER_ONLY_VIEW = 'unit-testing-ts-owner-only-view';
const OWNER_TAG = 'unit-testing-ts-owner-tag';

describe('Team scoping Tests', () => {
  let ownerAgent;
  let otherAgent;
  let ownerTeam;
  let otherTeam;
  let environment;
  let phase;
  let ownerBuild;
  let otherBuild;
  let ownerShot;
  let ownerOnlyShot;
  let otherShot;
  let ownerBaseline;

  const login = (username, password) => new Promise((resolve, reject) => {
    const agent = request.agent(app);
    agent.post(`${baseUrl}auth/login`).send({ username, password }).end((err, res) => {
      if (err) return reject(err);
      if (res.status !== 200) return reject(new Error(`login failed for ${username}: ${res.status}`));
      return resolve(agent);
    });
  });

  const send = (agent, method, url, body) => new Promise((resolve, reject) => {
    const req = agent[method](`${baseUrl}${url}`).set('Accept', 'application/json');
    if (body !== undefined) req.send(body);
    req.end((err, res) => (err ? reject(err) : resolve(res)));
  });

  const uploadScreenshot = (agent, buildId, view, tags) => new Promise((resolve, reject) => {
    const req = agent.post(`${baseUrl}screenshot`)
      .field('buildId', buildId.toString())
      .field('timestamp', new Date().toISOString())
      .field('view', view)
      .field('platformName', 'linux')
      .field('browserName', 'chrome');
    if (tags) req.field('tags', JSON.stringify(tags));
    req.attach('screenshot', IMAGE).end((err, res) => (err ? reject(err) : resolve(res)));
  });

  const newBuild = (team, name) => new Build({
    name,
    team,
    environment,
    status: buildUtils.executionStates[0],
    component: team.components[0]._id,
    suites: [],
    result: new Map(buildUtils.defaultResultMap),
  }).save();

  const removeFixtures = async () => {
    const teams = await Team.find({ name: /^unit-testing-ts-/ }).select('_id').lean();
    const teamIds = teams.map((t) => t._id);
    const builds = await Build.find({ team: { $in: teamIds } }).select('_id').lean();
    const buildIds = builds.map((b) => b._id);
    const screenshots = await Screenshot.find({ build: { $in: buildIds } }).lean();
    screenshots.forEach((s) => { try { fs.unlinkSync(s.path); } catch (e) { /* gone */ } });
    await Promise.all([
      Baseline.deleteMany({ $or: [{ team: { $in: teamIds } }, { view: /^unit-testing-ts-/ }] }).exec(),
      Screenshot.deleteMany({ build: { $in: buildIds } }).exec(),
      TestExecution.deleteMany({ build: { $in: buildIds } }).exec(),
      Build.deleteMany({ _id: { $in: buildIds } }).exec(),
      Environment.deleteMany({ name: /^unit-testing-ts-/ }).exec(),
      Phase.deleteMany({ name: /^unit-testing-ts-/ }).exec(),
      User.deleteMany({ username: /^unit-testing-ts-/ }).exec(),
      Team.deleteMany({ _id: { $in: teamIds } }).exec(),
    ]);
  };

  before(async () => {
    await removeFixtures();
    ownerTeam = await new Team({ name: 'unit-testing-ts-owner', components: [{ name: 'ts-owner' }] }).save();
    otherTeam = await new Team({ name: 'unit-testing-ts-other', components: [{ name: 'ts-other' }] }).save();
    environment = await new Environment({ name: 'unit-testing-ts-env' }).save();
    phase = await new Phase({ name: 'unit-testing-ts-phase', orderNumber: 99 }).save();
    ownerBuild = await newBuild(ownerTeam, 'unit-testing-ts-owner-build');
    otherBuild = await newBuild(otherTeam, 'unit-testing-ts-other-build');
    const [ownerHash, otherHash] = await Promise.all([
      bcrypt.hash(OWNER_PASSWORD, 10), bcrypt.hash(OTHER_PASSWORD, 10),
    ]);
    await User.create([
      {
        username: 'unit-testing-ts-owner', password: ownerHash, role: 'user', teams: [ownerTeam._id],
      },
      {
        username: 'unit-testing-ts-other', password: otherHash, role: 'user', teams: [otherTeam._id],
      },
    ]);
    [ownerAgent, otherAgent] = await Promise.all([
      login('unit-testing-ts-owner', OWNER_PASSWORD),
      login('unit-testing-ts-other', OTHER_PASSWORD),
    ]);

    ownerShot = (await uploadScreenshot(ownerAgent, ownerBuild._id, SHARED_VIEW, [OWNER_TAG])).body;
    ownerOnlyShot = (await uploadScreenshot(ownerAgent, ownerBuild._id, OWNER_ONLY_VIEW)).body;
    otherShot = (await uploadScreenshot(otherAgent, otherBuild._id, SHARED_VIEW)).body;
    should(ownerShot._id).be.a.String();
    should(otherShot._id).be.a.String();

    const res = await send(ownerAgent, 'post', 'baseline', { screenshotId: ownerShot._id, view: SHARED_VIEW });
    should(res.status).equal(201);
    ownerBaseline = res.body;
  });

  after(removeFixtures);

  const ownerBuildIds = () => [ownerBuild._id.toString()];
  const buildsIn = (screenshots) => screenshots.map((s) => s.build.toString());

  describe('Screenshot lookups across builds', () => {
    it('GET /metrics/screenshot only returns the caller\'s teams\' screenshots', async () => {
      const res = await send(otherAgent, 'get', 'metrics/screenshot?thumbnail=true&limit=1000');
      should(res.status).equal(200);
      const shots = [...res.body.views, ...res.body.tags]
        .flatMap((group) => group.platforms)
        .map((platform) => platform.screenshot)
        .filter(Boolean);
      buildsIn(shots).forEach((buildId) => should(ownerBuildIds()).not.containEql(buildId));
      should(res.body.views.map((v) => v._id)).not.containEql(OWNER_ONLY_VIEW);
    });

    it('GET /screenshot/grouped/platform only returns the caller\'s teams\' screenshots', async () => {
      const res = await send(otherAgent, 'get', `screenshot/grouped/platform?view=${SHARED_VIEW}&numberOfDays=1`);
      should(res.status).equal(200);
      should(res.body.length).equal(1);
      should(res.body[0]._id).equal(otherShot._id);
    });

    it('GET /screenshot/grouped/tag only returns the caller\'s teams\' screenshots', async () => {
      const res = await send(otherAgent, 'get', `screenshot/grouped/tag?tag=${OWNER_TAG}&numberOfDays=1`);
      should(res.status).equal(200);
      should(res.body).eql([]);
      const own = await send(ownerAgent, 'get', `screenshot/grouped/tag?tag=${OWNER_TAG}&numberOfDays=1`);
      should(own.body.map((s) => s._id)).eql([ownerShot._id]);
    });

    it('GET /screenshot/views and /screenshot/tags do not reveal another team\'s names', async () => {
      const views = await send(otherAgent, 'get', 'screenshot/views?view=unit-testing-ts');
      should(views.status).equal(200);
      should(views.body).not.containEql(OWNER_ONLY_VIEW);
      should(views.body).containEql(SHARED_VIEW);
      const tags = await send(otherAgent, 'get', 'screenshot/tags?tag=unit-testing-ts');
      should(tags.status).equal(200);
      should(tags.body).not.containEql(OWNER_TAG);
      const ownTags = await send(ownerAgent, 'get', 'screenshot/tags?tag=unit-testing-ts');
      should(ownTags.body).containEql(OWNER_TAG);
    });
  });

  describe('Baselines', () => {
    const baselineQuery = `baseline?view=${SHARED_VIEW}&platformName=linux&browserName=chrome`;

    it('are created with the team of their screenshot', () => {
      should(ownerBaseline.team).equal(ownerTeam._id.toString());
    });

    it('are listed for their own team only', async () => {
      const other = await send(otherAgent, 'get', baselineQuery);
      should(other.status).equal(200);
      should(other.body).eql([]);
      const owner = await send(ownerAgent, 'get', baselineQuery);
      should(owner.body.map((b) => b._id)).eql([ownerBaseline._id]);
    });

    it('cannot be listed for a named team the caller cannot read', async () => {
      const res = await send(otherAgent, 'get', `${baselineQuery}&teamId=${ownerTeam._id}`);
      should(res.status).equal(403);
    });

    it('GET /baseline/:id returns the baseline to its team and 403 to others', async () => {
      const owner = await send(ownerAgent, 'get', `baseline/${ownerBaseline._id}`);
      should(owner.status).equal(200);
      should(owner.body._id).equal(ownerBaseline._id);
      const other = await send(otherAgent, 'get', `baseline/${ownerBaseline._id}`);
      should(other.status).equal(403);
    });

    it('cannot be changed by another team', async () => {
      const res = await send(otherAgent, 'put', `baseline/${ownerBaseline._id}`, {
        ignoreBoxes: [{
          left: 0, top: 0, right: 0, bottom: 0,
        }],
      });
      should(res.status).equal(403);
      const stored = await Baseline.findById(ownerBaseline._id).lean();
      should(stored.ignoreBoxes).eql([]);
    });

    it('cannot be pointed at another team\'s screenshot', async () => {
      const res = await send(ownerAgent, 'put', `baseline/${ownerBaseline._id}`, { screenshotId: otherShot._id });
      should(res.status).equal(403);
    });

    it('cannot be created from another team\'s screenshot', async () => {
      const res = await send(otherAgent, 'post', 'baseline', { screenshotId: ownerShot._id, view: SHARED_VIEW });
      should(res.status).equal(403);
    });

    it('are never compared across teams', async () => {
      // The other team has no baseline of its own yet; the owner's must not be used.
      const res = await send(otherAgent, 'get', `screenshot/${otherShot._id}/baseline/compare`);
      should(res.status).equal(404);
      const image = await send(otherAgent, 'get', `screenshot/${otherShot._id}/baseline/compare/image`);
      should(image.status).equal(404);
    });

    it('can be created per team for the same view, and each team compares against its own', async () => {
      const created = await send(otherAgent, 'post', 'baseline', { screenshotId: otherShot._id, view: SHARED_VIEW });
      should(created.status).equal(201);
      should(created.body.team).equal(otherTeam._id.toString());
      const compare = await send(otherAgent, 'get', `screenshot/${otherShot._id}/baseline/compare`);
      should(compare.status).equal(200);
      const owner = await send(ownerAgent, 'get', `screenshot/${ownerShot._id}/baseline/compare`);
      should(owner.status).equal(200);
    });

    it('written before teams were recorded get their team from the startup backfill', async () => {
      const legacy = await new Baseline({
        screenshot: ownerOnlyShot._id,
        view: OWNER_ONLY_VIEW,
        platform: { platformName: 'linux', browserName: 'chrome' },
      }).save();
      const result = await baselineUtils.backfillTeams();
      should(result.updated).be.aboveOrEqual(1);
      const stored = await Baseline.findById(legacy._id).lean();
      should(stored.team.toString()).equal(ownerTeam._id.toString());
    });
  });

  describe('Writing into another team\'s build', () => {
    it('POST /execution returns 403 and stores nothing', async () => {
      const res = await send(otherAgent, 'post', 'execution', {
        title: 'unit-testing-ts injected', suite: 'unit-testing-ts suite', build: ownerBuild._id.toString(),
      });
      should(res.status).equal(403);
      should(await TestExecution.countDocuments({ title: 'unit-testing-ts injected' })).equal(0);
    });

    it('POST /screenshot returns 403 and leaves no file behind', async () => {
      const directory = path.resolve(__dirname, '../screenshots', ownerBuild._id.toString());
      const before = fs.existsSync(directory) ? fs.readdirSync(directory).length : 0;
      const res = await uploadScreenshot(otherAgent, ownerBuild._id, 'unit-testing-ts-injected');
      should(res.status).equal(403);
      const after = fs.existsSync(directory) ? fs.readdirSync(directory).length : 0;
      should(after).equal(before);
      should(await Screenshot.countDocuments({ view: 'unit-testing-ts-injected' })).equal(0);
    });
  });

  describe('GET /metrics/phase', () => {
    it('returns 403 for a team the caller cannot read', async () => {
      const res = await send(otherAgent, 'get', `metrics/phase?teamId=${ownerTeam._id}`);
      should(res.status).equal(403);
    });

    it('still works for the caller\'s own team', async () => {
      const res = await send(ownerAgent, 'get', `metrics/phase?teamId=${ownerTeam._id}`);
      should(res.status).equal(200);
    });
  });

  describe('Shared environments and phases', () => {
    it('PUT /environment/:id is admin only', async () => {
      const res = await send(otherAgent, 'put', `environment/${environment._id}`, { name: 'unit-testing-ts-renamed' });
      should(res.status).equal(403);
      const stored = await Environment.findById(environment._id).lean();
      should(stored.name).equal('unit-testing-ts-env');
    });

    it('PUT /phase/:id is admin only', async () => {
      const res = await send(otherAgent, 'put', `phase/${phase._id}`, { orderNumber: 1 });
      should(res.status).equal(403);
    });
  });
});
