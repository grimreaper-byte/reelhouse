// The app tunnel: a WireGuard endpoint built into Reelhouse for its apps. The tunnel/ helper (Go: wireguard-go in
// userspace with gVisor's network stack) does the WireGuard part and answers only HTTP, which it passes to
// Reelhouse. This module gives it its key and the device list (live, no restart), keeps it running, and recognises
// the requests it passes on: they carry a secret that changes on every start, and the device's tunnel address,
// which then counts as the client's address.
//
// Each paired device has its own key (tunnel_peers), tied to its sign-in: when the sign-in goes, so does the key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { all, get, run } from '../db.js';
import { getSetting, updateSettings, settingsEvents } from '../settings.js';
import { ROOT_DIR } from '../lib/paths.js';
import { logger } from '../lib/log.js';
import { generateKeyPair, parseSubnet } from './wireguard.js';
import { fullHostname } from './ddns.js';
import { lastKnownPublicIp, publicIp } from './net.js';
import { setTunnelSecret } from './tunnel-identity.js';

const log = logger('tunnel');
const RESTART_DELAYS = [2000, 5000, 15000, 60000];
const CLEANUP_EVERY = 60 * 1000;

let child = null;
let secret = null;
let httpPort = null;
let running = false;
let lastError = null;
let restartTimer = null;
let restarts = 0;
let peerStatus = new Map(); // public key → { lastHandshake, endpoint, rxBytes, txBytes }
let statusWaiters = [];
let cleanupTimer = null;

export function helperPath() {
  if (process.env.REELHOUSE_TUNNEL_BIN) return process.env.REELHOUSE_TUNNEL_BIN;
  return path.join(ROOT_DIR, 'tunnel', 'bin', process.platform === 'win32' ? 'reelhouse-tunnel.exe' : 'reelhouse-tunnel');
}

export const helperInstalled = () => fs.existsSync(helperPath());

/** The endpoint's own address inside the tunnel (the first in the subnet), which apps open Reelhouse at. */
export function tunnelAddress(cfg = getSetting('appTunnel')) {
  const s = parseSubnet(cfg.subnet);
  return s.toIp(s.network + 1);
}

/** The address devices reach the tunnel at from outside: set by hand, else the dynamic DNS name or public IP. */
export function endpointHost(cfg = getSetting('appTunnel')) {
  return cfg.endpoint?.trim() || fullHostname() || lastKnownPublicIp() || '';
}

/**
 * Like endpointHost, but looks the public IP up when nothing else gives an address: it's otherwise only known after
 * something asked for it (the Remote access page, dynamic DNS), e.g. not right after a restart.
 */
export async function resolveEndpointHost(cfg = getSetting('appTunnel')) {
  const named = cfg.endpoint?.trim() || fullHostname();
  if (named) return named;
  try {
    const ip = await Promise.race([publicIp(), new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
    return ip || lastKnownPublicIp() || '';
  } catch {
    return lastKnownPublicIp() || '';
  }
}

export const appTunnelRunning = () => running;

export function ensureKeys() {
  const cfg = getSetting('appTunnel');
  if (cfg.privateKey) return cfg;
  const kp = generateKeyPair();
  updateSettings({ appTunnel: { privateKey: kp.privateKey, publicKey: kp.publicKey } });
  return getSetting('appTunnel');
}

function nextAddress(cfg) {
  const s = parseSubnet(cfg.subnet);
  const used = new Set(all('SELECT address FROM tunnel_peers').map((r) => r.address));
  for (let i = 2; i < s.size - 1; i++) {
    const ip = s.toIp(s.network + i);
    if (!used.has(ip)) return ip;
  }
  throw new Error('No free addresses left in the app tunnel subnet');
}

/**
 * Adds a device key. Returns the device's side of it, including its private key, which isn't stored: it goes into
 * the pairing QR code once. A pending key (`pendingUntil`) is dropped if no device signs in with it by then.
 */
export function createPeer(userId, name, pendingUntil = null) {
  const cfg = ensureKeys();
  const kp = generateKeyPair();
  const peer = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || 'Reelhouse app').slice(0, 80),
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    presharedKey: crypto.randomBytes(32).toString('base64'),
    address: nextAddress(cfg),
  };
  run(
    'INSERT INTO tunnel_peers (id, user_id, name, public_key, preshared_key, address, created_at, pending_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    peer.id, userId, peer.name, peer.publicKey, peer.presharedKey, peer.address, Date.now(), pendingUntil,
  );
  pushPeers();
  return peer;
}

