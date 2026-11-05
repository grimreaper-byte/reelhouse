import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { get, run, all, parseJson } from './db.js';
import { getSetting } from './settings.js';
import { tunnelClientAddress } from './remote/tunnel-identity.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'rh_session';
const SESSION_DAYS = 30;
// Apps (the Kodi add-on) stay signed in for a year after their last use; they can't show a sign-in page.
const DEVICE_DAYS = 365;
const DAY = 24 * 60 * 60 * 1000;

// ---------- passwords ----------

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 256) return 'Password is too long.';
  return null;
}

export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[\w.\- ]{1,40}$/.test(username.trim())) {
    return 'Usernames may contain letters, numbers, spaces, dots, dashes and underscores (max 40).';
  }
  return null;
}

// ---------- sessions ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Starts a session; `device` names an app's sign-in (e.g. "Kodi on Living Room TV"), which lasts longer, and
 * `tunnelPeer` ties an app tunnel key to it (the key goes when the sign-in does).
 */
export function createSession(userId, req, { device = null, tunnelPeer = null } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  run(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, device, tunnel_peer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    now,
    now,
    now + (device ? DEVICE_DAYS : SESSION_DAYS) * DAY,
    clientIp(req),
    String(req.headers['user-agent'] || '').slice(0, 300),
    device,
    tunnelPeer,
  );
  return token;
}

/** A user's app sign-ins, newest use first; `id` is a short, non-secret handle for signing one out. */
export function listDevices(userId) {
  return all('SELECT token_hash, device, created_at, last_seen_at, ip, tunnel_peer FROM sessions WHERE user_id = ? AND device IS NOT NULL ORDER BY last_seen_at DESC', userId)
    .map((s) => ({ id: s.token_hash.slice(0, 16), name: s.device, createdAt: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, tunnelPeer: s.tunnel_peer }));
}

export function removeDevice(userId, id) {
  if (!/^[0-9a-f]{16}$/.test(String(id))) return false;
  return run('DELETE FROM sessions WHERE user_id = ? AND device IS NOT NULL AND substr(token_hash, 1, 16) = ?', userId, id).changes > 0;
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function destroyOtherSessions(userId, keepToken) {
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, keepToken ? sha256(keepToken) : '');
}

export function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * DAY,
    path: '/',
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sessionToken(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.headers['x-reelhouse-token']) return String(req.headers['x-reelhouse-token']).trim();
  // Media players such as Kodi fetch artwork and video by plain URL, so reads may carry the token in the query.
  if ((req.method === 'GET' || req.method === 'HEAD') && typeof req.query?.['X-Reelhouse-Token'] === 'string') {
    return req.query['X-Reelhouse-Token'];
  }
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

export function loadUser(id) {
  const u = get(
    'SELECT id, username, is_admin, library_access, share_watching, avatar_at, stream_limit, live_tv, live_tv_record, live_tv_series, created_at FROM users WHERE id = ?',
    id,
  );
  return u ? toUser(u) : null;
}

function toUser(row) {
  return {
    id: row.id,
    username: row.username,
    isAdmin: !!row.is_admin,
    libraryAccess: parseJson(row.library_access, null),
    // What they watch shows on other people's Home ("Watched by Others").
    shareWatching: !!row.share_watching,
    // Their picture (the address changes with it, so it can be cached for good), or null.
    avatar: row.avatar_at ? `/api/users/${row.id}/avatar?v=${row.avatar_at}` : null,
    // How many devices they may play on at once (an admin sets it), or null for no limit.
    streamLimit: row.stream_limit || null,
    // Live TV (when it's turned on): watching it, scheduling recordings, and series recordings. Admins always may.
    liveTv: !!row.is_admin || !!row.live_tv,
    liveTvRecord: !!row.is_admin || (!!row.live_tv && !!row.live_tv_record),
    liveTvSeries: !!row.is_admin || (!!row.live_tv && !!row.live_tv_record && !!row.live_tv_series),
    createdAt: row.created_at,
  };
}

/** Who a session token belongs to right now (null once it has expired or been signed out). */
export function userForSession(token) {
  const s = token ? get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', sha256(token)) : null;
  return s && s.expires_at > Date.now() ? loadUser(s.user_id) : null;
}

