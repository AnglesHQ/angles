/*
 * Security headers for every API response.
 *
 * The API answers with JSON and files, so the default policy forbids loading anything at
 * all (`default-src 'none'`): if a response is ever rendered as a page - an error echoing
 * input, a file opened directly - nothing in it can run or load. `frame-ancestors 'none'`
 * and X-Frame-Options stop any API page being framed.
 *
 * Two kinds of response render real pages and set their own policy instead:
 *  - the Swagger UI under /api-docs, which needs its own scripts and styles;
 *  - the HTML build report (see buildController.getReport), which uses a nonce.
 * Attachment files set a sandbox policy of their own as well.
 */
const API_POLICY = "default-src 'none'; frame-ancestors 'none'";
const SWAGGER_POLICY = "frame-ancestors 'none'";

const securityHeaders = (req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', req.path.startsWith('/api-docs') ? SWAGGER_POLICY : API_POLICY);
  next();
};

/*
 * The policy for the HTML build report: its own inline styles, its one inline script (by
 * nonce) and its embedded data: screenshots, and nothing else - no network requests.
 */
const reportPolicy = (nonce) => [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'nonce-${nonce}'`,
  'img-src data:',
  "frame-ancestors 'none'",
].join('; ');

module.exports = { securityHeaders, reportPolicy };
