const http = require('http');
const { URL } = require('url');
const jose = require('jose');

/**
 * A minimal but genuine OIDC provider for the test suite.
 *
 * It performs real discovery, publishes a real JWKS, and issues ID tokens signed with the
 * matching RS256 key, so the client validates signature, issuer, audience, nonce and
 * expiry exactly as it would against a live IdP. That is the point: a stubbed strategy
 * would pass regardless of whether token validation actually works.
 */
class TestOidcProvider {
  constructor() {
    this.clients = new Map();
    this.codes = new Map();
    // Claims handed to the next issued token. Tests set this to model different
    // providers (Okta-style `groups`, Entra-style GUIDs, Auth0-style namespaced claims).
    this.nextClaims = {};
  }

  async start() {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    this.privateKey = privateKey;
    this.jwk = await jose.exportJWK(publicKey);
    this.jwk.kid = 'test-key';
    this.jwk.alg = 'RS256';
    this.jwk.use = 'sig';

    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.issuer = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  stop() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  registerClient(clientId, clientSecret) {
    this.clients.set(clientId, clientSecret);
  }

  handle(req, res) {
    const url = new URL(req.url, this.issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/v1/authorize`,
        token_endpoint: `${this.issuer}/v1/token`,
        userinfo_endpoint: `${this.issuer}/v1/userinfo`,
        jwks_uri: `${this.issuer}/v1/keys`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        scopes_supported: ['openid', 'profile', 'email', 'groups'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    }

    if (url.pathname === '/v1/keys') {
      return json(200, { keys: [this.jwk] });
    }

    // The authorize endpoint records the request and immediately redirects back with a
    // code, standing in for the user authenticating at the IdP.
    if (url.pathname === '/v1/authorize') {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      this.codes.set(code, {
        clientId: url.searchParams.get('client_id'),
        nonce: url.searchParams.get('nonce'),
        claims: this.nextClaims,
      });
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      res.writeHead(302, {
        Location: `${redirectUri}?code=${code}&state=${encodeURIComponent(state)}`,
      });
      return res.end();
    }

    if (url.pathname === '/v1/token') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      return req.on('end', async () => {
        const params = new URLSearchParams(body);
        const record = this.codes.get(params.get('code'));
        if (!record) return json(400, { error: 'invalid_grant' });
        this.codes.delete(params.get('code'));

        const idToken = await new jose.SignJWT({
          nonce: record.nonce,
          ...record.claims,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(this.issuer)
          .setAudience(record.clientId)
          .setSubject(record.claims.sub || 'test-subject')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(this.privateKey);

        return json(200, {
          access_token: 'test-access-token',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken,
        });
      });
    }

    if (url.pathname === '/v1/userinfo') {
      return json(200, { sub: 'test-subject', ...this.nextClaims });
    }

    res.writeHead(404);
    return res.end();
  }
}

module.exports = TestOidcProvider;
