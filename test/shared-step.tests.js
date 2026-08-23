/**
 * Tests for re-usable shared steps and the expansion behind them.
 *
 * The load-bearing assertions are the ones about expansion placement: a frozen version
 * stores expanded steps, never a reference, so editing a shared step must leave every
 * previously written version showing exactly what its tester saw. Test 2 of the plan's
 * versioning suite lives here.
 */
const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const User = require('../app/models/user.js');
const SharedStep = require('../app/models/shared-step.js');
const ManualTestCase = require('../app/models/manual-test-case.js');
const ManualTestCaseVersion = require('../app/models/manual-test-case-version.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

const MEMBER_PASSWORD = 'unit-testing-SsMember1!';
const LEAD_PASSWORD = 'unit-testing-SsLead1!';
const OUTSIDER_PASSWORD = 'unit-testing-SsOutsider1!';

describe('Shared Step API Tests', () => {
  let memberAgent;
  let leadAgent;
  let outsiderAgent;
  let team;
  let otherTeam;
  let loginStep;

  const login = (username, password) => new Promise((resolve, reject) => {
    const agent = request.agent(app);
    agent
      .post(`${baseUrl}auth/login`)
      .send({ username, password })
      .end((err, res) => {
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

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-ss/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-ss/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-ss/ }).exec(),
    ]);
    logger.info('Cleared any lingering shared step fixtures');

    team = await new Team({ name: 'unit-testing-ss-team', components: [{ name: 'ss-component' }] }).save();
    otherTeam = await new Team({ name: 'unit-testing-ss-other', components: [{ name: 'ss-other' }] }).save();
    await SharedStep.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec();

    const [memberHash, leadHash, outsiderHash] = await Promise.all([
      bcrypt.hash(MEMBER_PASSWORD, 10),
      bcrypt.hash(LEAD_PASSWORD, 10),
      bcrypt.hash(OUTSIDER_PASSWORD, 10),
    ]);
    await User.create([
      {
        username: 'unit-testing-ss-member', password: memberHash, role: 'user', teams: [team._id],
      },
      {
        username: 'unit-testing-ss-lead', password: leadHash, role: 'team_lead', teams: [team._id],
      },
      {
        username: 'unit-testing-ss-outsider', password: outsiderHash, role: 'team_lead', teams: [otherTeam._id],
      },
    ]);

    [memberAgent, leadAgent, outsiderAgent] = await Promise.all([
      login('unit-testing-ss-member', MEMBER_PASSWORD),
      login('unit-testing-ss-lead', LEAD_PASSWORD),
      login('unit-testing-ss-outsider', OUTSIDER_PASSWORD),
    ]);
    await testUtils.getAdminAgent();
  });

  after(async () => {
    const cases = await ManualTestCase.find({ title: /^unit-testing-ss/ }).select('_id').lean();
    await Promise.all([
      ManualTestCaseVersion.deleteMany({ testCase: { $in: cases.map((c) => c._id) } }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-ss/ }).exec(),
      SharedStep.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec(),
      User.deleteMany({ username: /^unit-testing-ss/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-ss/ }).exec(),
    ]);
  });

  describe('POST /shared-step', () => {
    it('respond with 201 when a team lead creates a shared step', async () => {
      const res = await send(leadAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-ss login',
        description: 'Log in as a standard user.',
        steps: [
          { action: 'Navigate to the login page', expected: 'The login form is displayed' },
          { action: 'Submit valid credentials', expected: 'The dashboard is displayed' },
        ],
      });
      should(res.status).equal(201);
      loginStep = res.body;
      should(res.body.version).equal(1);
      should(res.body.steps).have.length(2);
      should(res.body.steps[0].order).equal(1);
    });

    it('respond with 403 when a plain team member tries to create one', async () => {
      const res = await send(memberAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-ss sneaky',
        steps: [{ action: 'x' }],
      });
      should(res.status).equal(403);
    });

    it('respond with 409 for a duplicate name within the team', async () => {
      const res = await send(leadAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-ss login',
        steps: [{ action: 'x' }],
      });
      should(res.status).equal(409);
    });

    it('respond with 422 when no steps are supplied', async () => {
      const res = await send(leadAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-ss empty',
        steps: [],
      });
      should(res.status).equal(422);
    });

    it('respond with 400 when a shared step tries to include another', async () => {
      const res = await send(leadAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-ss nested',
        steps: [{ action: 'include', sharedStep: loginStep._id }],
      });
      should(res.status).equal(400);
      should(res.body.message).match(/cannot include another shared step/);
    });
  });

  describe('GET /shared-step', () => {
    it('is readable by a plain team member', async () => {
      const res = await send(memberAgent, 'get', `shared-step?teamId=${team._id}`);
      should(res.status).equal(200);
      should(res.body.sharedSteps.length).be.above(0);
      should(res.body.metrics.totalSharedSteps).be.above(0);
    });

    it('filters by search term', async () => {
      const res = await send(memberAgent, 'get', `shared-step?teamId=${team._id}&search=login`);
      should(res.status).equal(200);
      should(res.body.sharedSteps.length).be.above(0);
    });

    it('respond with 403 for a user outside the team', async () => {
      const res = await send(outsiderAgent, 'get', `shared-step?teamId=${team._id}`);
      should(res.status).equal(403);
    });
  });

  describe('including a shared step in a test case', () => {
    let testCase;

    it('accepts a step that references a shared step', async () => {
      const res = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-ss case with inclusion',
        steps: [
          { action: 'Open the application', expected: 'The landing page loads' },
          { sharedStep: loginStep._id, action: 'placeholder' },
          { action: 'Open the reports tab', expected: 'Reports are listed' },
        ],
      });
      should(res.status).equal(201);
      testCase = res.body;
      // The head keeps the placeholder so it tracks the shared step.
      should(testCase.steps).have.length(3);
      should(testCase.steps[1].sharedStep).equal(loginStep._id);
    });

    it('expands the shared step on read when asked', async () => {
      const res = await send(memberAgent, 'get', `manual-test-case/${testCase._id}?expand=true`);
      should(res.status).equal(200);
      should(res.body.expanded).equal(true);
      // 1 + 2 (expanded) + 1 = 4 steps, contiguously ordered.
      should(res.body.steps).have.length(4);
      should(res.body.steps.map((s) => s.order)).eql([1, 2, 3, 4]);
      should(res.body.steps[1].action).equal('Navigate to the login page');
      should(res.body.steps[1].sharedStepRef).equal(loginStep._id);
      should(res.body.steps[1].sharedStepVersion).equal(1);
      // An expanded step is literal, never itself a reference.
      should(res.body.steps[1].sharedStep).equal(undefined);
    });

    it('leaves the head unexpanded by default', async () => {
      const res = await send(memberAgent, 'get', `manual-test-case/${testCase._id}`);
      should(res.status).equal(200);
      should(res.body.steps).have.length(3);
      should(res.body.expanded).equal(undefined);
    });

    it('stores the expanded steps in the frozen version', async () => {
      const version = await ManualTestCaseVersion
        .findOne({ testCase: testCase._id, version: 1 })
        .lean();
      should(version.steps).have.length(4);
      should(version.steps[1].action).equal('Navigate to the login page');
      should(version.steps[1].sharedStepVersion).equal(1);
      // A version must never hold a reference that could resolve differently later.
      version.steps.forEach((step) => should(step.sharedStep).equal(undefined));
    });

    it('respond with 404 for a shared step that does not exist', async () => {
      const res = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-ss bad reference',
        steps: [{ sharedStep: '5f7e2b9e8f1b2c0017a1b2c3', action: 'x' }],
      });
      should(res.status).equal(404);
      should(res.body.message).match(/No shared step found/);
    });

    it('respond with 404 for a shared step belonging to another team', async () => {
      const foreign = await send(outsiderAgent, 'post', 'shared-step', {
        team: otherTeam._id.toString(),
        name: 'unit-testing-ss foreign',
        steps: [{ action: 'foreign step' }],
      });
      should(foreign.status).equal(201);

      const res = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-ss cross team reference',
        steps: [{ sharedStep: foreign.body._id, action: 'x' }],
      });
      should(res.status).equal(404);
    });
  });

  describe('GET /shared-step/:id/usage', () => {
    it('lists the test cases that include the shared step', async () => {
      const res = await send(memberAgent, 'get', `shared-step/${loginStep._id}/usage`);
      should(res.status).equal(200);
      should(res.body.metrics.totalTestCases).be.above(0);
      should(res.body.testCases[0].title).match(/^unit-testing-ss/);
    });
  });

  describe('editing a shared step cascades into referencing cases', () => {
    let caseA;
    let caseB;

    before(async () => {
      const [a, b] = await Promise.all([
        send(memberAgent, 'post', 'manual-test-case', {
          team: team._id.toString(),
          title: 'unit-testing-ss cascade case A',
          steps: [{ sharedStep: loginStep._id, action: 'placeholder' }, { action: 'Do A' }],
        }),
        send(memberAgent, 'post', 'manual-test-case', {
          team: team._id.toString(),
          title: 'unit-testing-ss cascade case B',
          steps: [{ sharedStep: loginStep._id, action: 'placeholder' }, { action: 'Do B' }],
        }),
      ]);
      caseA = a.body;
      caseB = b.body;
      should(caseA.version).equal(1);
      should(caseB.version).equal(1);
    });

    it('bumps the shared step version and versions every referencing case', async () => {
      const res = await send(leadAgent, 'put', `shared-step/${loginStep._id}`, {
        steps: [
          { action: 'Navigate to the login page', expected: 'The login form is displayed' },
          { action: 'Accept the cookie banner', expected: 'The banner is dismissed' },
          { action: 'Submit valid credentials', expected: 'The dashboard is displayed' },
        ],
      });
      should(res.status).equal(200);
      should(res.body.version).equal(2);
      // Both cascade cases plus the inclusion case created earlier.
      should(res.body.cascade.testCasesVersioned).be.aboveOrEqual(3);
      should(res.body.cascade.failures).have.length(0);
    });

    it('leaves each referencing case on a new version', async () => {
      const [a, b] = await Promise.all([
        send(memberAgent, 'get', `manual-test-case/${caseA._id}`),
        send(memberAgent, 'get', `manual-test-case/${caseB._id}`),
      ]);
      should(a.body.version).equal(2);
      should(b.body.version).equal(2);
    });

    it('leaves the OLD version showing the OLD shared content', async () => {
      // This is the assertion the whole design exists for.
      const version1 = await ManualTestCaseVersion
        .findOne({ testCase: caseA._id, version: 1 })
        .lean();
      // The shared step had two steps at v1, plus the case's own trailing step.
      should(version1.steps).have.length(3);
      should(version1.steps[0].action).equal('Navigate to the login page');
      should(version1.steps[1].action).equal('Submit valid credentials');
      should(version1.steps[2].action).equal('Do A');
      should(version1.steps[0].sharedStepVersion).equal(1);
      // No trace of the step added by the edit.
      const actions = version1.steps.map((s) => s.action);
      should(actions).not.containEql('Accept the cookie banner');
    });

    it('shows the NEW shared content in the new version', async () => {
      const version2 = await ManualTestCaseVersion
        .findOne({ testCase: caseA._id, version: 2 })
        .lean();
      should(version2.steps).have.length(4);
      should(version2.steps.map((s) => s.action)).containEql('Accept the cookie banner');
      should(version2.steps[0].sharedStepVersion).equal(2);
    });

    it('keeps the head tracking the shared step rather than flattening it', async () => {
      const head = await ManualTestCase.findById(caseA._id).lean();
      should(head.steps).have.length(2);
      should(head.steps[0].sharedStep.toString()).equal(loginStep._id);
    });

    it('does not cascade when only the name or description changes', async () => {
      const before = await ManualTestCase.findById(caseA._id).lean();
      const res = await send(leadAgent, 'put', `shared-step/${loginStep._id}`, {
        description: 'Log in as a standard user, dismissing the cookie banner.',
      });
      should(res.status).equal(200);
      should(res.body.version).equal(2);
      should(res.body.cascade.testCasesVersioned).equal(0);

      const after = await ManualTestCase.findById(caseA._id).lean();
      should(after.version).equal(before.version);
    });

    it('does not cascade when the steps are re-sent unchanged', async () => {
      const current = await SharedStep.findById(loginStep._id).lean();
      const res = await send(leadAgent, 'put', `shared-step/${loginStep._id}`, {
        steps: current.steps.map((step) => ({
          action: step.action,
          expected: step.expected,
          order: step.order,
        })),
      });
      should(res.status).equal(200);
      should(res.body.version).equal(2);
      should(res.body.cascade.testCasesVersioned).equal(0);
    });

    it('respond with 403 when a plain member tries to edit', async () => {
      const res = await send(memberAgent, 'put', `shared-step/${loginStep._id}`, {
        description: 'hijacked',
      });
      should(res.status).equal(403);
    });
  });

  describe('DELETE /shared-step/:id', () => {
    it('respond with 409 when the shared step is still referenced', async () => {
      const res = await send(leadAgent, 'delete', `shared-step/${loginStep._id}`);
      should(res.status).equal(409);
      should(res.body.message).match(/included by/);
    });

    it('deletes a shared step that nothing references', async () => {
      const created = await send(leadAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-ss unreferenced',
        steps: [{ action: 'nothing uses me' }],
      });
      should(created.status).equal(201);

      const res = await send(leadAgent, 'delete', `shared-step/${created.body._id}`);
      should(res.status).equal(200);
      const gone = await SharedStep.findById(created.body._id).lean();
      should(gone).equal(null);
    });

    it('respond with 403 for a plain team member', async () => {
      const res = await send(memberAgent, 'delete', `shared-step/${loginStep._id}`);
      should(res.status).equal(403);
    });

    it('respond with 404 for an unknown id', async () => {
      const res = await send(leadAgent, 'delete', 'shared-step/5f7e2b9e8f1b2c0017a1b2c3');
      should(res.status).equal(404);
    });
  });

  describe('a deleted shared step leaves a resolvable case', () => {
    it('keeps the placeholder as an unresolved step rather than dropping it', async () => {
      const created = await send(leadAgent, 'post', 'shared-step', {
        team: team._id.toString(),
        name: 'unit-testing-ss doomed',
        steps: [{ action: 'about to vanish' }],
      });
      const doomed = created.body;

      const caseRes = await send(memberAgent, 'post', 'manual-test-case', {
        team: team._id.toString(),
        title: 'unit-testing-ss orphaned reference',
        steps: [{ sharedStep: doomed._id, action: 'placeholder' }, { action: 'Still here' }],
      });
      should(caseRes.status).equal(201);

      // Bypasses the delete guard on purpose: the guard stops this happening through the
      // API, but the expansion must still degrade safely if a document goes missing.
      await SharedStep.findByIdAndRemove(doomed._id).exec();

      const res = await send(memberAgent, 'get', `manual-test-case/${caseRes.body._id}?expand=true`);
      should(res.status).equal(200);
      should(res.body.steps).have.length(2);
      should(res.body.steps[0].unresolvedSharedStep).equal(true);
      should(res.body.steps[1].action).equal('Still here');
    });
  });
});
