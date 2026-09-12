const request = require('supertest');
const should = require('should');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const User = require('../app/models/user.js');
const FeatureSettings = require('../app/models/feature-settings.js');
const featureSettingsService = require('../app/utils/feature-settings-service.js');
const featureConfig = require('../config/feature.config.js');
const testUtils = require('./test-utils.js');

const baseUrl = '/rest/api/v1.0/';

describe('Feature Settings API Tests', () => {
  let adminAgent;
  let userAgent;
  let regularUser;
  let team;

  before(async () => {
    await User.deleteMany({ username: /^feature-testing/ }).exec();
    const hash = await bcrypt.hash('feature-testing-Password1', 10);
    regularUser = await User.create({ username: 'feature-testing-user', password: hash, role: 'user' });
    // The test case listing requires a team, so the enabled-path assertions can check a
    // real 200 rather than a validation failure that would pass the guard either way.
    team = await testUtils.createTeam('feature-testing-team');

    adminAgent = await testUtils.getAdminAgent();
    userAgent = request.agent(app);
    await userAgent
      .post(`${baseUrl}auth/login`)
      .send({ username: 'feature-testing-user', password: 'feature-testing-Password1' });
  });

  // Every feature toggle is global in-memory state, so leaving one off would disable the
  // manual testing suites that run after this file. Reset the document and reload.
  afterEach(async () => {
    await FeatureSettings.deleteMany({}).exec();
    await featureSettingsService.loadFeatureSettings();
  });

  after(async () => {
    await User.findOneAndRemove({ _id: regularUser._id }).exec();
    testUtils.cleanUp();
    await FeatureSettings.deleteMany({}).exec();
    await featureSettingsService.loadFeatureSettings();
  });

  describe('GET /settings/features', () => {
    it('should default every feature to enabled', async () => {
      const res = await adminAgent.get(`${baseUrl}settings/features`).expect(200);
      res.body.should.have.property('manualTestingEnabled', true);
    });

    it('should not be readable by a non-admin', async () => {
      await userAgent.get(`${baseUrl}settings/features`).expect(403);
    });
  });

  describe('PUT /settings/features', () => {
    it('should persist a disabled feature', async () => {
      const res = await adminAgent
        .put(`${baseUrl}settings/features`)
        .send({ manualTestingEnabled: false })
        .expect(200);
      res.body.should.have.property('manualTestingEnabled', false);

      const reread = await adminAgent.get(`${baseUrl}settings/features`).expect(200);
      reread.body.should.have.property('manualTestingEnabled', false);
    });

    it('should reject a non-boolean value', async () => {
      await adminAgent
        .put(`${baseUrl}settings/features`)
        .send({ manualTestingEnabled: 'no' })
        .expect(422);
    });

    it('should not be writable by a non-admin', async () => {
      await userAgent
        .put(`${baseUrl}settings/features`)
        .send({ manualTestingEnabled: false })
        .expect(403);
    });
  });

  describe('Manual testing route guard', () => {
    const disableManualTesting = () => adminAgent
      .put(`${baseUrl}settings/features`)
      .send({ manualTestingEnabled: false })
      .expect(200);

    it('should allow the manual routes while the feature is enabled', async () => {
      await adminAgent.get(`${baseUrl}manual-test-case?teamId=${team._id}`).expect(200);
    });

    it('should 404 every manual route group once disabled', async () => {
      await disableManualTesting();
      // The guard runs before the validators, so a request that would otherwise be a 422
      // is still a 404 - the route does not exist rather than being malformed.
      await adminAgent.get(`${baseUrl}manual-test-case?teamId=${team._id}`).expect(404);
      await adminAgent.get(`${baseUrl}manual-test-case`).expect(404);
      await adminAgent.get(`${baseUrl}manual-test-run`).expect(404);
      await adminAgent.get(`${baseUrl}manual-folder`).expect(404);
      await adminAgent.get(`${baseUrl}shared-step`).expect(404);
    });

    it('should block writes as well as reads once disabled', async () => {
      await disableManualTesting();
      await adminAgent
        .post(`${baseUrl}manual-test-case`)
        .send({ title: 'should never be created' })
        .expect(404);
    });

    it('should leave unrelated routes untouched once disabled', async () => {
      await disableManualTesting();
      await adminAgent.get(`${baseUrl}team`).expect(200);
    });

    it('should restore access when re-enabled', async () => {
      await disableManualTesting();
      await adminAgent.get(`${baseUrl}manual-test-case?teamId=${team._id}`).expect(404);

      await adminAgent
        .put(`${baseUrl}settings/features`)
        .send({ manualTestingEnabled: true })
        .expect(200);
      await adminAgent.get(`${baseUrl}manual-test-case?teamId=${team._id}`).expect(200);
    });
  });

  describe('Environment seeding', () => {
    // config/feature.config.js reads the environment once at require time, so these set
    // the parsed seed directly rather than process.env - the effect under test is what
    // loadDoc does with a seed, not how the string was parsed.
    const setSeed = (value) => { featureConfig.seeds.manualTestingEnabled = value; };

    afterEach(() => {
      setSeed(true);
    });

    // The parsing itself: only the exact string 'false' disables a feature, so an unset,
    // empty or misspelled value can never accidentally turn one off.
    it('should only treat the string "false" as disabled', () => {
      const configPath = require.resolve('../config/feature.config.js');
      const original = process.env.ANGLES_MANUAL_TESTING_ENABLED;

      const seedFor = (value) => {
        if (value === undefined) {
          delete process.env.ANGLES_MANUAL_TESTING_ENABLED;
        } else {
          process.env.ANGLES_MANUAL_TESTING_ENABLED = value;
        }
        delete require.cache[configPath];
        // eslint-disable-next-line global-require
        return require('../config/feature.config.js').seeds.manualTestingEnabled;
      };

      try {
        seedFor('false').should.equal(false);
        seedFor('true').should.equal(true);
        seedFor(undefined).should.equal(true);
        seedFor('').should.equal(true);
        seedFor('FALSE').should.equal(true);
      } finally {
        if (original === undefined) {
          delete process.env.ANGLES_MANUAL_TESTING_ENABLED;
        } else {
          process.env.ANGLES_MANUAL_TESTING_ENABLED = original;
        }
        // Restore the cached module every other test (and the running app) holds a
        // reference to, so re-requiring here does not leave a second copy behind.
        delete require.cache[configPath];
      }
    });

    it('should create the settings from the seed on first run', async () => {
      await FeatureSettings.deleteMany({}).exec();
      setSeed(false);

      await featureSettingsService.loadFeatureSettings();

      const res = await adminAgent.get(`${baseUrl}settings/features`).expect(200);
      res.body.should.have.property('manualTestingEnabled', false);
    });

    it('should default to enabled when the seed is not set', async () => {
      await FeatureSettings.deleteMany({}).exec();
      setSeed(true);

      await featureSettingsService.loadFeatureSettings();

      const res = await adminAgent.get(`${baseUrl}settings/features`).expect(200);
      res.body.should.have.property('manualTestingEnabled', true);
    });

    // The whole point of seed-only semantics: a restart must never revert an admin.
    it('should not override a stored value the admin has already set', async () => {
      await FeatureSettings.deleteMany({}).exec();
      setSeed(false);
      await featureSettingsService.loadFeatureSettings();

      // The admin turns it back on through the UI.
      await adminAgent
        .put(`${baseUrl}settings/features`)
        .send({ manualTestingEnabled: true })
        .expect(200);

      // Restarting with the seed still set to false must leave their choice alone.
      await featureSettingsService.loadFeatureSettings();

      const res = await adminAgent.get(`${baseUrl}settings/features`).expect(200);
      res.body.should.have.property('manualTestingEnabled', true);
      featureConfig.manualTestingEnabled.should.equal(true);
    });
  });

  describe('GET /auth/config', () => {
    it('should report the feature toggles so any client can gate its navigation', async () => {
      const res = await request(app).get(`${baseUrl}auth/config`).expect(200);
      res.body.should.have.property('features');
      res.body.features.should.have.property('manualTestingEnabled', true);
    });

    it('should report a disabled feature without needing a restart', async () => {
      await adminAgent
        .put(`${baseUrl}settings/features`)
        .send({ manualTestingEnabled: false })
        .expect(200);

      const res = await request(app).get(`${baseUrl}auth/config`).expect(200);
      res.body.features.should.have.property('manualTestingEnabled', false);
    });
  });
});
