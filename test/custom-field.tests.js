/**
 * Tests for admin-configurable custom fields and their enforcement on manual test cases.
 *
 * The interesting behaviour is at the boundaries: unknown keys are rejected rather than
 * dropped, required fields are enforced only once a case leaves DRAFT, and a field that
 * has been used anywhere is archived rather than deleted so historical values stay
 * renderable.
 */
const request = require('supertest');
const should = require('should');
const pino = require('pino');
const bcrypt = require('bcryptjs');
const app = require('../server.js');
const testUtils = require('./test-utils.js');
const User = require('../app/models/user.js');
const CustomFieldDefinition = require('../app/models/custom-field-definition.js');
const ManualTestCase = require('../app/models/manual-test-case.js');
const ManualTestCaseVersion = require('../app/models/manual-test-case-version.js');
const { Team } = require('../app/models/team.js');

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const baseUrl = '/rest/api/v1.0/';

const MEMBER_PASSWORD = 'unit-testing-CfMember1!';

describe('Custom Field API Tests', () => {
  let adminAgent;
  let memberAgent;
  let team;
  let memberUser;
  let textField;
  let selectField;

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

  const createCase = (agent, body) => new Promise((resolve, reject) => {
    agent
      .post(`${baseUrl}manual-test-case`)
      .send({ team: team._id.toString(), title: 'unit-testing-cf case', ...body })
      .set('Accept', 'application/json')
      .end((err, res) => (err ? reject(err) : resolve(res)));
  });

  before(async () => {
    await Promise.all([
      User.deleteMany({ username: /^unit-testing-cf/ }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-cf/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-cf/ }).exec(),
    ]);
    logger.info('Cleared any lingering custom field fixtures');

    team = await new Team({
      name: 'unit-testing-cf-team',
      components: [{ name: 'cf-component' }],
    }).save();
    await CustomFieldDefinition.deleteMany({ team: team._id }).exec();

    const memberHash = await bcrypt.hash(MEMBER_PASSWORD, 10);
    memberUser = await User.create({
      username: 'unit-testing-cf-member', password: memberHash, role: 'user', teams: [team._id],
    });

    [adminAgent, memberAgent] = await Promise.all([
      testUtils.getAdminAgent(),
      login('unit-testing-cf-member', MEMBER_PASSWORD),
    ]);
  });

  after(async () => {
    const cases = await ManualTestCase.find({ title: /^unit-testing-cf/ }).select('_id').lean();
    await Promise.all([
      ManualTestCaseVersion.deleteMany({ testCase: { $in: cases.map((c) => c._id) } }).exec(),
      ManualTestCase.deleteMany({ title: /^unit-testing-cf/ }).exec(),
      CustomFieldDefinition.deleteMany({ team: team._id }).exec(),
      User.deleteMany({ username: /^unit-testing-cf/ }).exec(),
      Team.deleteMany({ name: /^unit-testing-cf/ }).exec(),
    ]);
  });

  describe('POST /custom-field', () => {
    it('respond with 201 when an admin creates a text field', (done) => {
      adminAgent
        .post(`${baseUrl}custom-field`)
        .send({
          team: team._id.toString(),
          key: 'test_reference',
          label: 'Test Reference',
          type: 'text',
          order: 1,
        })
        .set('Accept', 'application/json')
        .expect(201)
        .end((err, res) => {
          if (err) throw err;
          textField = res.body;
          should(res.body.key).equal('test_reference');
          should(res.body.archived).equal(false);
          done();
        });
    });

    it('respond with 201 when creating a select field with options', (done) => {
      adminAgent
        .post(`${baseUrl}custom-field`)
        .send({
          team: team._id.toString(),
          key: 'test_layer',
          label: 'Test Layer',
          type: 'select',
          options: ['unit', 'integration', 'e2e'],
          order: 2,
        })
        .set('Accept', 'application/json')
        .expect(201)
        .end((err, res) => {
          if (err) throw err;
          selectField = res.body;
          should(res.body.options).have.length(3);
          done();
        });
    });

    it('respond with 403 when a non-admin tries to create a field', (done) => {
      memberAgent
        .post(`${baseUrl}custom-field`)
        .send({
          team: team._id.toString(), key: 'sneaky', label: 'Sneaky', type: 'text',
        })
        .set('Accept', 'application/json')
        .expect(403, done);
    });

    it('respond with 422 for a key that is not a valid storage key', (done) => {
      adminAgent
        .post(`${baseUrl}custom-field`)
        .send({
          team: team._id.toString(), key: 'Not A Key', label: 'Bad', type: 'text',
        })
        .set('Accept', 'application/json')
        .expect(422, done);
    });

    it('respond with 400 when a select field has no options', (done) => {
      adminAgent
        .post(`${baseUrl}custom-field`)
        .send({
          team: team._id.toString(), key: 'no_options', label: 'No Options', type: 'select',
        })
        .set('Accept', 'application/json')
        .expect(400, done);
    });

    it('respond with 400 when a text field is given options', (done) => {
      adminAgent
        .post(`${baseUrl}custom-field`)
        .send({
          team: team._id.toString(),
          key: 'text_with_options',
          label: 'Text',
          type: 'text',
          options: ['a'],
        })
        .set('Accept', 'application/json')
        .expect(400, done);
    });

    it('respond with 409 for a duplicate key within the team', (done) => {
      adminAgent
        .post(`${baseUrl}custom-field`)
        .send({
          team: team._id.toString(), key: 'test_reference', label: 'Duplicate', type: 'text',
        })
        .set('Accept', 'application/json')
        .expect(409, done);
    });
  });

  describe('GET /custom-field', () => {
    it('returns the team\'s fields in order for a plain team member', (done) => {
      memberAgent
        .get(`${baseUrl}custom-field?teamId=${team._id}`)
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.customFields.length).be.aboveOrEqual(2);
          should(res.body.customFields[0].order).be.belowOrEqual(res.body.customFields[1].order);
          done();
        });
    });

    it('respond with 422 when teamId is missing', (done) => {
      memberAgent
        .get(`${baseUrl}custom-field`)
        .set('Accept', 'application/json')
        .expect(422, done);
    });
  });

  describe('custom field values on a manual test case', () => {
    it('stores a valid value', async () => {
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf case with fields',
        customFields: { test_reference: 'JIRA-123', test_layer: 'e2e' },
      });
      should(res.status).equal(201);
      should(res.body.customFields.test_reference).equal('JIRA-123');
      should(res.body.customFields.test_layer).equal('e2e');
    });

    it('rejects an unknown field key rather than dropping it', async () => {
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf case unknown key',
        customFields: { not_a_field: 'x' },
      });
      should(res.status).equal(400);
      should(res.body.message).match(/not a configured custom field/);
    });

    it('rejects a select value that is not one of the options', async () => {
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf case bad option',
        customFields: { test_layer: 'smoke' },
      });
      should(res.status).equal(400);
      should(res.body.message).match(/must be one of/);
    });

    it('reports every invalid field at once', async () => {
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf case many errors',
        customFields: { test_layer: 'smoke', nope: 1, also_nope: 2 },
      });
      should(res.status).equal(400);
      should(res.body.message).match(/nope/);
      should(res.body.message).match(/also_nope/);
      should(res.body.message).match(/must be one of/);
    });

    it('coerces a numeric string to a number', async () => {
      await new Promise((resolve, reject) => {
        adminAgent
          .post(`${baseUrl}custom-field`)
          .send({
            team: team._id.toString(), key: 'estimated_minutes', label: 'Estimated Minutes', type: 'number',
          })
          .expect(201)
          .end((err) => (err ? reject(err) : resolve()));
      });
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf case number coercion',
        customFields: { estimated_minutes: '45' },
      });
      should(res.status).equal(201);
      should(res.body.customFields.estimated_minutes).equal(45);
    });

    it('rejects a non-numeric value for a number field', async () => {
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf case bad number',
        customFields: { estimated_minutes: 'about an hour' },
      });
      should(res.status).equal(400);
      should(res.body.message).match(/must be a number/);
    });

    it('validates that a user-typed field refers to a real user', async () => {
      await new Promise((resolve, reject) => {
        adminAgent
          .post(`${baseUrl}custom-field`)
          .send({
            team: team._id.toString(), key: 'reviewer', label: 'Reviewer', type: 'user',
          })
          .expect(201)
          .end((err) => (err ? reject(err) : resolve()));
      });
      const good = await createCase(memberAgent, {
        title: 'unit-testing-cf case good reviewer',
        customFields: { reviewer: memberUser._id.toString() },
      });
      should(good.status).equal(201);

      const bad = await createCase(memberAgent, {
        title: 'unit-testing-cf case bad reviewer',
        customFields: { reviewer: '5f7e2b9e8f1b2c0017a1b2c3' },
      });
      should(bad.status).equal(400);
      should(bad.body.message).match(/does not exist/);
    });
  });

  describe('required custom fields', () => {
    let requiredField;

    before(async () => {
      const res = await new Promise((resolve, reject) => {
        adminAgent
          .post(`${baseUrl}custom-field`)
          .send({
            team: team._id.toString(),
            key: 'sign_off',
            label: 'Sign Off',
            type: 'text',
            required: true,
          })
          .end((err, response) => (err ? reject(err) : resolve(response)));
      });
      requiredField = res.body;
    });

    after(async () => {
      await CustomFieldDefinition.findByIdAndRemove(requiredField._id).exec();
    });

    it('allows a DRAFT to be saved without the required field', async () => {
      const res = await createCase(memberAgent, { title: 'unit-testing-cf draft without required' });
      should(res.status).equal(201);
      should(res.body.status).equal('DRAFT');
    });

    it('rejects creating an ACTIVE case without the required field', async () => {
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf active without required',
        status: 'ACTIVE',
      });
      should(res.status).equal(400);
      should(res.body.message).match(/Sign Off.*required/);
    });

    it('rejects publishing a draft that is missing the required field', async () => {
      const created = await createCase(memberAgent, { title: 'unit-testing-cf publish me' });
      should(created.status).equal(201);

      await new Promise((resolve, reject) => {
        memberAgent
          .put(`${baseUrl}manual-test-case/${created.body._id}`)
          .send({ status: 'ACTIVE' })
          .expect(400)
          .end((err, res) => {
            if (err) return reject(err);
            should(res.body.message).match(/Sign Off.*required/);
            return resolve();
          });
      });
    });

    it('allows publishing once the required field is supplied', async () => {
      const created = await createCase(memberAgent, { title: 'unit-testing-cf publish me too' });
      should(created.status).equal(201);

      await new Promise((resolve, reject) => {
        memberAgent
          .put(`${baseUrl}manual-test-case/${created.body._id}`)
          .send({ status: 'ACTIVE', customFields: { sign_off: 'approved by QA lead' } })
          .expect(200)
          .end((err) => (err ? reject(err) : resolve()));
      });
    });
  });

  describe('version snapshots', () => {
    it('records the field definitions in force when the version was written', async () => {
      const created = await createCase(memberAgent, {
        title: 'unit-testing-cf snapshot case',
        customFields: { test_reference: 'JIRA-999', test_layer: 'unit' },
      });
      should(created.status).equal(201);

      const version = await ManualTestCaseVersion
        .findOne({ testCase: created.body._id, version: 1 })
        .lean();
      const keys = version.fieldDefinitions.map((definition) => definition.key);
      should(keys).containEql('test_reference');
      should(keys).containEql('test_layer');
      const layer = version.fieldDefinitions.find((d) => d.key === 'test_layer');
      should(layer.label).equal('Test Layer');
      should(layer.options).have.length(3);
    });

    it('keeps the original label after the field is relabelled', async () => {
      const created = await createCase(memberAgent, {
        title: 'unit-testing-cf relabel case',
        customFields: { test_reference: 'JIRA-1000' },
      });
      should(created.status).equal(201);

      await new Promise((resolve, reject) => {
        adminAgent
          .put(`${baseUrl}custom-field/${textField._id}`)
          .send({ label: 'Ticket Reference' })
          .expect(200)
          .end((err) => (err ? reject(err) : resolve()));
      });

      const version = await ManualTestCaseVersion
        .findOne({ testCase: created.body._id, version: 1 })
        .lean();
      const reference = version.fieldDefinitions.find((d) => d.key === 'test_reference');
      should(reference.label).equal('Test Reference');

      // restore for the remaining tests
      await CustomFieldDefinition
        .findByIdAndUpdate(textField._id, { label: 'Test Reference' })
        .exec();
    });

    it('only snapshots definitions the case actually holds a value for', async () => {
      const created = await createCase(memberAgent, {
        title: 'unit-testing-cf partial snapshot',
        customFields: { test_reference: 'JIRA-1001' },
      });
      should(created.status).equal(201);

      const version = await ManualTestCaseVersion
        .findOne({ testCase: created.body._id, version: 1 })
        .lean();
      const keys = version.fieldDefinitions.map((d) => d.key);
      should(keys).containEql('test_reference');
      should(keys).not.containEql('test_layer');
    });

    it('does not burn a version when the same custom field values are re-sent', async () => {
      const created = await createCase(memberAgent, {
        title: 'unit-testing-cf no-op update',
        customFields: { test_reference: 'JIRA-1002' },
      });
      should(created.status).equal(201);

      await new Promise((resolve, reject) => {
        memberAgent
          .put(`${baseUrl}manual-test-case/${created.body._id}`)
          .send({ customFields: { test_reference: 'JIRA-1002' } })
          .expect(200)
          .end((err, res) => {
            if (err) return reject(err);
            should(res.body.version).equal(1);
            return resolve();
          });
      });
    });

    it('burns a version when a custom field value changes', async () => {
      const created = await createCase(memberAgent, {
        title: 'unit-testing-cf changed value',
        customFields: { test_reference: 'JIRA-1003' },
      });
      should(created.status).equal(201);

      await new Promise((resolve, reject) => {
        memberAgent
          .put(`${baseUrl}manual-test-case/${created.body._id}`)
          .send({ customFields: { test_reference: 'JIRA-1004' } })
          .expect(200)
          .end((err, res) => {
            if (err) return reject(err);
            should(res.body.version).equal(2);
            return resolve();
          });
      });

      const version1 = await ManualTestCaseVersion
        .findOne({ testCase: created.body._id, version: 1 })
        .lean();
      should(version1.customFields.test_reference).equal('JIRA-1003');
    });
  });

  describe('PUT /custom-field/:fieldId', () => {
    it('respond with 400 when trying to change the storage key', (done) => {
      adminAgent
        .put(`${baseUrl}custom-field/${textField._id}`)
        .send({ key: 'renamed_key' })
        .set('Accept', 'application/json')
        .expect(400)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.message).match(/cannot be changed/);
          done();
        });
    });

    it('respond with 409 when changing the type of a field already in use', (done) => {
      adminAgent
        .put(`${baseUrl}custom-field/${textField._id}`)
        .send({ type: 'number' })
        .set('Accept', 'application/json')
        .expect(409, done);
    });

    it('respond with 409 when removing an option still used by a test case', (done) => {
      adminAgent
        .put(`${baseUrl}custom-field/${selectField._id}`)
        .send({ options: ['unit', 'integration'] })
        .set('Accept', 'application/json')
        .expect(409)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.message).match(/still use them/);
          done();
        });
    });

    it('allows adding an option', (done) => {
      adminAgent
        .put(`${baseUrl}custom-field/${selectField._id}`)
        .send({ options: ['unit', 'integration', 'e2e', 'contract'] })
        .set('Accept', 'application/json')
        .expect(200)
        .end((err, res) => {
          if (err) throw err;
          should(res.body.options).have.length(4);
          done();
        });
    });

    it('respond with 403 for a non-admin', (done) => {
      memberAgent
        .put(`${baseUrl}custom-field/${textField._id}`)
        .send({ label: 'Hijacked' })
        .set('Accept', 'application/json')
        .expect(403, done);
    });
  });

  describe('DELETE /custom-field/:fieldId', () => {
    it('archives rather than deletes a field that is in use', (done) => {
      adminAgent
        .delete(`${baseUrl}custom-field/${textField._id}`)
        .set('Accept', 'application/json')
        .expect(200)
        .end(async (err, res) => {
          if (err) throw err;
          should(res.body.archived).equal(true);
          const stillThere = await CustomFieldDefinition.findById(textField._id).lean();
          should(stillThere).not.equal(null);
          should(stillThere.archived).equal(true);
          done();
        });
    });

    it('hard-deletes a field that has never been used', (done) => {
      adminAgent
        .post(`${baseUrl}custom-field`)
        .send({
          team: team._id.toString(), key: 'never_used', label: 'Never Used', type: 'text',
        })
        .expect(201)
        .end((createErr, createRes) => {
          if (createErr) throw createErr;
          adminAgent
            .delete(`${baseUrl}custom-field/${createRes.body._id}`)
            .expect(200)
            .end(async (err, res) => {
              if (err) throw err;
              should(res.body.archived).equal(false);
              const gone = await CustomFieldDefinition.findById(createRes.body._id).lean();
              should(gone).equal(null);
              done();
            });
        });
    });

    it('still accepts a stored value for an archived field', async () => {
      // The field was archived above; a case that already holds a value for it must still
      // save rather than failing with "not a configured custom field".
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf archived value',
        customFields: { test_reference: 'JIRA-2000' },
      });
      should(res.status).equal(201);
      should(res.body.customFields.test_reference).equal('JIRA-2000');
    });

    it('does not enforce required on an archived field', async () => {
      const created = await new Promise((resolve, reject) => {
        adminAgent
          .post(`${baseUrl}custom-field`)
          .send({
            team: team._id.toString(),
            key: 'archived_required',
            label: 'Archived Required',
            type: 'text',
            required: true,
          })
          .expect(201)
          .end((err, res) => (err ? reject(err) : resolve(res.body)));
      });
      await CustomFieldDefinition
        .findByIdAndUpdate(created._id, { archived: true })
        .exec();

      // Publishing with no value for the archived required field must still succeed - an
      // archived field is on its way out and cannot block authoring.
      const res = await createCase(memberAgent, {
        title: 'unit-testing-cf archived required',
        status: 'ACTIVE',
      });
      should(res.status).equal(201);

      await CustomFieldDefinition.findByIdAndRemove(created._id).exec();
    });

    it('respond with 403 for a non-admin', (done) => {
      memberAgent
        .delete(`${baseUrl}custom-field/${selectField._id}`)
        .set('Accept', 'application/json')
        .expect(403, done);
    });

    it('respond with 404 for an unknown id', (done) => {
      adminAgent
        .delete(`${baseUrl}custom-field/5f7e2b9e8f1b2c0017a1b2c3`)
        .set('Accept', 'application/json')
        .expect(404, done);
    });
  });
});
