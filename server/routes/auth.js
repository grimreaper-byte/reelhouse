import { Router } from 'express';
import crypto from 'node:crypto';
import { get, run, all } from '../db.js';
import {
  hashPassword, verifyPassword, validatePassword, validateUsername, createSession, destroySession,
  destroyOtherSessions, setSessionCookie, clearSessionCookie, requireUser, requireAdmin, userCount, loadUser, clientIp,
  isPrivateIp, ipInCidr, loginBlocked, recordLoginFailure, clearLoginFailures, listDevices, removeDevice,
} from '../auth.js';
import { appDefaults, getSetting, serverId } from '../settings.js';
import { appInfo } from '../android.js';
import { VERSION } from '../version.js';
import { tunnelClientAddress } from '../remote/tunnel-identity.js';
import { cleanupPeers, peerLastHandshake, syncPeers, refreshTunnelStatus } from '../remote/apptunnel.js';
import { createPairing, redeemPairing, pairingStatus, cancelPairing, currentTunnelSettings, isWireGuardKey } from '../pairing.js';
import { logger } from '../lib/log.js';
import { saveAvatar, removeAvatar, avatarPath, AvatarError, MAX_AVATAR_BYTES } from '../avatars.js';
import { liveTvChanged } from '../events.js';
import { liveTvFor } from '../livetv/guide.js';
import { endSeriesOf } from '../livetv/recordings.js';
import { requestsAccess } from '../requests.js';

const log = logger('auth');

const router = Router();

function networkInfo(req) {
  const ip = clientIp(req);
  const wgSubnet = getSetting('wireguard').subnet;
  const viaWireguard = getSetting('wireguard').enabled && ipInCidr(ip, wgSubnet);
  // App tunnel addresses are private too, but the device is away from home.
  const viaTunnel = !!tunnelClientAddress(req);
  return { ip, local: isPrivateIp(ip) && !viaWireguard && !viaTunnel, wireguard: viaWireguard, tunnel: viaTunnel };
}

// Stable for this install and safe to show: apps compare it to tell their Reelhouse from another server that happens
// to answer at the same home address on a different network.

router.get('/server', (req, res) => {
  res.json({
    id: serverId(),
    name: getSetting('serverName'),
    version: VERSION,
    setupRequired: userCount() === 0,
    network: networkInfo(req),
  });
});

// First-run: create the admin account. Only allowed from the local network so a server that is
// already exposed to the internet can't be claimed by a stranger.
router.post('/setup', async (req, res) => {
  if (userCount() > 0) return res.status(409).json({ error: 'Setup has already been completed' });
  if (!isPrivateIp(clientIp(req)) || tunnelClientAddress(req)) {
    return res.status(403).json({ error: 'Initial setup must be done from the local network' });
  }
  const { username, password } = req.body || {};
  const err = validateUsername(username) || validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  const hash = await hashPassword(password);
  if (userCount() > 0) return res.status(409).json({ error: 'Setup has already been completed' });
  const r = run(
    'INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, 1, ?)',
    username.trim(),
    hash,
    Date.now(),
  );
  const token = createSession(Number(r.lastInsertRowid), req);
  setSessionCookie(req, res, token);
  res.json({ user: loadUser(Number(r.lastInsertRowid)) });
});

/** Checks a username/password sign-in (rate-limited per IP). Sends the error itself and returns null on failure. */
async function checkCredentials(req, res) {
  const ip = clientIp(req);
  const wait = loginBlocked(ip);
  if (wait) {
    res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
    return null;
  }
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Username and password are required' });
    return null;
  }
  const row = get('SELECT id, password_hash FROM users WHERE username = ?', username.trim());
  // Always run a hash check so response timing doesn't reveal which usernames exist.
  const ok = await verifyPassword(password, row?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
  if (!row || !ok) {
    recordLoginFailure(ip);
    res.status(401).json({ error: 'Incorrect username or password' });
    return null;
  }
  clearLoginFailures(ip);
  return row;
}

router.post('/auth/login', async (req, res) => {
  const row = await checkCredentials(req, res);
  if (!row) return;
  const token = createSession(row.id, req);
  setSessionCookie(req, res, token);
  res.json({ user: loadUser(row.id) });
});