/** A pending key now belongs to a signed-in device. */
export function confirmPeer(id, name) {
  run('UPDATE tunnel_peers SET pending_until = NULL, name = COALESCE(?, name) WHERE id = ?', name ? String(name).slice(0, 80) : null, id);
}

export function removePeer(id) {
  if (run('DELETE FROM tunnel_peers WHERE id = ?', id).changes) pushPeers();
}

/**
 * Drops expired pairings, keys whose pairing was never used, and keys whose sign-in is gone (signed out, expired,
 * password changed, user deleted). Runs every minute and after anything that ends sign-ins.
 */
export function cleanupPeers() {
  const now = Date.now();
  run('DELETE FROM pairings WHERE expires_at < ?', now);
  const gone = run(
    `DELETE FROM tunnel_peers
     WHERE (pending_until IS NOT NULL AND pending_until < ?)
        OR (pending_until IS NULL AND id NOT IN (SELECT tunnel_peer FROM sessions WHERE tunnel_peer IS NOT NULL AND expires_at > ?))`,
    now, now,
  ).changes;
  if (gone) pushPeers();
  return gone;
}

function peerList() {
  return all('SELECT public_key, preshared_key, address FROM tunnel_peers')
    .map((p) => ({ publicKey: p.public_key, presharedKey: p.preshared_key, address: p.address }));
}

// Also while the helper is still starting: it reads commands once it's up, so nothing sent meanwhile is lost.
function send(message) {
  if (child) child.stdin.write(`${JSON.stringify(message)}\n`);
}

function pushPeers() {
  send({ op: 'peers', peers: peerList() });
}

/** Sends the current device list to the endpoint (after keys were removed some other way, e.g. a deleted user). */
export const syncPeers = pushPeers;

// ---------- the helper process ----------

/** Starts (or restarts) the endpoint for Reelhouse's HTTP port, if it's turned on. */
export function startAppTunnel(port) {
  httpPort = Number(port);
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupPeers, CLEANUP_EVERY);
    cleanupTimer.unref();
    settingsEvents.on('change', (changed) => {
      if ('port' in changed) httpPort = Number(getSetting('port'));
      // Only what the running endpoint uses (not, say, the address that goes into pairing codes).
      if (('appTunnel' in changed || 'port' in changed) && runtimeSignature() !== appliedSignature) {
        restarts = 0;
        apply();
      }
    });
  }
  cleanupPeers();
  apply();
}

export function stopAppTunnel() {
  clearTimeout(restartTimer);
  restartTimer = null;
  stopChild();
}

function stopChild() {
  const c = child;
  child = null;
  running = false;
  secret = null;
  setTunnelSecret(null);
  peerStatus = new Map();
  if (c) c.stdin.end(); // the helper exits when its input closes
}

const runtimeSignature = () => {
  const c = getSetting('appTunnel');
  return JSON.stringify([!!c.enabled, Number(c.listenPort), c.subnet, c.privateKey, httpPort]);
};
let appliedSignature = null;
let applying = false;
let applyAgain = false;

// Brings the helper in line with the settings. Making the keys saves settings, which comes back here as a change:
// that nested call only flags another pass, so there's never more than one helper.
function apply() {
  if (applying) {
    applyAgain = true;
    return;
  }
  applying = true;
  try {
    applyNow();
  } finally {
    applying = false;
    if (applyAgain) {
      applyAgain = false;
      if (runtimeSignature() !== appliedSignature) apply();
    }
  }
}

