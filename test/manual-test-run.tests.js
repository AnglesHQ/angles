/**
 * Tests for manual test runs.
 *
 * The load-bearing behaviour is the join with the automated model: a run creates a real
 * Build tagged executionType 'manual', and results are written as TestExecution documents
 * through the same buildMetricsUtils path automated results take. If that drifts, manual
 * results stop appearing on the dashboard - or appear with the wrong totals.
 *
 * Also covers the version binding: a case edited mid-run must not shift under the tester.
 */
const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const User = require('../app/models/user.js');
const Build = require('../app/models/build.js');
const TestExecution = require('../app/models/execution.js');
const ManualTestRun = require('../app/models/manual-test-run.js');
const ManualTestCase = require('../app/models/manual-test-case.js');
const ManualTestCaseVersion = require('../app/models/manual-test-case-version.js');
const ManualChangeHistory = require('../app/models/manual-change-history.js');
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

const MEMBER_PASSWORD = 'unit-testing-MrMember1!';
const LEAD_PASSWORD = 'unit-testing-MrLead1!';
const OUTSIDER_PASSWORD = 'unit-testing-MrOutsider1!';

describe('Manual Test Run API Tests', () => {
  let memberAgent;
  let leadAgent;
  let outsiderAgent;
  let team;
  let otherTeam;
  let environment;
  let caseA;
  let caseB;

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

  const createCase = (title, extra = {}) => send(memberAgent, 'post', 'manual-test-case', {
    team: team._id.toString(),
    title,
    status: 'ACTIVE',
    steps: [
      { action: 'Open the page', expected: 'Page loads' },
      { action: 'Click submit', expected: 'Form submits' },
    ],
    ...extra,
  });

  const createRun = (agent, body) => send(agent, 'post', 'manual-test-run', {
    name: 'unit-testing-mr regression run',
    team: team._id.toString(),
    environment: environment.name,
    testCaseIds: [caseA._id],
    ...body,
  });

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-mr/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-mr/ }).exec(),
      ManualTestRun.deleteMany({ name: /^unit-testing-mr/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-mr/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-mr/ }).exec(),
    ]);
    logger.info('Cleared any lingering manual run fixtures');

    team = await new Team({ name: 'unit-testing-mr-team', components: [{ name: 'mr-component' }] }).save();
    otherTeam = await new Team({ name: 'unit-testing-mr-other', components: [{ name: 'mr-other' }] }).save();
    environment = await new Environment({ name: 'unit-testing-mr-env' }).save();

    const [memberHash, leadHash, outsiderHash] = await Promise.all([
      bcrypt.hash(MEMBER_PASSWORD, 10),
      bcrypt.hash(LEAD_PASSWORD, 10),
      bcrypt.hash(OUTSIDER_PASSWORD, 10),
    ]);
    await User.create([
      {
        username: 'unit-testing-mr-member', password: memberHash, role: 'user', teams: [team._id],
      },
      {
        username: 'unit-testing-mr-lead', password: leadHash, role: 'team_lead', teams: [team._id],
      },
      {
        username: 'unit-testing-mr-outsider', password: outsiderHash, role: 'user', teams: [otherTeam._id],
      },
    ]);

    [memberAgent, leadAgent, outsiderAgent] = await Promise.all([
      login('unit-testing-mr-member', MEMBER_PASSWORD),
      login('unit-testing-mr-lead', LEAD_PASSWORD),
      login('unit-testing-mr-outsider', OUTSIDER_PASSWORD),
    ]);
    await testUtils.getAdminAgent();

    caseA = (await createCase('unit-testing-mr case A')).body;
    caseB = (await createCase('unit-testing-mr case B')).body;
  });

  after(async () => {
    const runs = await ManualTestRun.find({ name: /^unit-testing-mr/ }).lean();
    const buildIds = runs.map((run) => run.build).filter(Boolean);
    const cases = await ManualTestCase.find({ title: /^unit-testing-mr/ }).select('_id').lean();
    await Promise.all([
      TestExecution.deleteMany({ build: { $in: buildIds } }).exec(),
      Build.deleteMany({ _id: { $in: buildIds } }).exec(),
      ManualTestRun.deleteMany({ name: /^unit-testing-mr/ }).exec(),
      ManualChangeHistory.deleteMany({ team: { $in: [team._id, otherTeam._id] } }).exec(),
      ManualTestCaseVersion.deleteMany({ testCase: { $in: cases.map((c) => c._id) } }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-mr/ }).exec(),
      User.deleteMany({ username: /^unit-testing-mr/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-mr/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-mr/ }).exec(),
    ]);
  });

  describe('POST /manual-test-run', () => {
    let run;

    it('creates a run bound to each case\'s current version', async () => {
      const res = await createRun(memberAgent, { testCaseIds: [caseA._id, caseB._id] });
      should(res.status).equal(201);
      run = res.body;
      should(run.status).equal('PLANNED');
      should(run.testCases).have.length(2);
      should(run.testCases[0].versionNumber).equal(1);
      should(run.testCases[0].status).equal('NOT_RUN');
      should(run.testCases[0].testCaseVersion).not.equal(undefined);
    });

    it('creates a backing build tagged as manual', async () => {
      should(run.build).not.equal(undefined);
      const build = await Build.findById(run.build).lean();
      should(build.executionType).equal('manual');
      should(build.team.toString()).equal(team._id.toString());
      should(build.suites).have.length(0);
    });

    it('captures platform details the same way an automated run does', async () => {
      const res = await createRun(memberAgent, {
        name: 'unit-testing-mr platform run',
        platforms: [{
          platformName: 'iOS',
          platformVersion: '17.2',
          deviceName: 'iPhone 15',
          screenWidth: 1179,
          screenHeight: 2556,
        }],
      });
      should(res.status).equal(201);
      should(res.body.platforms).have.length(1);
      should(res.body.platforms[0].platformName).equal('ios');
      should(res.body.platforms[0].deviceName).equal('iphone 15');
      should(res.body.platforms[0].screenWidth).equal(1179);
    });

    it('respond with 400 for a deprecated test case', async () => {
      const deprecated = await createCase('unit-testing-mr deprecated case');
      await send(memberAgent, 'put', `manual-test-case/${deprecated.body._id}`, { status: 'DEPRECATED' });

      const res = await createRun(memberAgent, { testCaseIds: [deprecated.body._id] });
      should(res.status).equal(400);
      should(res.body.message).match(/deprecated/i);
    });

    it('respond with 404 for a case belonging to another team', async () => {
      const foreign = await send(outsiderAgent, 'post', 'manual-test-case', {
        team: otherTeam._id.toString(),
        title: 'unit-testing-mr foreign case',
        steps: [{ action: 'x' }],
      });
      const res = await createRun(memberAgent, { testCaseIds: [foreign.body._id] });
      should(res.status).equal(404);
    });

    it('respond with 404 for an unknown environment', async () => {
      const res = await createRun(memberAgent, { environment: 'unit-testing-mr-nope' });
      should(res.status).equal(404);
    });

    it('respond with 403 for a user outside the team', async () => {
      const res = await createRun(outsiderAgent, {});
      should(res.status).equal(403);
    });

    it('respond with 422 when the name is missing', async () => {
      const res = await send(memberAgent, 'post', 'manual-test-run', {
        team: team._id.toString(),
        environment: environment.name,
      });
      should(res.status).equal(422);
    });

    it('leaves no orphan build behind when run creation fails', async () => {
      const before = await Build.countDocuments({ team: team._id, executionType: 'manual' });
      const res = await createRun(memberAgent, { testCaseIds: ['5f7e2b9e8f1b2c0017a1b2c3'] });
      should(res.status).equal(404);
      const after = await Build.countDocuments({ team: team._id, executionType: 'manual' });
      should(after).equal(before);
    });
  });

  describe('recording results', () => {
    let run;

    beforeEach(async () => {
      const res = await createRun(memberAgent, {
        name: 'unit-testing-mr result run',
        testCaseIds: [caseA._id, caseB._id],
      });
      run = res.body;
    });

    it('writes a manual TestExecution and folds it into the build', async () => {
      const version = await ManualTestCaseVersion
        .findById(run.testCases[0].testCaseVersion)
        .lean();

      const res = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${caseA._id}/result`, {
        status: 'PASS',
        stepResults: version.steps.map((step) => ({
          stepId: step._id.toString(),
          status: 'PASS',
          actual: 'As expected',
        })),
      });
      should(res.status).equal(200);
      should(res.body.status).equal('IN_PROGRESS');

      const runCase = res.body.testCases.find((c) => c.testCase === caseA._id);
      should(runCase.status).equal('PASS');
      should(runCase.execution).not.equal(undefined);

      const execution = await TestExecution.findById(runCase.execution).lean();
      should(execution.executionType).equal('manual');
      should(execution.status).equal('PASS');
      should(execution.manualTestCase.toString()).equal(caseA._id);
      should(execution.versionNumber).equal(1);
      should(execution.actions[0].steps).have.length(2);
      should(execution.actions[0].steps[0].actual).equal('As expected');

      // Folded through the same path an automated result takes.
      const build = await Build.findById(run.build).lean();
      should(build.result.PASS).equal(1);
      should(build.status).equal('PASS');
      should(build.suites).have.length(1);
    });

    it('records a FAIL and reflects it in the build result map', async () => {
      const res = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${caseA._id}/result`, {
        status: 'FAIL',
      });
      should(res.status).equal(200);

      const build = await Build.findById(run.build).lean();
      should(build.result.FAIL).equal(1);
      should(build.status).equal('FAIL');
    });

    it('maps BLOCKED to SKIPPED on the execution, keeping BLOCKED on the run', async () => {
      const res = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${caseA._id}/result`, {
        status: 'BLOCKED',
        notes: 'Environment was down',
      });
      should(res.status).equal(200);

      const runCase = res.body.testCases.find((c) => c.testCase === caseA._id);
      // The richer state survives on the run...
      should(runCase.status).equal('BLOCKED');

      // ...but the execution uses the closed enum the metrics layer depends on. SKIPPED,
      // not ERROR: nothing was verified and no defect was found, so it must not inflate
      // the failure count.
      const execution = await TestExecution.findById(runCase.execution).lean();
      should(execution.status).equal('SKIPPED');

      const build = await Build.findById(run.build).lean();
      should(build.result.SKIPPED).equal(1);
      should(build.result.ERROR).equal(0);
    });

    it('updates the existing execution when a result is re-recorded', async () => {
      const first = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${caseA._id}/result`, { status: 'FAIL' });
      const firstExecution = first.body.testCases.find((c) => c.testCase === caseA._id).execution;

      const second = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${caseA._id}/result`, { status: 'PASS' });
      const secondExecution = second.body.testCases.find((c) => c.testCase === caseA._id).execution;

      // Same execution updated, not a second one added - otherwise the build's totals
      // would exceed the number of cases in the run.
      should(secondExecution).equal(firstExecution);
      const count = await TestExecution.countDocuments({ build: run.build });
      should(count).equal(1);

      const build = await Build.findById(run.build).lean();
      should(build.result.PASS).equal(1);
      should(build.result.FAIL).equal(0);
    });

    it('completes the run once every case has a result', async () => {
      await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${caseA._id}/result`, { status: 'PASS' });
      const res = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${caseB._id}/result`, { status: 'PASS' });
      should(res.status).equal(200);
      should(res.body.status).equal('COMPLETED');
      should(res.body.end).not.equal(null);

      const build = await Build.findById(run.build).lean();
      should(build.result.PASS).equal(2);
    });

    it('respond with 404 for a case not in the run', async () => {
      const other = await createCase('unit-testing-mr not in run');
      const res = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${other.body._id}/result`, { status: 'PASS' });
      should(res.status).equal(404);
    });

    it('respond with 403 for a user outside the team', async () => {
      const res = await send(outsiderAgent, 'put', `manual-test-run/${run._id}/test-case/${caseA._id}/result`, { status: 'PASS' });
      should(res.status).equal(403);
    });

    it('respond with 422 for an unknown status', async () => {
      const res = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${caseA._id}/result`, { status: 'MAYBE' });
      should(res.status).equal(422);
    });
  });

  describe('version binding', () => {
    let run;
    let editableCase;

    before(async () => {
      editableCase = (await createCase('unit-testing-mr editable case')).body;
      const res = await createRun(memberAgent, {
        name: 'unit-testing-mr binding run',
        testCaseIds: [editableCase._id],
      });
      run = res.body;
    });

    it('does not shift the steps under the tester when the case is edited mid-run', async () => {
      const edited = await send(memberAgent, 'put', `manual-test-case/${editableCase._id}`, {
        steps: [
          { action: 'Open the page', expected: 'Page loads' },
          { action: 'Accept cookies', expected: 'Banner dismissed' },
          { action: 'Click submit', expected: 'Form submits' },
        ],
      });
      should(edited.status).equal(200);
      should(edited.body.version).equal(2);

      // The run is still on v1 and its expanded steps are the v1 steps.
      const res = await send(memberAgent, 'get', `manual-test-run/${run._id}?expand=true`);
      should(res.status).equal(200);
      should(res.body.testCases[0].versionNumber).equal(1);
      should(res.body.testCases[0].version.steps).have.length(2);
      const actions = res.body.testCases[0].version.steps.map((s) => s.action);
      should(actions).not.containEql('Accept cookies');
    });

    it('rebinds a NOT_RUN case onto the latest version', async () => {
      const res = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${editableCase._id}/rebind`);
      should(res.status).equal(200);
      should(res.body.testCases[0].versionNumber).equal(2);

      const expanded = await send(memberAgent, 'get', `manual-test-run/${run._id}?expand=true`);
      should(expanded.body.testCases[0].version.steps).have.length(3);
    });

    it('respond with 409 when rebinding a case that already has a result', async () => {
      await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${editableCase._id}/result`, { status: 'PASS' });
      const res = await send(memberAgent, 'put', `manual-test-run/${run._id}/test-case/${editableCase._id}/rebind`);
      should(res.status).equal(409);
      should(res.body.message).match(/already has a recorded result/);
    });

    it('records the execution against the version it was actually run on', async () => {
      const runDoc = await ManualTestRun.findById(run._id).lean();
      const runCase = runDoc.testCases[0];
      const execution = await TestExecution.findById(runCase.execution).lean();
      should(execution.versionNumber).equal(2);
      should(execution.manualTestCaseVersion.toString())
        .equal(runCase.testCaseVersion.toString());
    });
  });

  describe('GET /manual-test-run', () => {
    it('lists the team\'s runs', async () => {
      const res = await send(memberAgent, 'get', `manual-test-run?teamId=${team._id}`);
      should(res.status).equal(200);
      should(res.body.testRuns.length).be.above(0);
      should(res.body.metrics.totalTestRuns).be.above(0);
    });

    it('filters by status', async () => {
      const res = await send(memberAgent, 'get', `manual-test-run?teamId=${team._id}&status=COMPLETED`);
      should(res.status).equal(200);
      res.body.testRuns.forEach((run) => should(run.status).equal('COMPLETED'));
    });

    it('respond with 403 for a user outside the team', async () => {
      const res = await send(outsiderAgent, 'get', `manual-test-run?teamId=${team._id}`);
      should(res.status).equal(403);
    });
  });

  describe('PUT /manual-test-run/:runId', () => {
    it('adds a case to a run in flight, bound to its current version', async () => {
      const created = await createRun(memberAgent, {
        name: 'unit-testing-mr growing run',
        testCaseIds: [caseA._id],
      });
      const res = await send(memberAgent, 'put', `manual-test-run/${created.body._id}`, {
        testCaseIds: [caseB._id],
      });
      should(res.status).equal(200);
      should(res.body.testCases).have.length(2);
    });

    it('does not duplicate a case already in the run', async () => {
      const created = await createRun(memberAgent, { name: 'unit-testing-mr dedupe run' });
      const res = await send(memberAgent, 'put', `manual-test-run/${created.body._id}`, {
        testCaseIds: [caseA._id],
      });
      should(res.status).equal(200);
      should(res.body.testCases).have.length(1);
    });
  });

  describe('PUT /manual-test-run/:runId/status', () => {
    it('cancels a run and stamps the end date', async () => {
      const created = await createRun(memberAgent, { name: 'unit-testing-mr cancel run' });
      const res = await send(memberAgent, 'put', `manual-test-run/${created.body._id}/status`, {
        status: 'CANCELLED',
      });
      should(res.status).equal(200);
      should(res.body.status).equal('CANCELLED');
      should(res.body.end).not.equal(null);
    });

    it('refuses a result against a cancelled run', async () => {
      const created = await createRun(memberAgent, { name: 'unit-testing-mr cancelled result run' });
      await send(memberAgent, 'put', `manual-test-run/${created.body._id}/status`, { status: 'CANCELLED' });
      const res = await send(memberAgent, 'put', `manual-test-run/${created.body._id}/test-case/${caseA._id}/result`, { status: 'PASS' });
      should(res.status).equal(409);
    });
  });

  describe('DELETE /manual-test-run/:runId', () => {
    it('removes the run along with its build and executions', async () => {
      const created = await createRun(leadAgent, { name: 'unit-testing-mr doomed run' });
      await send(leadAgent, 'put', `manual-test-run/${created.body._id}/test-case/${caseA._id}/result`, { status: 'PASS' });

      const buildId = created.body.build;
      should(await TestExecution.countDocuments({ build: buildId })).equal(1);

      const res = await send(leadAgent, 'delete', `manual-test-run/${created.body._id}`);
      should(res.status).equal(200);

      // Leaving these would show dashboard results for a run that no longer exists.
      should(await Build.countDocuments({ _id: buildId })).equal(0);
      should(await TestExecution.countDocuments({ build: buildId })).equal(0);
    });

    it('respond with 403 when a plain member tries to delete', async () => {
      const created = await createRun(memberAgent, { name: 'unit-testing-mr undeletable run' });
      const res = await send(memberAgent, 'delete', `manual-test-run/${created.body._id}`);
      should(res.status).equal(403);
    });

    it('respond with 404 for an unknown id', async () => {
      const res = await send(leadAgent, 'delete', 'manual-test-run/5f7e2b9e8f1b2c0017a1b2c3');
      should(res.status).equal(404);
    });
  });

  describe('existing automated behaviour is unchanged', () => {
    it('defaults an automated build and execution to executionType automated', async () => {
      const build = await testUtils.createBuild(team, environment, 'unit-testing-mr automated build');
      const saved = await Build.findById(build._id).lean();
      should(saved.executionType).equal('automated');
      await Build.deleteOne({ _id: build._id }).exec();
    });
  });
});
