const pino = require('pino');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jimp = require('jimp');
const testUtils = require('./test-utils.js');
const Screenshot = require('../app/models/screenshot.js');
const { Team } = require('../app/models/team.js');
const Build = require('../app/models/build.js');
const Environment = require('../app/models/environment.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';
let build;
let screenshot;
let templateScreenshot;
let request;
let templateDir;

describe('Screenshot API Tests', () => {
  before((done) => {
    // clear lingering test screenshots
    const clearingPromises = [
      Screenshot.deleteMany({ view: /^unit-testing-view/ }).exec(),
      Build.deleteMany({ name: /^build-unit-testing/ }).exec(),
      Environment.deleteMany({ name: /^unit-testing-environment/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-team/ }).exec(),
    ];
    Promise.all(clearingPromises).then(() => {
      logger.info('Cleared any lingering test screenshots');
      const createPromises = [
        testUtils.createTeam('unit-testing-team-screenshot'),
        testUtils.createEnvironment('unit-testing-environment-screenshot'),
      ];
      Promise.all(createPromises)
        .then((result) => testUtils
          .createBuild(result[0], result[1], 'build-unit-testing-screenshot'))
        .then((createBuild) => {
          build = createBuild;
          return testUtils.getAdminAgent();
        })
        .then((agent) => {
          request = agent;
          done();
        })
        .catch((exception) => {
          logger(exception);
          done();
        });
    });
  });

  after(async () => {
    // .exec() (and awaiting it) matters: without it the query is never sent and the
    // screenshot is left behind as an orphan once its build is removed.
    if (screenshot) {
      await Screenshot.deleteOne({ _id: screenshot._id }).exec();
    }
    if (templateScreenshot) {
      await Screenshot.deleteOne({ _id: templateScreenshot._id }).exec();
    }
    if (templateDir) {
      fs.rmSync(templateDir, { recursive: true, force: true });
    }
    testUtils.cleanUp();
  });

  describe('POST /screenshot', () => {
    it('successfully create store a screenshot', (done) => {
      // logger('during');
      request
        .post(`${baseUrl}screenshot`)
        .set('Content-Type', 'multipart/form-data')
        .set('Accept', 'application/json')
        .field('buildId', build.id)
        .field('timestamp', (new Date()).toISOString())
        .field('view', 'unit-testing-view')
        .attach('screenshot', './test/resources/angles_home_page.jpg')
        .expect('Content-Type', /json/)
        .end((err, res) => {
          if (err) return done(err);
          logger.info(res.body);
          res.body._id.should.match(/[a-f\d]{24}/);
          screenshot = res.body;
          return done();
        });
    });
  });

  describe('find template in screenshot', () => {
    const CROP = {
      x: 600, y: 300, width: 400, height: 240,
    };
    let croppedTemplatePath;

    before(async function createTemplate() {
      this.timeout(60000);
      // Crop a region out of the uploaded fixture; the find endpoints have to locate it
      // back at the same position.
      templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'angles-find-template-'));
      croppedTemplatePath = path.join(templateDir, 'template.png');
      const image = await jimp.read('./test/resources/angles_home_page.jpg');
      await image.crop(CROP.x, CROP.y, CROP.width, CROP.height).writeAsync(croppedTemplatePath);
      // Store the crop as a screenshot so the id-based find endpoints can reference it.
      templateScreenshot = await new Promise((resolve, reject) => {
        request
          .post(`${baseUrl}screenshot`)
          .set('Content-Type', 'multipart/form-data')
          .field('buildId', build.id)
          .field('timestamp', (new Date()).toISOString())
          .field('view', 'unit-testing-view-template')
          .attach('screenshot', croppedTemplatePath)
          .expect(201)
          .end((err, res) => (err ? reject(err) : resolve(res.body)));
      });
    });

    it('finds a stored template screenshot at the cropped location', function test(done) {
      this.timeout(60000);
      request
        .get(`${baseUrl}screenshot/${screenshot._id}/find/${templateScreenshot._id}`)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.matches.length.should.be.aboveOrEqual(1);
          res.body.bestMatch.confidence.should.be.above(0.8);
          // The fixture is wider than the 2000px search cap, so coordinates have been
          // mapped back from the downscaled search space - allow for rounding.
          res.body.bestMatch.x.should.be.approximately(CROP.x, 8);
          res.body.bestMatch.y.should.be.approximately(CROP.y, 8);
          return done();
        });
    });

    it('finds an uploaded template file at the cropped location', function test(done) {
      this.timeout(60000);
      request
        .post(`${baseUrl}screenshot/${screenshot._id}/find?maxMatches=3`)
        .set('Content-Type', 'multipart/form-data')
        .attach('template', croppedTemplatePath)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.bestMatch.confidence.should.be.above(0.8);
          res.body.bestMatch.x.should.be.approximately(CROP.x, 8);
          res.body.bestMatch.y.should.be.approximately(CROP.y, 8);
          return done();
        });
    });

    it('returns the annotated image for a find request', function test(done) {
      this.timeout(60000);
      request
        .get(`${baseUrl}screenshot/${screenshot._id}/find/${templateScreenshot._id}/image`)
        .expect(200)
        .expect('Content-Type', /png/)
        .end((err) => done(err));
    });

    it('rejects a find request without a template file', function test(done) {
      this.timeout(60000);
      request
        .post(`${baseUrl}screenshot/${screenshot._id}/find`)
        .expect(400)
        .end((err) => done(err));
    });

    it('rejects invalid find options', function test(done) {
      this.timeout(60000);
      request
        .get(`${baseUrl}screenshot/${screenshot._id}/find/${templateScreenshot._id}?minConfidence=7`)
        .expect(422)
        .end((err) => done(err));
    });

    it('returns 404 for an unknown template screenshot', function test(done) {
      this.timeout(60000);
      request
        .get(`${baseUrl}screenshot/${screenshot._id}/find/5f463b8bf0dd7f6d6a1a3af4`)
        .expect(404)
        .end((err) => done(err));
    });
  });

  describe('compare screenshots', () => {
    it('letterboxes different dimensions instead of stretching', function test(done) {
      this.timeout(60000);
      request
        .get(`${baseUrl}screenshot/${screenshot._id}/compare/${templateScreenshot._id}`)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.isSameDimensions.should.be.false();
          // 2560x1334 fixture vs the 400x240 crop uploaded as the template screenshot.
          res.body.dimensionDifference.should.deepEqual({ width: 2160, height: 1094 });
          res.body.rawMisMatchPercentage.should.be.within(0, 100);
          return done();
        });
    });

    it('honours the threshold query parameter', function test(done) {
      this.timeout(60000);
      // threshold=1 is maximally lenient: no colour distance can exceed it.
      request
        .get(`${baseUrl}screenshot/${screenshot._id}/compare/${templateScreenshot._id}?threshold=1`)
        .expect(200)
        .end((err, res) => {
          if (err) return done(err);
          res.body.rawMisMatchPercentage.should.equal(0);
          return done();
        });
    });

    it('rejects an out-of-range threshold', function test(done) {
      this.timeout(60000);
      request
        .get(`${baseUrl}screenshot/${screenshot._id}/compare/${templateScreenshot._id}?threshold=2`)
        .expect(422)
        .end((err) => done(err));
    });

    it('returns a diff image for mismatched dimensions', function test(done) {
      this.timeout(60000);
      request
        .get(`${baseUrl}screenshot/${screenshot._id}/compare/${templateScreenshot._id}/image?useCache=false`)
        .expect(200)
        .expect('Content-Type', /png/)
        .end((err) => done(err));
    });
  });
});
