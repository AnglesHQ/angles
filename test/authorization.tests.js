/**
 * Regression tests for the authorization and input-handling fixes.
 *
 * These cover defects that shipped undetected because nothing exercised them:
 *  - the delete endpoints referenced an undefined `authMiddleware`, so instead of denying
 *    access they threw a ReferenceError (surfacing as a 500, never a 403);
 *  - screenshot and execution reads were not scoped to the caller's team, so any
 *    authenticated user could read - and enumerate - other teams' data;
 *  - the screenshot upload built its path from unsanitised user input;
 *  - view/tag lookups interpolated raw input into a MongoDB $regex;
 *  - deleting a build did not cascade, and did not protect baseline screenshots.
 *
 * The assertions deliberately check for the specific status code rather than "not 200":
 * a 500 from a ReferenceError would otherwise pass a laxer test.
 */
const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const User = require('../app/models/user.js');
const Build = require('../app/models/build.js');
const Screenshot = require('../app/models/screenshot.js');
const Execution = require('../app/models/execution.js');
const Baseline = require('../app/models/baseline.js');
const { Team } = require('../app/models/team.js');
const Environment = require('../app/models/environment.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

const OWNER_PASSWORD = 'unit-testing-AuthzOwner1!';
const OTHER_PASSWORD = 'unit-testing-AuthzOther1!';
const LEAD_PASSWORD = 'unit-testing-AuthzLead1!';

describe('Authorization Regression Tests', () => {
  let ownerAgent; // a plain user in the team that owns the fixtures
  let otherAgent; // a plain user in a different team
  let leadAgent; // a team_lead in the owning team (may delete)
  let ownerTeam;
  let otherTeam;
  let build;
  let screenshot;
  let execution;
  let screenshotDirectory;

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

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-authz/ }).exec(),
      Screenshot.deleteMany({ view: /^unit-testing-authz/ }).exec(),
      Build.deleteMany({ name: /^unit-testing-authz/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-authz/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-authz/ }).exec(),
    ]);

    ownerTeam = await testUtils.createTeam('unit-testing-authz-owner', 'authz-component');
    otherTeam = await testUtils.createTeam('unit-testing-authz-other', 'authz-component');
    const environment = await testUtils.createEnvironment('unit-testing-authz-env');
    build = await testUtils.createBuild(ownerTeam, environment, 'unit-testing-authz-build');

    // A real file on disk so the image endpoints exercise the access check rather than
    // failing earlier on a missing file.
    screenshotDirectory = path.resolve(__dirname, '..', 'screenshots', build._id.toString());
    fs.mkdirSync(screenshotDirectory, { recursive: true });
    const imagePath = path.join(screenshotDirectory, 'unit-testing-authz.jpg');
    fs.copyFileSync(path.resolve(__dirname, 'resources', 'angles_home_page.jpg'), imagePath);

    screenshot = await new Screenshot({
      build: build._id,
      thumbnail: 'data:image/jpeg;base64,unit-testing',
      timestamp: new Date(),
      path: imagePath,
      view: 'unit-testing-authz-view',
      height: 100,
      width: 100,
      platform: { platformName: 'unit-testing-os', browserName: 'unit-testing-browser' },
    }).save();

    execution = await new Execution({
      title: 'unit-testing-authz-execution',
      suite: 'unit-testing-authz-suite',
      build: build._id,
      status: 'PASS',
      start: new Date(),
    }).save();

    const [ownerHash, otherHash, leadHash] = await Promise.all([
      bcrypt.hash(OWNER_PASSWORD, 10),
      bcrypt.hash(OTHER_PASSWORD, 10),
      bcrypt.hash(LEAD_PASSWORD, 10),
    ]);

    await Promise.all([
      new User({
        username: 'unit-testing-authz-owner', password: ownerHash, role: 'user', teams: [ownerTeam._id],
      }).save(),
      new User({
        username: 'unit-testing-authz-other', password: otherHash, role: 'user', teams: [otherTeam._id],
      }).save(),
      new User({
        username: 'unit-testing-authz-lead', password: leadHash, role: 'team_lead', teams: [ownerTeam._id],
      }).save(),
    ]);

    [ownerAgent, otherAgent, leadAgent] = await Promise.all([
      login('unit-testing-authz-owner', OWNER_PASSWORD),
      login('unit-testing-authz-other', OTHER_PASSWORD),
      login('unit-testing-authz-lead', LEAD_PASSWORD),
    ]);
    logger.info('Authorization test fixtures ready');
  });

  after(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-authz/ }).exec(),
      Screenshot.deleteMany({ view: /^unit-testing-authz/ }).exec(),
      Execution.deleteMany({ title: /^unit-testing-authz/ }).exec(),
      Baseline.deleteMany({ view: /^unit-testing-authz/ }).exec(),
      Build.deleteMany({ name: /^unit-testing-authz/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-authz/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-authz/ }).exec(),
    ]);
    if (screenshotDirectory && fs.existsSync(screenshotDirectory)) {
      fs.rmSync(screenshotDirectory, { recursive: true, force: true });
    }
    testUtils.cleanUp();
  });

  describe('screenshot reads are scoped to the caller\'s team', () => {
    it('lets a user in the owning team read the screenshot', (done) => {
      ownerAgent
        .get(`${baseUrl}screenshot/${screenshot._id}`)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body._id.should.equal(screenshot._id.toString());
          return done();
        });
    });

    it('denies a user from another team with 403', (done) => {
      otherAgent
        .get(`${baseUrl}screenshot/${screenshot._id}`)
        .expect(403, done);
    });

    it('denies the image endpoint for another team with 403', (done) => {
      otherAgent
        .get(`${baseUrl}screenshot/${screenshot._id}/image`)
        .expect(403, done);
    });

    it('denies comparing another team\'s screenshots with 403', (done) => {
      otherAgent
        .get(`${baseUrl}screenshot/${screenshot._id}/compare/${screenshot._id}`)
        .expect(403, done);
    });

    it('denies updating another team\'s screenshot with 403', (done) => {
      otherAgent
        .put(`${baseUrl}screenshot/${screenshot._id}`)
        .send({ tags: ['unit-testing-authz-tag'] })
        .expect(403, done);
    });

    it('does not leak other teams\' screenshots in an unfiltered listing', (done) => {
      otherAgent
        .get(`${baseUrl}screenshot`)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          const ids = (res.body || []).map((item) => item._id);
          ids.should.not.containEql(screenshot._id.toString());
          return done();
        });
    });
  });

  describe('execution reads are scoped to the caller\'s team', () => {
    it('lets a user in the owning team read the execution', (done) => {
      ownerAgent
        .get(`${baseUrl}execution/${execution._id}`)
        .expect(200, done);
    });

    it('denies a user from another team with 403', (done) => {
      otherAgent
        .get(`${baseUrl}execution/${execution._id}`)
        .expect(403, done);
    });

    it('denies execution history for another team with 403', (done) => {
      otherAgent
        .get(`${baseUrl}execution/${execution._id}/history`)
        .expect(403, done);
    });

    it('does not leak other teams\' executions when queried by id', (done) => {
      otherAgent
        .get(`${baseUrl}execution`)
        .query({ executionIds: execution._id.toString() })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          (res.body || []).length.should.equal(0);
          return done();
        });
    });
  });

  describe('delete endpoints deny rather than error', () => {
    // These previously threw a ReferenceError on every call because `authMiddleware` was
    // never imported, so asserting specifically on 403 (not merely "not 200") matters.
    it('returns 403, not 500, when deleting another team\'s screenshot', (done) => {
      otherAgent
        .delete(`${baseUrl}screenshot/${screenshot._id}`)
        .expect(403, done);
    });

    it('returns 403, not 500, when deleting another team\'s execution', (done) => {
      otherAgent
        .delete(`${baseUrl}execution/${execution._id}`)
        .expect(403, done);
    });

    it('returns 403 when a plain user (not a team lead) deletes their own team\'s screenshot', (done) => {
      ownerAgent
        .delete(`${baseUrl}screenshot/${screenshot._id}`)
        .expect(403, done);
    });

    it('leaves the screenshot in place after the denied deletes', async () => {
      const stillThere = await Screenshot.countDocuments({ _id: screenshot._id });
      stillThere.should.equal(1);
    });

    it('returns 403, not 500, when deleting another team\'s baseline', (done) => {
      // A baseline the "other" team has no access to; the id need only be well-formed for
      // the authorization check to be the thing under test.
      Baseline.create({
        screenshot: screenshot._id,
        view: 'unit-testing-authz-view',
        platform: { platformName: 'unit-testing-os', browserName: 'unit-testing-browser' },
        screenHeight: 100,
        screenWidth: 100,
        ignoreBoxes: [],
      }).then((baseline) => {
        otherAgent
          .delete(`${baseUrl}baseline/${baseline._id}`)
          .expect(403, () => Baseline.deleteOne({ _id: baseline._id }).exec().then(() => done()));
      }).catch(done);
    });
  });

  describe('build deletion cascades and protects baselines', () => {
    it('refuses with 409 when a screenshot in the build backs a baseline', async () => {
      const baseline = await Baseline.create({
        screenshot: screenshot._id,
        view: 'unit-testing-authz-view',
        platform: { platformName: 'unit-testing-os', browserName: 'unit-testing-browser' },
        screenHeight: 100,
        screenWidth: 100,
        ignoreBoxes: [],
      });

      await leadAgent.delete(`${baseUrl}build/${build._id}`).expect(409);

      // nothing may have been removed
      (await Build.countDocuments({ _id: build._id })).should.equal(1);
      (await Screenshot.countDocuments({ _id: screenshot._id })).should.equal(1);
      await Baseline.deleteOne({ _id: baseline._id }).exec();
    });

    it('cascades screenshots and executions when no baseline is involved', async () => {
      const environment = await Environment.findOne({ name: /^unit-testing-authz/ });
      const cascadeBuild = await testUtils
        .createBuild(ownerTeam, environment, 'unit-testing-authz-cascade');
      const directory = path.resolve(__dirname, '..', 'screenshots', cascadeBuild._id.toString());
      fs.mkdirSync(directory, { recursive: true });
      const imagePath = path.join(directory, 'unit-testing-authz-cascade.jpg');
      fs.copyFileSync(path.resolve(__dirname, 'resources', 'angles_home_page.jpg'), imagePath);

      const cascadeScreenshot = await new Screenshot({
        build: cascadeBuild._id,
        thumbnail: 'data:image/jpeg;base64,unit-testing',
        timestamp: new Date(),
        path: imagePath,
        view: 'unit-testing-authz-cascade-view',
        height: 100,
        width: 100,
        platform: { platformName: 'unit-testing-os', browserName: 'unit-testing-browser' },
      }).save();
      const cascadeExecution = await new Execution({
        title: 'unit-testing-authz-cascade-execution',
        suite: 'unit-testing-authz-suite',
        build: cascadeBuild._id,
        status: 'PASS',
        start: new Date(),
      }).save();

      await leadAgent.delete(`${baseUrl}build/${cascadeBuild._id}`).expect(200);

      (await Build.countDocuments({ _id: cascadeBuild._id })).should.equal(0);
      (await Screenshot.countDocuments({ _id: cascadeScreenshot._id })).should.equal(0);
      (await Execution.countDocuments({ _id: cascadeExecution._id })).should.equal(0);
      fs.existsSync(directory).should.equal(false);
    });
  });

  describe('screenshot upload rejects path traversal', () => {
    it('rejects a traversing buildId instead of writing outside the screenshot root', (done) => {
      const escaped = path.resolve(__dirname, '..', '..', 'unit-testing-authz-escape');
      ownerAgent
        .post(`${baseUrl}screenshot`)
        .set('Content-Type', 'multipart/form-data')
        .field('buildId', '../../../../unit-testing-authz-escape')
        .field('timestamp', (new Date()).toISOString())
        .attach('screenshot', './test/resources/angles_home_page.jpg')
        .end((err, res) => {
          if (err) return done(err);
          // rejected cleanly by the upload's error handler, not a 500 stack trace
          res.status.should.equal(400);
          fs.existsSync(escaped).should.equal(false);
          return done();
        });
    });

    it('discards the client filename so a traversing name cannot escape', (done) => {
      ownerAgent
        .post(`${baseUrl}screenshot`)
        .set('Content-Type', 'multipart/form-data')
        .field('buildId', build._id.toString())
        .field('timestamp', (new Date()).toISOString())
        .field('view', 'unit-testing-authz-view-upload')
        .attach('screenshot', './test/resources/angles_home_page.jpg', '../../../unit-testing-authz-evil.jpg')
        .expect(201)
        .end((err, res) => {
          if (err) return done(err);
          // stored name must be generated, never the supplied one
          res.body.path.should.not.containEql('..');
          res.body.path.should.not.containEql('unit-testing-authz-evil');
          path.resolve(res.body.path).startsWith(path.resolve(__dirname, '..', 'screenshots')).should.equal(true);
          return Screenshot.deleteOne({ _id: res.body._id }).exec().then(() => done());
        });
    });
  });

  describe('regex metacharacters are escaped in lookups', () => {
    it('treats a catastrophic-backtracking payload as a literal, without hanging', (done) => {
      const start = Date.now();
      ownerAgent
        .get(`${baseUrl}screenshot/views`)
        .query({ view: '(a+)+$' })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          // escaped, so it matches nothing rather than being evaluated as a pattern
          (res.body || []).length.should.equal(0);
          (Date.now() - start).should.be.below(2000);
          return done();
        });
    });

    it('does not let a wildcard widen a view prefix search', (done) => {
      // ".*view" would match the fixture's view if it were evaluated as a pattern; escaped,
      // it is a literal prefix that matches nothing. (Must be >= 3 chars to pass the
      // route's own length validation and actually reach the query.)
      ownerAgent
        .get(`${baseUrl}screenshot/views`)
        .query({ view: '.*unit-testing-authz' })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          (res.body || []).should.not.containEql('unit-testing-authz-view');
          return done();
        });
    });
  });
});
