# Authentication

Angles supports local password accounts alongside any number of single sign-on
providers. Everything except two deployment values is configured at runtime from the
admin UI (**Settings → Authentication**) and stored in the database, so adding or
changing a provider needs no restart and no redeploy.

## Deployment values

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANGLES_BASE_URL` | For SSO | Public origin of this instance, e.g. `https://angles.example.com`. Every provider's callback URL is derived from it and must match what is registered with the identity provider. Defaults to `http://localhost:3000`. |
| `SESSION_SECRET` | In production | Signs session cookies. Startup fails without it when `NODE_ENV=production`. Anyone who knows it can forge a session for any account, including an admin, so generate a random value per deployment. |
| `ANGLES_ADMIN_PASSWORD` | First run | Seeds the initial local admin account. |
| `SECURE_COOKIES` | Over HTTPS | Set to `true` to mark the session cookie `Secure`. |
| `TRUST_PROXY` | Behind a proxy | Set to `true` so `SECURE_COOKIES` works behind a TLS-terminating reverse proxy. |

Provider secrets - OIDC client secrets, SAML private keys, LDAP bind credentials - are
stored in the database and are **write-only** through the API. They are never returned;
the settings response reports only a `…Set` boolean. Saving a form with a blank secret
field keeps the stored value rather than clearing it.

## Provider types

Each provider has an `id` (a stable, URL-safe handle used in its login and callback
URLs), a display name, a type, and a set of role mappings.

### Roles

A provider grants an Angles role by matching the groups it reports against the
provider's `roleMappings`. Matching is case-insensitive. A user matching several
mappings gets the strongest role (`admin` > `team_lead` > `user`). When nothing matches,
access is denied unless a `defaultRole` is configured.

A username already held by a local account or by a different provider is never taken
over: the login is refused instead. This prevents an identity provider from overwriting
a local admin's role by asserting a matching username.

### OIDC

Works with any spec-compliant provider - Okta, Entra ID, Google Workspace, Keycloak,
Auth0, Authentik, Ping, Cognito, GitLab. Endpoints and signing keys are discovered from
the issuer's `.well-known/openid-configuration`; the authorization code flow with PKCE
is used, and ID tokens are validated against the discovered JWKS.

Register `{ANGLES_BASE_URL}/rest/api/v1.0/auth/sso/{id}/callback` as the redirect URI.

Providers differ in ways worth knowing:

- **Scopes** are configurable because providers disagree. Okta and Keycloak understand
  `groups`; Google rejects it outright; Entra emits groups without any scope. `openid`
  is always added automatically.
- **Groups claim**: `groups` for Okta, often `roles` for Keycloak, a namespaced URI such
  as `https://myapp.example/groups` for Auth0.
- **Entra ID** emits group **GUIDs**, not names - map roles to the GUIDs. It also omits
  the claim entirely past roughly 200 groups, substituting a pointer to the Graph API.
  Angles logs this case explicitly; the fix is a group filter on the Entra side, or
  using application roles instead.
- **Google Workspace** does not emit groups at all without Cloud Identity, so a
  `defaultRole` is usually needed.

### SAML 2.0

For ADFS, Shibboleth, and any IdP that only offers SAML. Import SP metadata from
`{ANGLES_BASE_URL}/rest/api/v1.0/auth/sso/{id}/metadata` rather than transcribing values
by hand; the ACS endpoint is `{ANGLES_BASE_URL}/rest/api/v1.0/auth/sso/{id}/callback`.

The IdP signing certificate is required - it is the only reason an assertion can be
trusted. It is accepted with or without PEM armour and in any line wrapping.

Three security defaults, each relaxable only where interoperability genuinely requires
it:

- **Assertion signatures are always required.** Not configurable.
- **Response signatures are required** by default. Set `wantAuthnResponseSigned` to
  `false` for the many IdPs that sign only the assertion; the assertion signature is
  still enforced, so the login is never left unauthenticated.
- **IdP-initiated login is rejected.** An unsolicited assertion has no AuthnRequest to
  correlate against, which removes its replay protection. Enable `allowUnsolicited`
  only if your IdP requires it.

Note that SAML request correlation uses an in-memory cache. Across multiple Angles
instances, a login begun on one and finished on another is rejected, so route the SAML
endpoints with sticky sessions.

### LDAP / Active Directory

Unlike OIDC and SAML this is a direct bind: the user submits their password to Angles,
which forwards it to the directory. Because of that, a plaintext `ldap://` URL without
StartTLS is **refused** - it would put directory passwords on the wire in clear text.
Use `ldaps://`, or `ldap://` with `startTLS` enabled.

Group membership is read from a group search when `groupSearchBase` is set, and
otherwise from the user entry's `memberOf` attribute (how Active Directory usually
exposes it). Full DNs are reduced to the group name, so map roles to names such as
`Angles Admins` rather than the whole DN.

LDAP uses a credential POST rather than a browser redirect:

```
POST /rest/api/v1.0/auth/sso/{id}/login
{ "username": "...", "password": "..." }
```

## Upgrading from the single-Okta configuration

Releases up to 2.0.30 stored one Okta configuration as flat `okta*` fields. On first
startup after upgrading, that is migrated automatically into a provider with id `okta`,
including the client secret, and the legacy fields are removed. The migration is
idempotent, and no admin action is required.

The API shape changed with it:

| Before | Now |
| --- | --- |
| `oktaAuthEnabled`, `oktaIssuer`, … on `/settings/auth` | `providers[]` |
| `GET /auth/okta` | `GET /auth/sso/{id}` |
| `GET /auth/okta/callback` | `GET /auth/sso/{id}/callback` |
| `oktaAuthEnabled` on `/auth/config` | `providers[]` |

The migrated provider keeps the id `okta`, so its callback URL becomes
`/rest/api/v1.0/auth/sso/okta/callback`. **Update the redirect URI registered in Okta**
to match, or logins will fail at the callback.