function applyNow() {
  clearTimeout(restartTimer);
  if (getSetting('appTunnel').enabled) ensureKeys();
  appliedSignature = runtimeSignature();
  stopChild();
  lastError = null;
  const cfg = getSetting('appTunnel');
  if (!cfg.enabled || !httpPort) return;
  if (!helperInstalled()) {
    lastError = `The tunnel helper isn't installed (${helperPath()})`;
    log.warn(`${lastError}. Build it from tunnel/ (see tunnel/README.md) or use the Docker image.`);
    return;
  }
  const keys = cfg;
  secret = crypto.randomBytes(24).toString('base64url');
  setTunnelSecret(secret);
  const address = tunnelAddress(keys);
  const proc = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child = proc;
  proc.stdin.on('error', () => {}); // the helper may already be gone
  proc.stdin.write(`${JSON.stringify({
    privateKey: keys.privateKey,
    listenPort: Number(keys.listenPort),
    address,
    httpPorts: [...new Set([80, httpPort])],
    target: `http://127.0.0.1:${httpPort}`,
    secret,
    peers: peerList(),
  })}\n`);

  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (proc !== child) return;
    if (msg.event === 'ready') {
      running = true;
      restarts = 0;
      log.info(`App tunnel listening on UDP port ${msg.listenPort} (Reelhouse is at http://${address} inside it)`);
    } else if (msg.event === 'status') {
      peerStatus = new Map(msg.peers.map((p) => [p.publicKey, p]));
      for (const resolve of statusWaiters.splice(0)) resolve();
    } else if (msg.event === 'error') {
      lastError = msg.message;
      log.error(`App tunnel: ${msg.message}`);
    } else if (msg.event === 'log') {
      log.debug(`App tunnel: ${msg.message}`);
    }
  });
  proc.stderr.on('data', (d) => log.debug(`App tunnel: ${String(d).trim()}`));
  proc.on('error', (err) => {
    lastError = err.message;
  });
  proc.on('exit', (code) => {
    if (proc !== child) return; // stopped on purpose
    child = null;
    running = false;
    lastError = lastError || `The tunnel helper stopped (exit code ${code})`;
    const delay = RESTART_DELAYS[Math.min(restarts++, RESTART_DELAYS.length - 1)];
    log.warn(`${lastError}; restarting in ${delay / 1000} s`);
    restartTimer = setTimeout(apply, delay);
    restartTimer.unref();
  });
}

/** Fresh handshake times from the helper (waits up to a second for them). */
export async function refreshTunnelStatus() {
  if (!running) return;
  const done = new Promise((resolve) => statusWaiters.push(resolve));
  send({ op: 'status' });
  await Promise.race([done, new Promise((r) => setTimeout(r, 1000))]);
}

export async function appTunnelStatus() {
  await refreshTunnelStatus();
  const cfg = getSetting('appTunnel');
  const peers = all(
    `SELECT p.*, u.username FROM tunnel_peers p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC`,
  ).map((p) => ({
    id: p.id,
    name: p.name,
    user: p.username,
    address: p.address,
    createdAt: p.created_at,
    pending: p.pending_until != null,
    lastHandshake: (peerStatus.get(p.public_key)?.lastHandshake || 0) * 1000 || null,
    rxBytes: peerStatus.get(p.public_key)?.rxBytes || 0,
    txBytes: peerStatus.get(p.public_key)?.txBytes || 0,
  }));
  return {
    enabled: !!cfg.enabled,
    configured: !!cfg.publicKey,
    running,
    error: cfg.enabled ? lastError : null,
    helperInstalled: helperInstalled(),
    listenPort: Number(cfg.listenPort),
    subnet: cfg.subnet,
    address: cfg.subnet ? tunnelAddress(cfg) : null,
    endpoint: endpointHost(cfg),
    publicKey: cfg.publicKey || null,
    peers,
  };
}

/** Last handshake (ms) of a device key, for the devices list. */
export function peerLastHandshake(id) {
  const p = get('SELECT public_key FROM tunnel_peers WHERE id = ?', id);
  const s = p && peerStatus.get(p.public_key);
  return s?.lastHandshake ? s.lastHandshake * 1000 : null;
}
