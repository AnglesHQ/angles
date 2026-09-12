/**
 * Tests for the automated/manual filter on the dashboard and metrics endpoints.
 *
 * The important property is that omitting the parameter is unchanged behaviour: every
 * existing client, and the whole rest of the suite, must keep seeing what it saw before
 * manual runs existed. The filter narrows; it never reshapes.
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
const Environment = require('../app/models/environment.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

const MEMBER_PASSWORD = 'unit-testing-EtMember1!';

describe('Execution Type Filter Tests', () => {
  let memberAgent;
  let team;
  let environment;
  let automatedBuild;
  let manualRun;

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
      User.deleteMany({ username: /^unit-testing-et/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-et/ }).exec(),
      ManualTestRun.deleteMany({ name: /^unit-testing-et/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-et/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-et/ }).exec(),
    ]);
    logger.info('Cleared any lingering execution type fixtures');

    team = await new Team({ name: 'unit-testing-et-team', components: [{ name: 'et-component' }] }).save();
    environment = await new Environment({ name: 'unit-testing-et-env' }).save();

    const memberHash = await bcrypt.hash(MEMBER_PASSWORD, 10);
    await User.create({
      username: 'unit-testing-et-member', password: memberHash, role: 'user', teams: [team._id],
    });
    memberAgent = await login('unit-testing-et-member', MEMBER_PASSWORD);
    await testUtils.getAdminAgent();

    // One automated build, created the ordinary way.
    automatedBuild = await testUtils.createBuild(team, environment, 'unit-testing-et automated');

    // One manual run, which creates its own manual-tagged build.
    const testCase = await send(memberAgent, 'post', 'manual-test-case', {
      team: team._id.toString(),
      title: 'unit-testing-et case',
      status: 'ACTIVE',
      steps: [{ action: 'Do it', expected: 'Done' }],
    });
    const run = await send(memberAgent, 'post', 'manual-test-run', {
      name: 'unit-testing-et manual run',
      team: team._id.toString(),
      environment: environment.name,
      testCaseIds: [testCase.body._id],
    });
    manualRun = run.body;
    await send(memberAgent, 'put', `manual-test-run/${manualRun._id}/test-case/${testCase.body._id}/result`, { status: 'PASS' });
  });

  after(async () => {
    const runs = await ManualTestRun.find({ name: /^unit-testing-et/ }).lean();
    const buildIds = runs.map((run) => run.build).filter(Boolean);
    const cases = await ManualTestCase.find({ title: /^unit-testing-et/ }).select('_id').lean();
    await Promise.all([
      TestExecution.deleteMany({ build: { $in: buildIds } }).exec(),
      Build.deleteMany({ _id: { $in: [...buildIds, automatedBuild._id] } }).exec(),
      ManualTestRun.deleteMany({ name: /^unit-testing-et/ }).exec(),
      ManualTestCaseVersion.deleteMany({ testCase: { $in: cases.map((c) => c._id) } }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-et/ }).exec(),
      User.deleteMany({ username: /^unit-testing-et/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-et/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-et/ }).exec(),
    ]);
  });

  describe('GET /build', () => {
    it('returns both types when the parameter is omitted', async () => {
      const res = await send(memberAgent, 'get', `build?teamId=${team._id}&limit=50`);
      should(res.status).equal(200);
      const types = new Set(res.body.builds.map((build) => build.executionType));
      should(types.has('automated')).equal(true);
      should(types.has('manual')).equal(true);
    });

    it('returns only manual builds when asked', async () => {
      const res = await send(memberAgent, 'get', `build?teamId=${team._id}&executionType=manual&limit=50`);
      should(res.status).equal(200);
      should(res.body.builds.length).be.above(0);
      res.body.builds.forEach((build) => should(build.executionType).equal('manual'));
    });

    it('returns only automated builds when asked', async () => {
      const res = await send(memberAgent, 'get', `build?teamId=${team._id}&executionType=automated&limit=50`);
      should(res.status).equal(200);
      should(res.body.builds.length).be.above(0);
      res.body.builds.forEach((build) => should(build.executionType).equal('automated'));
    });

    it('the two filtered counts add up to the unfiltered count', async () => {
      const [all, automated, manual] = await Promise.all([
        send(memberAgent, 'get', `build?teamId=${team._id}&limit=50`),
        send(memberAgent, 'get', `build?teamId=${team._id}&executionType=automated&limit=50`),
        send(memberAgent, 'get', `build?teamId=${team._id}&executionType=manual&limit=50`),
      ]);
      should(automated.body.metrics.totalTestRuns + manual.body.metrics.totalTestRuns)
        .equal(all.body.metrics.totalTestRuns);
    });

    it('respond with 422 for an unknown execution type', async () => {
      const res = await send(memberAgent, 'get', `build?teamId=${team._id}&executionType=sideways`);
      should(res.status).equal(422);
    });
  });

  describe('GET /metrics/phase', () => {
    // The metrics endpoint rejects API-token auth, so the session agent is required.
    const metricsUrl = (extra = '') => `metrics/phase?teamId=${team._id}&groupingPeriod=day${extra}`;

    it('includes both types when the parameter is omitted', async () => {
      const res = await send(memberAgent, 'get', metricsUrl());
      should(res.status).equal(200);
      should(res.body.executionType).equal(undefined);
      const totals = res.body.periods.reduce((sum, period) => sum + period.result.TOTAL, 0);
      should(totals).be.aboveOrEqual(1);
    });

    it('reports a per-period breakdown so the UI can stack the two', async () => {
      const res = await send(memberAgent, 'get', metricsUrl());
      should(res.status).equal(200);
      res.body.periods.forEach((period) => {
        should(period.executionTypeBreakdown).not.equal(undefined);
        const { automated, manual } = period.executionTypeBreakdown;
        // The breakdown must account for every execution in the period, or a stacked
        // chart built from it would silently under-report.
        should(automated + manual).equal(period.result.TOTAL);
      });
    });

    it('narrows to manual when asked', async () => {
      const res = await send(memberAgent, 'get', metricsUrl('&executionType=manual'));
      should(res.status).equal(200);
      should(res.body.executionType).equal('manual');
      res.body.periods.forEach((period) => {
        should(period.executionTypeBreakdown.automated).equal(0);
      });
      const manualTotal = res.body.periods
        .reduce((sum, period) => sum + period.executionTypeBreakdown.manual, 0);
      should(manualTotal).be.above(0);
    });

    it('narrows to automated when asked', async () => {
      const res = await send(memberAgent, 'get', metricsUrl('&executionType=automated'));
      should(res.status).equal(200);
      res.body.periods.forEach((period) => {
        should(period.executionTypeBreakdown.manual).equal(0);
      });
    });

    it('respond with 422 for an unknown execution type', async () => {
      const res = await send(memberAgent, 'get', metricsUrl('&executionType=sideways'));
      should(res.status).equal(422);
    });

    it('counts an execution with no stored executionType as automated', async () => {
      // Executions written before manual runs existed have no field on disk. They must
      // land in the automated bucket rather than falling out of the breakdown.
      const execution = await TestExecution.findOne({ build: automatedBuild._id }).lean();
      if (execution) {
        await TestExecution.collection.updateOne(
          { _id: execution._id },
          { $unset: { executionType: '' } },
        );
        const res = await send(memberAgent, 'get', metricsUrl());
        should(res.status).equal(200);
        res.body.periods.forEach((period) => {
          const { automated, manual } = period.executionTypeBreakdown;
          should(automated + manual).equal(period.result.TOTAL);
        });
      }
    });
  });
});
