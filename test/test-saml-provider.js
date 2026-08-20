const crypto = require('crypto');
const { SignedXml } = require('xml-crypto');

/**
 * A minimal but genuine SAML 2.0 identity provider for the test suite.
 *
 * It issues real assertions signed with a real RSA key, so the strategy performs actual
 * XML signature verification against the certificate it was configured with. That is the
 * point: SAML's entire security model is "the signature verifies", and a stubbed profile
 * would pass whether or not verification works.
 *
 * The keypair is generated per run rather than committed, so no private key lives in the
 * repository.
 */
class TestSamlProvider {
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    this.privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    this.publicKey = publicKey;
    this.certPem = TestSamlProvider.buildSelfSignedCert(privateKey, publicKey);
    this.entryPoint = 'https://idp.example.test/sso';
  }

  /**
   * Builds a DER-encoded self-signed X.509 certificate wrapping the public key.
   *
   * node-saml uses the certificate purely as a carrier for the public key when verifying
   * signatures - it does not validate the chain, dates or subject - so a minimal
   * structurally-valid certificate is sufficient and keeps the helper free of any
   * external tooling dependency.
   */
  static buildSelfSignedCert(privateKey, publicKey) {
    const spki = publicKey.export({ type: 'spki', format: 'der' });

    // Minimal DER encoding helpers. DER length encoding is defined in terms of octets
    // and a high bit flag, so bitwise arithmetic is the natural expression of it.
    /* eslint-disable no-bitwise */
    const len = (n) => {
      if (n < 0x80) return Buffer.from([n]);
      const bytes = [];
      let value = n;
      while (value > 0) { bytes.unshift(value & 0xff); value >>= 8; }
      return Buffer.from([0x80 | bytes.length, ...bytes]);
    };
    /* eslint-enable no-bitwise */
    const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
    const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
    const set = (body) => tlv(0x31, body);
    const oid = (bytes) => tlv(0x06, Buffer.from(bytes));
    const utf8 = (value) => tlv(0x0c, Buffer.from(value, 'utf8'));
    const int = (buf) => tlv(0x02, buf);
    const utcTime = (date) => tlv(0x17, Buffer.from(
      `${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`,
      'ascii',
    ));

    // sha256WithRSAEncryption, and the CN attribute type.
    const sigAlg = seq(
      oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
      tlv(0x05, Buffer.alloc(0)),
    );
    const cn = seq(set(seq(oid([0x55, 0x04, 0x03]), utf8('test-idp'))));

    const now = new Date();
    const later = new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000);

    const tbs = seq(
      tlv(0xa0, int(Buffer.from([0x02]))), // version v3
      int(Buffer.from([0x01])), // serial number
      sigAlg,
      cn, // issuer
      seq(utcTime(now), utcTime(later)),
      cn, // subject (self-signed)
      spki,
    );

    const signature = crypto.sign('sha256', tbs, privateKey);
    const cert = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])));

    const b64 = cert.toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  }

  /**
   * Builds a signed SAML Response, base64-encoded ready to POST to the ACS endpoint.
   *
   * @param {Object} options
   * @param {string} options.nameID - the subject identifier
   * @param {Object} options.attributes - attribute name to value(s)
   * @param {string} options.audience - the SP entity id
   * @param {string} options.destination - the ACS URL
   * @param {string} [options.inResponseTo] - the AuthnRequest id being answered
   * @param {boolean} [options.sign=true] - whether to sign the assertion
   * @param {boolean} [options.signResponse=true] - whether to also sign the enclosing
   *   Response. Real IdPs vary; Angles requires it by default.
   * @param {string} [options.notOnOrAfter] - override the expiry, to test stale assertions
   */
  buildResponse({
    nameID,
    attributes = {},
    audience,
    destination,
    inResponseTo,
    sign = true,
    signResponse = true,
    notOnOrAfter,
  }) {
    const now = new Date();
    const issueInstant = now.toISOString();
    const expiry = notOnOrAfter || new Date(now.getTime() + 5 * 60 * 1000).toISOString();
    const assertionId = `_${crypto.randomBytes(16).toString('hex')}`;
    const responseId = `_${crypto.randomBytes(16).toString('hex')}`;
    this.lastResponseId = responseId;

    const attributeXml = Object.entries(attributes).map(([name, value]) => {
      const values = (Array.isArray(value) ? value : [value])
        .map((entry) => `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${entry}</saml:AttributeValue>`)
        .join('');
      return `<saml:Attribute Name="${name}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:unspecified">${values}</saml:Attribute>`;
    }).join('');

    const confirmationData = [
      `NotOnOrAfter="${expiry}"`,
      `Recipient="${destination}"`,
      inResponseTo ? `InResponseTo="${inResponseTo}"` : '',
    ].filter(Boolean).join(' ');

    // The XML is assembled by line-broken concatenation so each element stays readable;
    // a single template literal would be one unbroken line.
    /* eslint-disable prefer-template */
    const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}">`
      + `<saml:Issuer>${this.entryPoint}</saml:Issuer>`
      + '<saml:Subject>'
      + '<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">'
      + `${nameID}</saml:NameID>`
      + '<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
      + `<saml:SubjectConfirmationData ${confirmationData}/>`
      + '</saml:SubjectConfirmation>'
      + '</saml:Subject>'
      + `<saml:Conditions NotBefore="${new Date(now.getTime() - 60000).toISOString()}" `
      + `NotOnOrAfter="${expiry}">`
      + `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>`
      + '</saml:Conditions>'
      + `<saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${assertionId}">`
      + '<saml:AuthnContext><saml:AuthnContextClassRef>'
      + 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'
      + '</saml:AuthnContextClassRef></saml:AuthnContext>'
      + '</saml:AuthnStatement>'
      + (attributeXml ? `<saml:AttributeStatement>${attributeXml}</saml:AttributeStatement>` : '')
      + '</saml:Assertion>';

    const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${destination}"${inResponseTo ? ` InResponseTo="${inResponseTo}"` : ''}>`
      + `<saml:Issuer>${this.entryPoint}</saml:Issuer>`
      + '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'
      + assertion
      + '</samlp:Response>';

    /* eslint-enable prefer-template */

    // Sign in place, inside the finished Response. Signing the assertion standalone and
    // then embedding it would break the digest: the assertion inherits different
    // namespace declarations once nested, so it canonicalises differently.
    //
    // The Response signature is applied last, so the assertion signature is part of the
    // content it covers - the same order a real IdP uses.
    let signed = response;
    if (sign) {
      signed = this.signElement(signed, assertionId, 'Assertion');
    }
    if (signResponse) {
      signed = this.signElement(signed, responseId, 'Response');
    }

    return Buffer.from(signed).toString('base64');
  }

  /**
   * Applies an enveloped XML-DSig signature over the named element within the document,
   * as a real IdP does. Used for both the Assertion and the enclosing Response.
   */
  signElement(xml, elementId, localName) {
    const sig = new SignedXml({
      privateKey: this.privateKeyPem,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      getKeyInfoContent: () => `<X509Data><X509Certificate>${this.certBody()}</X509Certificate></X509Data>`,
    });

    sig.addReference({
      xpath: `//*[local-name(.)='${localName}' and @ID='${elementId}']`,
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
    });

    // Place the signature directly after the element's own Issuer child, which is where
    // the SAML schema requires it.
    sig.computeSignature(xml, {
      location: {
        reference: `//*[local-name(.)='${localName}' and @ID='${elementId}']/*[local-name(.)='Issuer']`,
        action: 'after',
      },
    });

    return sig.getSignedXml();
  }

  /** The base64 certificate body, as an admin would paste it into the UI. */
  certBody() {
    return this.certPem
      .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
      .replace(/\s+/g, '');
  }
}

module.exports = TestSamlProvider;
