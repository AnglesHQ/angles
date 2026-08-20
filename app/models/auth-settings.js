const mongoose = require('mongoose');

// Role names a provider group/attribute can map onto, highest privilege first. Kept in
// this order so a subject matching several mappings is granted the strongest role.
const ROLES = ['admin', 'team_lead', 'user'];

// A single group/attribute value to Angles role mapping. `value` is matched against the
// values extracted from the provider (OIDC groups claim, SAML attribute, LDAP memberOf).
const RoleMappingSchema = mongoose.Schema({
  value: { type: String, required: true, trim: true },
  role: { type: String, required: true, enum: ROLES },
}, { _id: false });

// OIDC-specific configuration. Endpoints are not stored: they come from discovery against
// the issuer's .well-known/openid-configuration, which also supplies the JWKS used to
// validate the ID token.
const OidcConfigSchema = mongoose.Schema({
  issuer: { type: String, default: '' },
  clientId: { type: String, default: '' },
  clientSecret: { type: String, default: '', select: false },
  // Space-separated scopes. `openid` is always required and is added automatically when
  // absent. Kept configurable because providers disagree: Okta and Keycloak understand
  // `groups`, Entra emits them without a scope, and Google rejects `groups` outright.
  scopes: { type: String, default: 'openid profile email' },
  // Where to find group membership in the claims. Providers differ - `groups` (Okta,
  // Keycloak), `roles`, or a namespaced claim such as `https://myapp/claims/groups`.
  groupsClaim: { type: String, default: 'groups' },
  // Claim to use as the Angles username. Falls back through email ->
  // preferred_username -> sub when the configured claim is absent.
  usernameClaim: { type: String, default: 'email' },
}, { _id: false });

// SAML 2.0 configuration for the service-provider side. Angles never holds the user's
// password here - the IdP posts back a signed assertion which is verified against
// `idpCert`.
const SamlConfigSchema = mongoose.Schema({
  // IdP SSO URL that the browser is redirected to (SAML "entry point").
  entryPoint: { type: String, default: '' },
  // The IdP's signing certificate (PEM body). Required to verify assertion signatures -
  // without it any party could forge an assertion, so it is never optional in practice.
  idpCert: { type: String, default: '' },
  // Our SP entity id, as registered with the IdP.
  issuer: { type: String, default: '' },
  // Optional SP signing key, needed only when the IdP requires signed AuthnRequests.
  privateKey: { type: String, default: '', select: false },
  signatureAlgorithm: { type: String, default: 'sha256', enum: ['sha256', 'sha512'] },
  identifierFormat: {
    type: String,
    default: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  },
  // Assertion attribute holding group membership, and the one holding the username.
  groupsAttribute: { type: String, default: 'groups' },
  usernameAttribute: { type: String, default: '' },
  // IdP-initiated login lets the IdP POST an unsolicited assertion to our ACS endpoint.
  // Off by default: it has no request to correlate against, which removes the CSRF
  // protection that RelayState/InResponseTo provide in the SP-initiated flow.
  allowUnsolicited: { type: Boolean, default: false },
}, { _id: false });

// LDAP / Active Directory configuration. Unlike OIDC and SAML this is a direct-bind
// flow: the user's password is submitted to Angles and forwarded to the directory, so
// `ldaps://` (or StartTLS) matters far more here than elsewhere.
const LdapConfigSchema = mongoose.Schema({
  url: { type: String, default: '' },
  // Service account used to search for the user before binding as them. Leave empty for
  // an anonymous search when the directory permits it.
  bindDN: { type: String, default: '' },
  bindCredentials: { type: String, default: '', select: false },
  searchBase: { type: String, default: '' },
  // {{username}} is substituted with the submitted username.
  searchFilter: { type: String, default: '(uid={{username}})' },
  // Group search. When `groupSearchBase` is empty we fall back to the user entry's
  // `memberOf` attribute, which is how Active Directory usually exposes membership.
  groupSearchBase: { type: String, default: '' },
  groupSearchFilter: { type: String, default: '(member={{dn}})' },
  groupNameAttribute: { type: String, default: 'cn' },
  usernameAttribute: { type: String, default: 'uid' },
  // Reject a directory certificate that does not validate. Defaults to true; turning it
  // off makes the TLS connection trivially interceptable and is only for self-signed
  // lab setups.
  tlsRejectUnauthorized: { type: Boolean, default: true },
  startTLS: { type: Boolean, default: false },
}, { _id: false });

// One configured identity provider. `id` is the URL-safe handle used in the login routes
// (/auth/sso/:id), so it must be unique within the providers array and stable once
// deployed - changing it changes the callback URL registered with the IdP.
const ProviderSchema = mongoose.Schema({
  id: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: [/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/, 'Provider id must be 2-32 lowercase alphanumeric or hyphen characters.'],
  },
  // Human-readable label shown on the login button.
  name: { type: String, required: true, trim: true },
  type: { type: String, required: true, enum: ['oidc', 'saml', 'ldap'] },
  enabled: { type: Boolean, default: false },
  oidc: { type: OidcConfigSchema, default: () => ({}) },
  saml: { type: SamlConfigSchema, default: () => ({}) },
  ldap: { type: LdapConfigSchema, default: () => ({}) },
  roleMappings: { type: [RoleMappingSchema], default: [] },
  // When no role mapping matches, fall back to this role instead of denying access.
  // Empty means deny - the stricter default, and the behaviour Angles had for Okta.
  defaultRole: { type: String, default: '', enum: ['', ...ROLES] },
}, { _id: false });

// Single-document collection holding runtime-configurable authentication settings.
// The `singleton` field is fixed to 'auth' with a unique index so only one document
// can ever exist.
//
// Provider secrets (OIDC client secret, SAML private key, LDAP bind credentials) are
// stored here so they can be managed entirely from the admin UI, but they are
// write-only: the settings API never returns their values (only a boolean flag
// indicating whether one is set), and `select: false` keeps them out of query results
// unless explicitly requested.
const AuthSettingsSchema = mongoose.Schema({
  singleton: {
    type: String,
    default: 'auth',
    unique: true,
    enum: ['auth'],
  },
  localAuthEnabled: { type: Boolean, default: true },
  providers: { type: [ProviderSchema], default: [] },
}, {
  timestamps: true,
}, { collection: 'authSettings' });

module.exports = mongoose.model('AuthSettings', AuthSettingsSchema);
module.exports.ROLES = ROLES;
