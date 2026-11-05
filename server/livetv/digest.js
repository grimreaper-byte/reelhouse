// HTTP Digest authentication (RFC 7616, and RFC 2617's form without an algorithm), as Tvheadend asks for by default.
// Node's fetch only does Basic, which Tvheadend's "Plain" mode takes; Digest also covers its SHA-256 and SHA-512/256
// settings.
import crypto from 'node:crypto';

const HASHES = { 'MD5': 'md5', 'SHA-256': 'sha256', 'SHA-512-256': 'sha512-256' };
// The strongest first, when a server offers several.
const PREFERENCE = ['SHA-512-256', 'SHA-256', 'MD5'];

/**
 * The challenges in a WWW-Authenticate header: [{ scheme: 'digest' | 'basic' | …, params: { realm, nonce, … } }].
 * fetch joins several headers into one with ", ", so a new challenge starts wherever a scheme name is followed by a
 * parameter (`Digest realm=…`).
 */
export function parseChallenges(header) {
  const text = String(header || '');
  const starts = [...text.matchAll(/(?:^|,)\s*([A-Za-z][\w-]*)\s+(?=[\w-]+=)/g)].map((m) => ({ index: m.index, scheme: m[1] }));
  return starts.map((s, i) => {
    const body = text.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : text.length);
    const params = {};
    const afterScheme = body.slice(body.indexOf(s.scheme) + s.scheme.length);
    for (const m of afterScheme.matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
      params[m[1].toLowerCase()] = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : m[3];
    }
    return { scheme: s.scheme.toLowerCase(), params };
  });
}

/** The Digest challenge to answer (the strongest algorithm we can do), or null. */
export function pickDigest(challenges) {
  const digests = challenges.filter((c) => c.scheme === 'digest' && c.params.nonce);
  const algo = (c) => String(c.params.algorithm || 'MD5').toUpperCase().replace(/-SESS$/, '').replace('SHA-512/256', 'SHA-512-256');
  for (const name of PREFERENCE) {
    const hit = digests.find((c) => algo(c) === name);
    if (hit) return hit;
  }
  return null;
}

const quote = (v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;

/**
 * The Authorization header answering a Digest challenge's params for one request. `nc` counts the requests made with
 * this nonce (1, 2, …); `cnonce` is random unless given (tests).
 */
export function digestAuthorization({ params, username, password, method, uri, nc = 1, cnonce = crypto.randomBytes(16).toString('hex') }) {
  const algorithm = String(params.algorithm || 'MD5');
  const base = algorithm.toUpperCase().replace(/-SESS$/, '').replace('SHA-512/256', 'SHA-512-256');
  const hashName = HASHES[base];
  if (!hashName) throw new Error(`Unsupported Digest algorithm ${algorithm}`);
  const H = (s) => crypto.createHash(hashName).update(s).digest('hex');
  const qop = String(params.qop || '').split(',').map((q) => q.trim()).find((q) => q === 'auth');
  const ncHex = nc.toString(16).padStart(8, '0');
  let ha1 = H(`${username}:${params.realm}:${password}`);
  if (/-sess$/i.test(algorithm)) ha1 = H(`${ha1}:${params.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const response = qop ? H(`${ha1}:${params.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${params.nonce}:${ha2}`);
  const parts = [
    `username=${quote(username)}`, `realm=${quote(params.realm)}`, `nonce=${quote(params.nonce)}`, `uri=${quote(uri)}`,
    `algorithm=${algorithm}`, `response=${quote(response)}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce=${quote(cnonce)}`);
  if (params.opaque != null) parts.push(`opaque=${quote(params.opaque)}`);
  return `Digest ${parts.join(', ')}`;
}

export const basicAuthorization = (username, password) => `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
