/**
 * The URLs an SSO login depends on: the public URL identity providers send users back to
 * (each provider's callback is derived from it), and which UI origins a login may return
 * to afterwards.
 */
const should = require('should');
const { resolveBaseUrl } = require('../config/auth.config.js');
const { trustedUiOrigin, isSameHost } = require('../app/utils/ui-origin.js');

const ENV_KEYS = ['ANGLES_BASE_URL', 'ANGLES_API_BASE_URL', 'SWAGGER_SCHEMES'];

describe('SSO URL Tests', () => {
  describe('resolveBaseUrl', () => {
    let saved;

    beforeEach(() => {
      saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
      ENV_KEYS.forEach((key) => { delete process.env[key]; });
    });

    afterEach(() => {
      ENV_KEYS.forEach((key) => {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      });
    });

    it('uses ANGLES_BASE_URL when it is set', () => {
      process.env.ANGLES_BASE_URL = 'https://angles.example.com/';
      process.env.ANGLES_API_BASE_URL = 'https://api.example.com';
      resolveBaseUrl().should.equal('https://angles.example.com');
    });

    it('falls back to the API URL rather than localhost', () => {
      process.env.ANGLES_API_BASE_URL = 'https://angles-api.example.com';
      resolveBaseUrl().should.equal('https://angles-api.example.com');
    });

    it('treats an empty ANGLES_BASE_URL as unset, as docker-compose passes it', () => {
      process.env.ANGLES_BASE_URL = '';
      process.env.ANGLES_API_BASE_URL = 'https://angles-api.example.com';
      resolveBaseUrl().should.equal('https://angles-api.example.com');
    });

    it('adds the Swagger scheme to an API URL without one', () => {
      process.env.ANGLES_API_BASE_URL = 'angles.internal:3000';
      process.env.SWAGGER_SCHEMES = 'https, http';
      resolveBaseUrl().should.equal('https://angles.internal:3000');
      process.env.SWAGGER_SCHEMES = '';
      resolveBaseUrl().should.equal('http://angles.internal:3000');
    });

    it('defaults to http://localhost:3000 when nothing is configured', () => {
      resolveBaseUrl().should.equal('http://localhost:3000');
    });
  });

  describe('trustedUiOrigin', () => {
    const req = (hostname) => ({ hostname });

    it('accepts an origin on the API host on any port and scheme', () => {
      trustedUiOrigin('https://angles.example.com:8443', req('angles.example.com'))
        .should.equal('https://angles.example.com:8443');
      trustedUiOrigin('http://angles.example.com', req('angles.example.com'))
        .should.equal('http://angles.example.com');
    });

    it('treats localhost and 127.0.0.1 as the same host', () => {
      trustedUiOrigin('http://localhost:3001', req('127.0.0.1')).should.equal('http://localhost:3001');
      isSameHost('127.0.0.1', 'localhost').should.equal(true);
    });

    it('keeps only the origin', () => {
      trustedUiOrigin('http://localhost:3001/a/b?c=d#e', req('localhost')).should.equal('http://localhost:3001');
    });

    it('rejects other hosts, look-alikes and non-http schemes', () => {
      should.not.exist(trustedUiOrigin('https://evil.example.org', req('angles.example.com')));
      should.not.exist(trustedUiOrigin('https://angles.example.com.evil.org', req('angles.example.com')));
      // eslint-disable-next-line no-script-url
      should.not.exist(trustedUiOrigin('javascript:alert(1)', req('localhost')));
      should.not.exist(trustedUiOrigin('//angles.example.com', req('angles.example.com')));
      should.not.exist(trustedUiOrigin('http://user:pw@localhost:3001', req('localhost')));
    });

    it('rejects anything that is not a single string', () => {
      should.not.exist(trustedUiOrigin(undefined, req('localhost')));
      should.not.exist(trustedUiOrigin('', req('localhost')));
      should.not.exist(trustedUiOrigin(['http://localhost:3001'], req('localhost')));
      should.not.exist(trustedUiOrigin(`http://localhost/${'a'.repeat(3000)}`, req('localhost')));
    });
  });
});