// Apps such as the Kodi add-on sign in once and keep a token (sent as "Authorization: Bearer …", an
// "X-Reelhouse-Token" header, or ?X-Reelhouse-Token= on media URLs). Each shows up under Account → Devices.
router.post('/auth/device', async (req, res) => {
  const device = String(req.body?.device || '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'A device name is required' });
  const row = await checkCredentials(req, res);
  if (!row) return;
  const token = createSession(row.id, req, { device });
  res.json({ token, user: loadUser(row.id), server: { name: getSetting('serverName'), version: VERSION } });
});

router.get('/me/devices', requireUser, async (req, res) => {
  const list = listDevices(req.user.id);
  if (list.some((d) => d.tunnelPeer)) await refreshTunnelStatus();
  const devices = list.map(({ tunnelPeer, ...d }) => ({
    ...d,
    tunnel: !!tunnelPeer,
    tunnelHandshakeAt: tunnelPeer ? peerLastHandshake(tunnelPeer) : null,
  }));
  res.json({ devices });
});

router.delete('/me/devices/:id', requireUser, (req, res) => {
  if (!removeDevice(req.user.id, req.params.id)) return res.status(404).json({ error: 'No such device' });
  cleanupPeers(); // its app tunnel key goes with it
  res.json({ ok: true });
});

// Pairing the Reelhouse app: a one-time code (and QR code) for a phone to sign in with, through the app tunnel if
// it's on. See server/pairing.js.
router.post('/me/pairings', requireUser, async (req, res) => {
  res.json(await createPairing(req.user, req));
});

router.get('/me/pairings/:id', requireUser, (req, res) => res.json(pairingStatus(req.user.id, req.params.id)));

router.delete('/me/pairings/:id', requireUser, (req, res) => res.json({ cancelled: cancelPairing(req.user.id, req.params.id) }));

// A paired app's current tunnel settings. The public address (or port) can change after pairing, e.g. when the home
// IP changes without dynamic DNS, so the app asks again whenever it reaches Reelhouse. null: no tunnel for it.
router.get('/me/tunnel', requireUser, async (req, res) => {
  const hash = crypto.createHash('sha256').update(String(req.sessionToken)).digest('hex');
  const session = get('SELECT tunnel_peer FROM sessions WHERE token_hash = ?', hash);
  res.json({ tunnel: session?.tunnel_peer ? await currentTunnelSettings(session.tunnel_peer) : null });
});

router.post('/auth/pair', (req, res) => {
  const ip = clientIp(req);
  const wait = loginBlocked(ip);
  if (wait) return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
  const device = String(req.body?.device || '').trim().slice(0, 80);
  if (!device) return res.status(400).json({ error: 'A device name is required' });
  const publicKey = req.body?.publicKey ?? null;
  if (publicKey !== null && !isWireGuardKey(publicKey)) return res.status(400).json({ error: 'publicKey must be a WireGuard public key' });
  if (publicKey && get('SELECT 1 FROM tunnel_peers WHERE public_key = ?', publicKey)) {
    return res.status(400).json({ error: 'That key is already in use' });
  }
  const result = redeemPairing(req.body?.code, device, req, publicKey);
  if (!result) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'That pairing code is wrong, already used or expired. Make a new one in Reelhouse.' });
  }
  clearLoginFailures(ip);
  res.json({ token: result.token, user: result.user, tunnel: result.tunnel, server: { name: getSetting('serverName'), version: VERSION } });
});

// Exported for tests: how long a signed-out device's tunnel key outlives its sign-in.
export const LOGOUT_KEY_GRACE_MS = 1500;

router.post('/auth/logout', (req, res) => {
  destroySession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
  // The app may be signing out through its own app tunnel: removing its key straight away would cut off this very
  // answer (the app then waits until it gives up). The sign-in is already gone, so the key is useless meanwhile.
  setTimeout(cleanupPeers, LOGOUT_KEY_GRACE_MS).unref();
});

router.get('/me', requireUser, async (req, res) => {
  const [app, liveTv] = await Promise.all([appInfo(), liveTvFor(req.user)]);
  res.json({
    user: req.user,
    network: networkInfo(req),
    defaults: appDefaults(),
    // Live TV for this account: { available, canRecord } (Settings → Live TV and the account's switches).
    liveTv,
    // Requests: whether an admin has it on, how many films are asked for, and whether films can be asked for (TMDB is
    // set up). See server/requests.js.
    requests: requestsAccess(),
    // The Android app on offer at /android/, so the app can offer its own update.
    androidApp: app && { versionName: app.versionName, versionCode: app.versionCode, size: app.size, fileName: app.fileName },
  });
});

