/*
 * Which browser origins count as "the Angles UI".
 *
 * The UI and the API are usually served from the same host on different ports (the UI on
 * 3001, the API on 3000) or behind one proxy. The rule is the one CORS already applies:
 * an origin belongs to the UI when its host is the API's own host, with `localhost` and
 * `127.0.0.1` treated as the same host. Ports and schemes may differ.
 *
 * The SSO login uses the same rule to decide where to send the browser back to after
 * the identity provider (`returnTo`). Accepting any origin there would make the API an
 * open redirect, so anything else is ignored.
 */
const isLocal = (host) => host === 'localhost' || host === '127.0.0.1';

const isSameHost = (originHostname, requestHostname) => originHostname === requestHostname
  || (isLocal(originHostname) && isLocal(requestHostname));

/**
 * The origin (`scheme://host[:port]`) of `value` when it is an http(s) URL on the same
 * host as the request, otherwise undefined. Only the origin is kept: the UI decides its
 * own landing page.
 */
const trustedUiOrigin = (value, req) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (!isSameHost(url.hostname, req.hostname)) return undefined;
  return url.origin;
};

module.exports = { isSameHost, trustedUiOrigin };
