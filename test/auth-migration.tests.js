const should = require('should');
const mongoose = require('mongoose');
require('../server.js');
const AuthSettings = require('../app/models/auth-settings.js');
const authSettingsService = require('../app/utils/auth-settings-service.js');
const authConfig = require('../config/auth.config.js');

/**
 * Releases up to 2.0.30 stored a single Okta configuration as flat `okta*` fields on the
 * settings singleton. Upgrading must fold that into the providers array without an admin
 * re-entering anything - in particular the client secret, which the UI never returns and
 * which they would have no way to recover.
 *
 * The legacy document is written through the raw collection, bypassing mongoose, because
 * the fields no longer exist in the schema.
 */
describe('Legacy Okta settings migration', () => {
  // These tests drive loadAuthSettings() against deliberately malformed documents, which
  // means repeatedly emptying and rewriting the auth settings singleton. Every other
  // suite shares that same singleton through the one app instance, and mocha interleaves
  // async hooks across files, so doing this on the live collection races their setup.
  //
  // Mongoose resolves a model's collection when the model is compiled, so the isolation
  // is done by pointing the service at a second model over its own collection for the
  // duration of this suite - same schema, same code path, nothing else reading it.
  const scratchCollection = 'authsettings_migration_tests';
  let ScratchAuthSettings;

  before(() => {
    ScratchAuthSettings = mongoose.model(
      'AuthSettingsMigrationTest',
      AuthSettings.schema.clone(),
      scratchCollection,
    );
  });

  /**
   * Runs one service call against the scratch collection.
   *
   * The swap is scoped to the individual call rather than held for the whole suite:
   * another suite's teardown may call loadAuthSettings() while this one is running, and
   * a suite-wide swap would send that write into the scratch collection - which is what
   * made this suite intermittently see a second provider.
   */
  const onScratch = async (fn) => {
    // eslint-disable-next-line no-underscore-dangle
    const restore = authSettingsService.__setModelForTesting(ScratchAuthSettings);
    try {
      return await fn();
    } finally {
      restore();
    }
  };

  // `providers` is set explicitly so no earlier document's providers can survive into
  // the test.
  const writeLegacyDoc = (fields) => mongoose.connection.collection(scratchCollection)
    .replaceOne(
      { singleton: 'auth' },
      {
        singleton: 'auth',
        localAuthEnabled: true,
        providers: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        __v: 0,
        ...fields,
      },
      { upsert: true },
    );

  beforeEach(async () => {
    await mongoose.connection.collection(scratchCollection).deleteMany({});
  });

  after(async () => {
    await mongoose.connection.collection(scratchCollection).drop().catch(() => {});
    // Reload from the real collection, so the in-memory authConfig matches the live
    // settings again for any suite that runs afterwards.
    await authSettingsService.loadAuthSettings();
  });

  it('folds a configured Okta tenant into an oidc provider, secret included', async () => {
    await writeLegacyDoc({
      oktaAuthEnabled: true,
      oktaDomain: 'example.okta.com',
      oktaIssuer: 'https://example.okta.com/oauth2/default',
      oktaClientId: 'legacy-client-id',
      oktaClientSecret: 'legacy-client-secret',
      oktaAdminGroup: 'angles-admins',
      oktaTeamLeadGroup: 'angles-team-leads',
      oktaUserGroup: 'angles-users',
    });

    const settings = await onScratch(() => authSettingsService.loadAuthSettings());

    settings.providers.should.have.length(1);
    const [provider] = settings.providers;
    provider.id.should.equal('okta');
    provider.name.should.equal('Okta');
    provider.type.should.equal('oidc');
    provider.enabled.should.equal(true);
    provider.oidc.issuer.should.equal('https://example.okta.com/oauth2/default');
    provider.oidc.clientId.should.equal('legacy-client-id');
    provider.oidc.clientSecret.should.equal('legacy-client-secret');
    // The previous implementation always requested these scopes.
    provider.oidc.scopes.should.equal('openid profile email groups');

    provider.roleMappings.should.have.length(3);
    const byRole = provider.roleMappings.reduce((acc, mapping) => {
      acc[mapping.role] = mapping.value;
      return acc;
    }, {});
    byRole.admin.should.equal('angles-admins');
    byRole.team_lead.should.equal('angles-team-leads');
    byRole.user.should.equal('angles-users');

    // Denying an unmapped user was the previous behaviour, so no default role.
    provider.defaultRole.should.equal('');
  });

  it('removes the legacy fields from the persisted document', async () => {
    await writeLegacyDoc({
      oktaAuthEnabled: true,
      oktaIssuer: 'https://example.okta.com/oauth2/default',
      oktaClientId: 'legacy-client-id',
      oktaClientSecret: 'legacy-client-secret',
    });

    await onScratch(() => authSettingsService.loadAuthSettings());

    const raw = await mongoose.connection.collection(scratchCollection).findOne({ singleton: 'auth' });
    should.not.exist(raw.oktaAuthEnabled);
    should.not.exist(raw.oktaIssuer);
    should.not.exist(raw.oktaClientId);
    should.not.exist(raw.oktaClientSecret);
    raw.providers.should.have.length(1);
  });

  it('carries a disabled Okta config across as a disabled provider', async () => {
    await writeLegacyDoc({
      oktaAuthEnabled: false,
      oktaIssuer: 'https://example.okta.com/oauth2/default',
      oktaClientId: 'legacy-client-id',
    });

    const settings = await onScratch(() => authSettingsService.loadAuthSettings());
    settings.providers.should.have.length(1);
    settings.providers[0].enabled.should.equal(false);
  });

  it('omits role mappings that were never configured', async () => {
    await writeLegacyDoc({
      oktaAuthEnabled: true,
      oktaIssuer: 'https://example.okta.com/oauth2/default',
      oktaClientId: 'legacy-client-id',
      oktaAdminGroup: 'angles-admins',
    });

    const settings = await onScratch(() => authSettingsService.loadAuthSettings());
    settings.providers[0].roleMappings.should.have.length(1);
    settings.providers[0].roleMappings[0].role.should.equal('admin');
  });

  it('is idempotent - a second load does not duplicate the provider', async () => {
    await writeLegacyDoc({
      oktaAuthEnabled: true,
      oktaIssuer: 'https://example.okta.com/oauth2/default',
      oktaClientId: 'legacy-client-id',
      oktaClientSecret: 'legacy-client-secret',
    });

    await onScratch(() => authSettingsService.loadAuthSettings());
    const settings = await onScratch(() => authSettingsService.loadAuthSettings());

    settings.providers.should.have.length(1);
    // The secret survives the second pass rather than being reset.
    settings.providers[0].oidc.clientSecret.should.equal('legacy-client-secret');
  });

  it('leaves a document with no legacy fields untouched', async () => {
    await ScratchAuthSettings.create({
      singleton: 'auth',
      localAuthEnabled: true,
      providers: [{
        id: 'keycloak',
        name: 'Keycloak',
        type: 'oidc',
        enabled: true,
        oidc: { issuer: 'https://kc.example/realms/main', clientId: 'angles' },
      }],
    });

    const settings = await onScratch(() => authSettingsService.loadAuthSettings());
    settings.providers.should.have.length(1);
    settings.providers[0].id.should.equal('keycloak');
  });

  it('never returns a migrated secret through the settings API shape', async () => {
    await writeLegacyDoc({
      oktaAuthEnabled: true,
      oktaIssuer: 'https://example.okta.com/oauth2/default',
      oktaClientId: 'legacy-client-id',
      oktaClientSecret: 'legacy-client-secret',
    });

    const publicSettings = await onScratch(() => authSettingsService.getAuthSettings());
    const [provider] = publicSettings.providers;
    provider.clientSecretSet.should.equal(true);
    should.not.exist(provider.oidc.clientSecret);
  });

  it('mirrors the migrated provider onto the runtime config', async () => {
    await writeLegacyDoc({
      oktaAuthEnabled: true,
      oktaIssuer: 'https://example.okta.com/oauth2/default',
      oktaClientId: 'legacy-client-id',
      oktaClientSecret: 'legacy-client-secret',
    });

    await onScratch(() => authSettingsService.loadAuthSettings());
    const provider = authConfig.providers.find((candidate) => candidate.id === 'okta');
    should.exist(provider);
    // The runtime copy keeps the secret - it is needed to build the strategy.
    provider.oidc.clientSecret.should.equal('legacy-client-secret');
  });
});