// Express middleware: attaches req.user when a valid session (or play token) is present.
export function authenticate(req, res, next) {
  req.user = null;
  const token = sessionToken(req);
  if (token) {
    const hash = sha256(token);
    const s = get('SELECT user_id, last_seen_at, expires_at, device FROM sessions WHERE token_hash = ?', hash);
    const now = Date.now();
    if (s && s.expires_at > now) {
      req.user = loadUser(s.user_id);
      req.sessionToken = token;
      req.device = s.device; // an app's sign-in name (e.g. "Pixel 8"); null for a browser
      // Sliding expiry, written at most once an hour.
      if (now - s.last_seen_at > 60 * 60 * 1000) {
        run(
          'UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE token_hash = ?',
          now,
          now + (s.device ? DEVICE_DAYS : SESSION_DAYS) * DAY,
          clientIp(req),
          hash,
        );
      }
    } else if (s) {
      run('DELETE FROM sessions WHERE token_hash = ?', hash);
    }
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in', setupRequired: userCount() === 0 });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Mutating API calls must carry this header. Browsers won't send it cross-site without a CORS
// preflight (which we never approve), so together with SameSite cookies this blocks CSRF.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'reelhouse') {
    return res.status(403).json({ error: 'Missing request header' });
  }
  next();
}

export function userCount() {
  return get('SELECT COUNT(*) AS n FROM users').n;
}

export function pruneSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}

// ---------- library access ----------

export function allowedLibraryIds(user) {
  const ids = all('SELECT id FROM libraries').map((r) => r.id);
  if (!user || user.isAdmin || !Array.isArray(user.libraryAccess)) return ids;
  const allowed = new Set(user.libraryAccess);
  return ids.filter((id) => allowed.has(id));
}

export function canAccessLibrary(user, libraryId) {
  return allowedLibraryIds(user).includes(libraryId);
}

// ---------- play tokens ----------
// Signed, short-lived tokens embedded in media URLs so external players (VLC, downloads,
// Safari's native player) can fetch a stream without the session cookie.

export function signPlayToken(userId, itemId, ttlSeconds = 12 * 60 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${userId}.${itemId}.${exp}`;
  const sig = crypto.createHmac('sha256', getSetting('secret')).update(payload).digest('base64url');
  return `${userId}.${exp}.${sig}`;
}

export function verifyPlayToken(token, itemId) {
  if (typeof token !== 'string') return null;
  const [userId, exp, sig] = token.split('.');
  if (!userId || !exp || !sig) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  const payload = `${userId}.${itemId}.${exp}`;
  const expected = crypto.createHmac('sha256', getSetting('secret')).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return loadUser(Number(userId));
}

// ---------- login throttling ----------

const failures = new Map(); // ip -> { count, until, last }
const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

export function loginBlocked(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (f.until && f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  if (f.until && f.until <= Date.now()) failures.delete(ip);
  return 0;
}

export function recordLoginFailure(ip) {
  const now = Date.now();
  // Forget stale entries so many distinct attackers can't grow this map without bound.
  if (failures.size > 1000) {
    for (const [key, v] of failures) if (v.until < now && now - v.last > LOCKOUT_MS) failures.delete(key);
  }
  const f = failures.get(ip) || { count: 0, until: 0, last: 0 };
  f.count++;
  f.last = now;
  if (f.count >= MAX_FAILURES) {
    f.until = now + LOCKOUT_MS;
    f.count = 0;
  }
  failures.set(ip, f);
}

export function clearLoginFailures(ip) {
  failures.delete(ip);
}

// ---------- network helpers ----------

export function clientIp(req) {
  // Through the app tunnel, the device's tunnel address is the client's address.
  const tunnelled = tunnelClientAddress(req);
  if (tunnelled) return tunnelled;
  const ip = (getSetting('trustProxy') ? req.ip : req.socket?.remoteAddress) || '';
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isPrivateIp(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function ipInCidr(ip, cidr) {
  if (!ip || !cidr || ip.includes(':')) return false;
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const toInt = (s) => s.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}
