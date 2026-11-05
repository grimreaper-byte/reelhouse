// Pairing the Reelhouse app. A signed-in user asks for a one-time code (10 minutes, single use). It travels in a QR
// code together with the server's addresses and, when the app tunnel is on, a tunnel key made for that device.
// The app brings the tunnel up from the QR code, then swaps the code for its own device sign-in through it.
//
// The QR code holds reelhouse://pair?d=<base64url JSON>:
//   { v: 1, server, id, code, expiresAt, urls: [direct addresses], tunnel: { endpoint, publicKey, privateKey,
//     presharedKey, address, url } | null }
// `id` is the server's id (GET /api/server): the app pairs at a direct address only where that same id answers.
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { all, get, run, tx } from './db.js';
import { getSetting, serverId } from './settings.js';
import { createSession, loadUser, ipInCidr } from './auth.js';
import {
  createPeer, confirmPeer, removePeer, ensureKeys, endpointHost, resolveEndpointHost, tunnelAddress, syncPeers, appTunnelRunning,
} from './remote/apptunnel.js';
import { tunnelClientAddress } from './remote/tunnel-identity.js';
import { lanAddresses } from './remote/net.js';
import { fullHostname } from './remote/ddns.js';
import { addressesReachable } from './lib/platform.js';
import { appInfo } from './android.js';

export const PAIRING_MINUTES = 10;
export const MAX_OPEN_PAIRINGS = 3;
// No 0/O, 1/I/L or U: easy to read out and type.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

function newCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

/** Addresses the app (or Kodi) can try directly (at home, or the HTTPS address), best first. */
export function directAddresses(req) {
  const urls = [];
  const add = (u) => {
    if (u && !urls.includes(u)) urls.push(u);
  };
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '');
  // The address this page was opened at, unless that's this machine itself or the app tunnel.
  if (host && !/^(localhost|127\.|\[::1\])/i.test(host) && !ipInCidr(hostname, getSetting('appTunnel').subnet)) {
    add(`${req.protocol}://${host}`);
  }
  // In a container on its own network these are the container's addresses, which no phone can reach; with the
  // host's network (network_mode: host) they're the host's.
  if (addressesReachable()) {
    for (const a of lanAddresses()) if (!a.wireguard) add(`http://${a.address}:${getSetting('port')}`);
  }
  const https = getSetting('https');
  const name = https.domain || fullHostname();
  if (https.mode !== 'off' && name) add(`https://${name}:${Number(getSetting('upnp').externalPort) || https.port}`);
  return urls;
}

