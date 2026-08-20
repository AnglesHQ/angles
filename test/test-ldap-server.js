const crypto = require('crypto');
const ldap = require('ldapjs');
const TestSamlProvider = require('./test-saml-provider.js');

/**
 * A minimal in-process LDAP directory for the test suite.
 *
 * It performs real bind operations, so a wrong password is rejected by the server rather
 * than by a stub, and real subtree searches, so the strategy's search filter and group
 * resolution are genuinely exercised.
 *
 * Served over real LDAPS (ldaps://) with a self-signed certificate, because the strategy
 * refuses a plaintext bind - and rightly so, since this flow carries the user's password.
 * That means the tests exercise the same transport a correct deployment uses.
 */
class TestLdapServer {
  constructor() {
    // Reuse the self-signed certificate builder written for the SAML tests, so the key
    // and certificate are generated per run rather than committed.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey.export({ type: 'pkcs8', format: 'pem' });
    this.cert = TestSamlProvider.buildSelfSignedCert(privateKey, publicKey);

    this.server = ldap.createServer({ certificate: this.cert, key: this.key });
    // username -> { dn, password, attributes }
    this.users = new Map();
    // dn -> { cn, members: [userDn] }
    this.groups = new Map();
    this.searchBase = 'ou=people,dc=example,dc=com';
    this.groupBase = 'ou=groups,dc=example,dc=com';
  }

  addUser(username, password, attributes = {}) {
    const dn = `uid=${username},${this.searchBase}`;
    this.users.set(username, {
      dn,
      password,
      attributes: { uid: username, ...attributes },
    });
    return dn;
  }

  addGroup(cn, memberUsernames = []) {
    const dn = `cn=${cn},${this.groupBase}`;
    this.groups.set(dn, {
      cn,
      members: memberUsernames.map((username) => `uid=${username},${this.searchBase}`),
    });
    return dn;
  }

  /** Grants a user a memberOf attribute, as Active Directory does. */
  setMemberOf(username, groupDns) {
    const user = this.users.get(username);
    user.attributes.memberOf = groupDns;
  }

  async start() {
    // The service account used for the pre-bind search, plus every user's own bind.
    this.server.bind('', (req, res, next) => {
      const dn = req.dn.toString().replace(/,\s+/g, ',');

      // The service account.
      if (dn === 'cn=service,dc=example,dc=com') {
        if (req.credentials === 'service-password') {
          res.end();
          return next();
        }
        return next(new ldap.InvalidCredentialsError());
      }

      const user = [...this.users.values()]
        .find((candidate) => candidate.dn.replace(/,\s+/g, ',') === dn);
      if (user && req.credentials === user.password) {
        res.end();
        return next();
      }
      return next(new ldap.InvalidCredentialsError());
    });

    // User subtree search: resolves the filter to a single entry.
    this.server.search(this.searchBase, (req, res, next) => {
      [...this.users.values()].forEach((user) => {
        const entry = {
          dn: user.dn,
          attributes: { objectclass: ['inetOrgPerson'], ...user.attributes },
        };
        if (req.filter.matches(entry.attributes)) {
          res.send(entry);
        }
      });
      res.end();
      return next();
    });

    // Group subtree search, for directories where membership lives on the group.
    this.server.search(this.groupBase, (req, res, next) => {
      [...this.groups.entries()].forEach(([dn, group]) => {
        const attributes = {
          objectclass: ['groupOfNames'],
          cn: group.cn,
          member: group.members,
        };
        if (req.filter.matches(attributes)) {
          res.send({ dn, attributes });
        }
      });
      res.end();
      return next();
    });

    await new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.url = `ldaps://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  stop() {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

module.exports = TestLdapServer;