// Your own preferences: { shareWatching } (whether what you watch shows on other people's Home).
router.patch('/me', requireUser, (req, res) => {
  const { shareWatching } = req.body || {};
  if (typeof shareWatching !== 'boolean') return res.status(400).json({ error: 'shareWatching must be true or false' });
  run('UPDATE users SET share_watching = ? WHERE id = ?', shareWatching ? 1 : 0, req.user.id);
  res.json({ user: loadUser(req.user.id) });
});

// Your picture: the image file itself is the body (not JSON). It's checked and redrawn before it's kept
// (server/avatars.js); the answer is your account with its new `avatar` address.
router.put('/me/avatar', requireUser, async (req, res) => {
  // Refused before reading when it says it's too big; saveAvatar counts the bytes as well, for uploads that don't say.
  if (Number(req.headers['content-length']) > MAX_AVATAR_BYTES) {
    return res.status(400).json({ error: `That picture is over ${MAX_AVATAR_BYTES / 1024 / 1024} MB. Choose a smaller one.` });
  }
  try {
    await saveAvatar(req.user.id, req);
  } catch (err) {
    if (!(err instanceof AvatarError)) throw err;
    req.resume(); // the rest of a refused upload
    return res.status(400).json({ error: err.message });
  }
  res.json({ user: loadUser(req.user.id) });
});

router.delete('/me/avatar', requireUser, async (req, res) => {
  await removeAvatar(req.user.id);
  res.json({ user: loadUser(req.user.id) });
});

// Anyone signed in can see people's pictures (the Users list, Watched by Others). The address carries ?v=, so
// a new picture is a new address and this one can be kept.
router.get('/users/:id/avatar', requireUser, async (req, res) => {
  const file = await avatarPath(Number(req.params.id));
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(file, { cacheControl: false, dotfiles: 'allow', headers: { 'Content-Type': 'image/jpeg' } });
});