/** Starts a pairing for this user. Returns what the pairing screen shows. */
export async function createPairing(user, req) {
  const now = Date.now();
  // Each open pairing holds a tunnel address for 10 minutes: a few per user, so nobody can use them all up.
  const open = all('SELECT id FROM pairings WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC', user.id, now);
  for (const p of open.slice(MAX_OPEN_PAIRINGS - 1)) cancelPairing(user.id, p.id);
  const expiresAt = now + PAIRING_MINUTES * 60 * 1000;
  const code = newCode();
  const display = `${code.slice(0, 4)}-${code.slice(4)}`;
  const cfg = getSetting('appTunnel');
  const warnings = [];
  let tunnel = null;
  let peerId = null;
  if (cfg.enabled) {
    const host = await resolveEndpointHost(cfg);
    if (!appTunnelRunning()) warnings.push('The app tunnel isn’t running right now (see Settings → Remote access), so away from home the app can’t connect yet.');
    const peer = createPeer(user.id, `${user.username}'s Reelhouse app (pairing)`, expiresAt);
    peerId = peer.id;
    tunnel = {
      endpoint: host ? `${host}:${cfg.listenPort}` : null,
      publicKey: ensureKeys().publicKey,
      privateKey: peer.privateKey,
      presharedKey: peer.presharedKey,
      address: peer.address,
      url: `http://${tunnelAddress(cfg)}`,
    };
    if (!host) warnings.push('Reelhouse doesn’t know its public address yet, so the app can only connect at home. Set it in Settings → Remote access → App tunnel.');
  }
  const id = crypto.randomBytes(8).toString('hex');
  run(
    'INSERT INTO pairings (code_hash, id, user_id, created_at, expires_at, tunnel_peer) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(code), id, user.id, now, expiresAt, peerId,
  );
  const payload = { v: 1, server: getSetting('serverName'), id: serverId(), code: display, expiresAt, urls: directAddresses(req), tunnel };
  const link = `reelhouse://pair?d=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  // Shown on a screen, so the lowest error correction keeps the code as coarse (easy to scan) as possible.
  const qr = await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'L', margin: 1 });
  return { id, code: display, expiresAt, link, qr, tunnel: !!tunnel, urls: payload.urls, warnings, app: await appDownload(payload.urls) };
}

/** Where a phone at home can download the app (/android/), with a QR code for its camera; null without an APK. */
async function appDownload(urls) {
  const info = await appInfo();
  if (!info) return null;
  const base = urls.find((u) => u.startsWith('http://')) || urls[0];
  if (!base) return { versionName: info.versionName, url: null, qr: null };
  const url = `${base}/android/`;
  return { versionName: info.versionName, url, qr: await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'L', margin: 1 }) };
}

/** Cancels a user's unused pairing (its pairing screen was closed): the code stops working, its tunnel key goes. */
export function cancelPairing(userId, id) {
  const p = get('SELECT tunnel_peer FROM pairings WHERE id = ? AND user_id = ? AND used_at IS NULL', String(id), userId);
  if (!p) return false;
  run('DELETE FROM pairings WHERE id = ?', String(id));
  if (p.tunnel_peer) removePeer(p.tunnel_peer);
  return true;
}

/** Whether a user's pairing has been used yet: { status: 'waiting' | 'used' | 'expired', device }. */
export function pairingStatus(userId, id) {
  const p = get('SELECT expires_at, used_at, device FROM pairings WHERE id = ? AND user_id = ?', String(id), userId);
  if (!p) return { status: 'expired', device: null };
  if (p.used_at) return { status: 'used', device: p.device };
  return { status: p.expires_at < Date.now() ? 'expired' : 'waiting', device: null };
}

export const isWireGuardKey = (key) => typeof key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(key);

/** The device's tunnel settings, minus its private key (which only the device has). */
function tunnelSettings(peerId, host = endpointHost()) {
  const peer = peerId && get('SELECT preshared_key, address FROM tunnel_peers WHERE id = ?', peerId);
  if (!peer) return null;
  const cfg = getSetting('appTunnel');
  return {
    endpoint: host ? `${host}:${cfg.listenPort}` : null,
    publicKey: cfg.publicKey,
    presharedKey: peer.preshared_key,
    address: peer.address,
    url: `http://${tunnelAddress(cfg)}`,
  };
}

/**
 * A paired device's current tunnel settings: the public address (or port) may have changed since pairing, so the
 * app asks again whenever it's connected (GET /api/me/tunnel).
 */
export async function currentTunnelSettings(peerId) {
  if (!getSetting('appTunnel').enabled) return null;
  return tunnelSettings(peerId, await resolveEndpointHost());
}

/**
 * Swaps a pairing code for a device sign-in. Returns { token, user, tunnel } (tunnel: the device's tunnel
 * settings, or null) or null when the code is wrong, expired or already used.
 *
 * `publicKey`: a key pair the app made itself. Then its private key never leaves the phone and the one in the QR
 * code is never used. Only taken when the code comes directly (at home); through the tunnel, swapping the key would
 * cut the connection the answer goes back on.
 */
export function redeemPairing(code, device, req, publicKey = null) {
  const hash = sha256(normalizeCode(code));
  const ownKey = publicKey && !tunnelClientAddress(req) ? publicKey : null;
  const result = tx(() => {
    const pairing = get('SELECT * FROM pairings WHERE code_hash = ? AND used_at IS NULL', hash);
    if (!pairing || pairing.expires_at < Date.now()) return null;
    run('UPDATE pairings SET used_at = ?, device = ? WHERE code_hash = ?', Date.now(), device, hash);
    const user = loadUser(pairing.user_id);
    if (!user) return null;
    if (pairing.tunnel_peer) {
      confirmPeer(pairing.tunnel_peer, device);
      if (ownKey) run('UPDATE tunnel_peers SET public_key = ? WHERE id = ?', ownKey, pairing.tunnel_peer);
    }
    const token = createSession(user.id, req, { device, tunnelPeer: pairing.tunnel_peer });
    return { token, user, tunnel: tunnelSettings(pairing.tunnel_peer) };
  });
  if (result?.tunnel && ownKey) syncPeers();
  return result;
}
