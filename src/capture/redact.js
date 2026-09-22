/** Redaction is a privacy boundary, not a token optimisation.
 *
 *  Nothing in this file may be relaxed "just to give the model more context":
 *  raw response bodies, cookies and credentials must never reach a third-party
 *  API. Token budgeting happens later, in src/prompt/budget.js.
 */

const DENY_HEADERS = [
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
  'api-key', 'apikey', 'x-access-token', 'x-session-token', 'x-unbxd-key'
];

/** Query/body params whose values are secrets or PII. */
const DENY_PARAMS = [
  'key', 'apikey', 'api_key', 'token', 'access_token', 'auth', 'password',
  'secret', 'signature', 'sig', 'session', 'sid', 'email', 'phone'
];

/** Headers worth keeping: they carry the CORS / proxy / cache signal. */
const KEEP_HEADERS = [
  'content-type', 'origin', 'referer', 'host', 'user-agent',
  'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-request-method', 'access-control-request-headers',
  'x-cache', 'cf-ray', 'cf-cache-status', 'server', 'via', 'x-forwarded-for',
  'x-served-by', 'retry-after', 'location', 'content-length'
];

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (DENY_HEADERS.includes(name)) {
      out[name] = '[redacted]';
      continue;
    }
    if (!KEEP_HEADERS.includes(name)) continue;
    let value = String(rawValue);
    if (name === 'user-agent') value = value.slice(0, 120);
    out[name] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  return out;
}

export function redactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const [k] of [...url.searchParams]) {
      if (DENY_PARAMS.some((d) => k.toLowerCase().includes(d))) {
        // Plain token, not "[redacted]": brackets get percent-encoded and
        // make the URL harder for both the engineer and the model to read.
        url.searchParams.set(k, 'REDACTED');
      }
    }
    return url.toString();
  } catch {
    return String(rawUrl).slice(0, 300);
  }
}

/** Query params as a map, secrets redacted. Used for the search API call. */
export function redactedParams(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const out = {};
    for (const [k, v] of url.searchParams) {
      out[k] = DENY_PARAMS.some((d) => k.toLowerCase().includes(d))
        ? '[redacted]'
        : truncate(v, 160);
    }
    return out;
  } catch {
    return {};
  }
}

export function truncate(value, max = 300) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s == null) return '';
  return s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars]` : s;
}

/**
 * Describe the SHAPE of a JSON payload instead of forwarding it.
 * Arrays become `{ __array: n, sample: <shape of first item> }`, strings become
 * their type plus a short redacted sample, so the model can reason about
 * "empty / wrong field / wrong type" without receiving the catalogue data.
 */
export function shapeOf(value, depth = 0, opts = {}) {
  const { maxDepth = 4, maxKeys = 25, sampleStrings = true } = opts;
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= maxDepth) return `array(${value.length})`;
    return { __array: value.length, sample: value.length ? shapeOf(value[0], depth + 1, opts) : null };
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return 'object';
    const out = {};
    for (const key of Object.keys(value).slice(0, maxKeys)) {
      out[key] = shapeOf(value[key], depth + 1, opts);
    }
    const extra = Object.keys(value).length - maxKeys;
    if (extra > 0) out.__moreKeys = extra;
    return out;
  }
  if (typeof value === 'string') {
    return sampleStrings ? `string("${truncate(value, 40)}")` : 'string';
  }
  return typeof value;
}