router.post('/me/password', requireUser, async (req, res) => {
  const { current, next } = req.body || {};
  const row = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!(await verifyPassword(String(current || ''), row.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const err = validatePassword(next);
  if (err) return res.status(400).json({ error: err });
  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(next), req.user.id);
  destroyOtherSessions(req.user.id, req.sessionToken);
  cleanupPeers();
  res.json({ ok: true });
});

// ---------- user management (admin) ----------

const publicUser = (u) => ({ ...u, sessions: get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', u.id).n });

router.get('/users', requireAdmin, (req, res) => {
  const ids = all('SELECT id FROM users ORDER BY is_admin DESC, username COLLATE NOCASE').map((r) => r.id);
  res.json({ users: ids.map((id) => publicUser(loadUser(id))) });
});

/** How many devices a new account may play on at once unless an admin chooses otherwise (as the database's default). */
export const DEFAULT_STREAM_LIMIT = 2;

/** A stream limit as stored: null (no limit) or 1–20 devices at once. */
function validStreamLimit(value) {
  if (value == null || value === '' || value === 0) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('The stream limit must be a whole number from 1 to 20, or none');
  return n;
}

function validAccess(libraryAccess) {
  if (libraryAccess == null) return null;
  if (!Array.isArray(libraryAccess)) throw new Error('libraryAccess must be a list of library ids or null');
  return JSON.stringify(libraryAccess.map(Number).filter(Number.isInteger));
}

router.post('/users', requireAdmin, async (req, res) => {
  const {
    username, password, isAdmin = false, libraryAccess = null, streamLimit = DEFAULT_STREAM_LIMIT, liveTv = true, liveTvRecord = false,
    liveTvSeries = false,
  } = req.body || {};
  const err = validateUsername(username) || validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  if (get('SELECT 1 FROM users WHERE username = ?', username.trim())) {
    return res.status(409).json({ error: 'That username is taken' });
  }
  let access;
  let limit;
  try {
    access = validAccess(libraryAccess);
    limit = validStreamLimit(streamLimit);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const r = run(
    'INSERT INTO users (username, password_hash, is_admin, library_access, stream_limit, live_tv, live_tv_record, live_tv_series, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    username.trim(),
    await hashPassword(password),
    isAdmin ? 1 : 0,
    access,
    limit,
    liveTv ? 1 : 0,
    liveTv && liveTvRecord ? 1 : 0,
    liveTv && liveTvRecord && liveTvSeries ? 1 : 0,
    Date.now(),
  );
  res.json({ user: publicUser(loadUser(Number(r.lastInsertRowid))) });
});

const adminCount = () => get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').n;

router.patch('/users/:id', requireAdmin, async (req, res) => {
  const user = loadUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user' });
  const { password, isAdmin, libraryAccess, username, streamLimit, liveTv, liveTvRecord, liveTvSeries } = req.body || {};
  let limit;
  try {
    if (streamLimit !== undefined) limit = validStreamLimit(streamLimit);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (username !== undefined && username.trim() !== user.username) {
    const err = validateUsername(username);
    if (err) return res.status(400).json({ error: err });
    if (get('SELECT 1 FROM users WHERE username = ? AND id != ?', username.trim(), user.id)) {
      return res.status(409).json({ error: 'That username is taken' });
    }
    run('UPDATE users SET username = ? WHERE id = ?', username.trim(), user.id);
  }
  if (password) {
    const err = validatePassword(password);
    if (err) return res.status(400).json({ error: err });
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
    run('DELETE FROM sessions WHERE user_id = ?', user.id);
    cleanupPeers();
  }
  if (isAdmin !== undefined) {
    if (!isAdmin && user.isAdmin && adminCount() <= 1) {
      return res.status(400).json({ error: 'There must be at least one admin' });
    }
    run('UPDATE users SET is_admin = ? WHERE id = ?', isAdmin ? 1 : 0, user.id);
  }
  if (libraryAccess !== undefined) {
    try {
      run('UPDATE users SET library_access = ? WHERE id = ?', validAccess(libraryAccess), user.id);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  if (streamLimit !== undefined) run('UPDATE users SET stream_limit = ? WHERE id = ?', limit, user.id);
  if (liveTv !== undefined || liveTvRecord !== undefined || liveTvSeries !== undefined) {
    const row = get('SELECT live_tv, live_tv_record, live_tv_series FROM users WHERE id = ?', user.id);
    const watch = liveTv !== undefined ? !!liveTv : !!row.live_tv;
    const record = watch && (liveTvRecord !== undefined ? !!liveTvRecord : !!row.live_tv_record);
    const series = record && (liveTvSeries !== undefined ? !!liveTvSeries : !!row.live_tv_series);
    run('UPDATE users SET live_tv = ?, live_tv_record = ?, live_tv_series = ? WHERE id = ?', watch ? 1 : 0, record ? 1 : 0, series ? 1 : 0, user.id);
    // Their open pages show or hide Live TV.
    liveTvChanged(user.id);
  }
  res.json({ user: publicUser(loadUser(user.id)) });
});

router.delete('/users/:id', requireAdmin, async (req, res) => {
  const user = loadUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user' });
  if (user.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  if (user.isAdmin && adminCount() <= 1) return res.status(400).json({ error: 'There must be at least one admin' });
  await endSeriesOf(user.id);
  run('DELETE FROM users WHERE id = ?', user.id);
  syncPeers(); // their app tunnel keys went with the account
  await removeAvatar(user.id);
  res.json({ ok: true });
});

router.post('/users/:id/signout', requireAdmin, (req, res) => {
  run('DELETE FROM sessions WHERE user_id = ?', Number(req.params.id));
  cleanupPeers();
  res.json({ ok: true });
});

// Pairing the Reelhouse app for someone else (Settings → Users), without signing in as them: the same one-time code
// and QR code they'd make in Your account. Admins can set anyone's password anyway, so this gives them nothing new.
router.post('/users/:id/pairings', requireAdmin, async (req, res) => {
  const user = loadUser(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'No such user' });
  log.info(`Admin "${req.user.username}" made a pairing code for "${user.username}"`);
  res.json(await createPairing(user, req));
});

router.get('/users/:id/pairings/:pid', requireAdmin, (req, res) => res.json(pairingStatus(Number(req.params.id), req.params.pid)));

router.delete('/users/:id/pairings/:pid', requireAdmin, (req, res) => res.json({ cancelled: cancelPairing(Number(req.params.id), req.params.pid) }));

export default router;
