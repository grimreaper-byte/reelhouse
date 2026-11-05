// WireGuard config generator. The server config is imported into WireGuard on this machine;
// each device (phone, laptop) gets its own peer config, shown as a QR code for the mobile app.
// Peers only route the media server's tunnel address (split tunnel), so no IP forwarding/NAT is
// needed on this machine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';
import { getSetting, updateSettings } from '../settings.js';
import { dirs } from '../lib/paths.js';
import { fullHostname } from './ddns.js';
import { lastKnownPublicIp } from './net.js';

export const TUNNEL_NAME = 'reelhouse';
const WINDOWS_WG = 'C:\\Program Files\\WireGuard\\wireguard.exe';

const b64urlToB64 = (s) => Buffer.from(s, 'base64url').toString('base64');

export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: b64urlToB64(privateKey.export({ format: 'jwk' }).d),
    publicKey: b64urlToB64(publicKey.export({ format: 'jwk' }).x),
  };
}

export function publicKeyFromPrivate(privB64) {
  const raw = Buffer.from(privB64, 'base64');
  // PKCS#8 wrapper for a raw X25519 private key.
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return b64urlToB64(crypto.createPublicKey(key).export({ format: 'jwk' }).x);
}

export function parseSubnet(cidr) {
  const [base, bits] = cidr.split('/');
  const octets = base.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !(o >= 0 && o <= 255)) || Number(bits) > 30 || Number(bits) < 16) {
    throw new Error('Subnet must look like 10.77.0.0/24 (prefix between /16 and /30)');
  }
  const baseInt = octets.reduce((a, o) => (a << 8) + o, 0) >>> 0;
  const size = 2 ** (32 - Number(bits));
  const network = (baseInt & ~(size - 1)) >>> 0;
  const toIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  return { bits: Number(bits), network, size, toIp };
}

export function serverAddress(cfg = getSetting('wireguard')) {
  const s = parseSubnet(cfg.subnet);
  return s.toIp(s.network + 1);
}

function nextPeerAddress(cfg) {
  const s = parseSubnet(cfg.subnet);
  const used = new Set(cfg.peers.map((p) => p.address));
  for (let i = 2; i < s.size - 1; i++) {
    const ip = s.toIp(s.network + i);
    if (!used.has(ip)) return ip;
  }
  throw new Error('No free addresses left in the WireGuard subnet');
}

export function ensureServerKeys() {
  const cfg = getSetting('wireguard');
  if (cfg.privateKey) return cfg;
  const kp = generateKeyPair();
  updateSettings({ wireguard: { privateKey: kp.privateKey, publicKey: kp.publicKey } });
  return getSetting('wireguard');
}

export function endpointHost(cfg = getSetting('wireguard')) {
  return cfg.endpoint?.trim() || fullHostname() || lastKnownPublicIp() || '';
}

export function serverConfig(cfg = getSetting('wireguard')) {
  const s = parseSubnet(cfg.subnet);
  const lines = [
    '# Reelhouse WireGuard server — import into WireGuard on the media server machine',
    '[Interface]',
    `PrivateKey = ${cfg.privateKey}`,
    `Address = ${serverAddress(cfg)}/${s.bits}`,
    `ListenPort = ${cfg.listenPort}`,
    '',
  ];
  for (const p of cfg.peers) {
    lines.push(`# ${p.name}`, '[Peer]', `PublicKey = ${p.publicKey}`, `PresharedKey = ${p.presharedKey}`, `AllowedIPs = ${p.address}/32`, '');
  }
  return lines.join('\n');
}

export function peerConfig(peer, cfg = getSetting('wireguard')) {
  const host = endpointHost(cfg) || 'YOUR-PUBLIC-IP-OR-HOSTNAME';
  return [
    `# Reelhouse — ${peer.name}`,
    '[Interface]',
    `PrivateKey = ${peer.privateKey}`,
    `Address = ${peer.address}/32`,
    ...(cfg.dns ? [`DNS = ${cfg.dns}`] : []),
    '',
    '[Peer]',
    `PublicKey = ${cfg.publicKey}`,
    `PresharedKey = ${peer.presharedKey}`,
    `Endpoint = ${host}:${cfg.listenPort}`,
    `AllowedIPs = ${serverAddress(cfg)}/32`,
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
}

export function addPeer(name) {
  const cfg = ensureServerKeys();
  const kp = generateKeyPair();
  const peer = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name || 'Device').slice(0, 60),
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    presharedKey: crypto.randomBytes(32).toString('base64'),
    address: nextPeerAddress(cfg),
    createdAt: Date.now(),
  };
  updateSettings({ wireguard: { peers: [...cfg.peers, peer] } });
  writeServerConfigFile();
  return peer;
}

export function removePeer(id) {
  const cfg = getSetting('wireguard');
  updateSettings({ wireguard: { peers: cfg.peers.filter((p) => p.id !== id) } });
  writeServerConfigFile();
}

export function getPeer(id) {
  return getSetting('wireguard').peers.find((p) => p.id === id) || null;
}

export async function peerQrSvg(peer) {
  return QRCode.toString(peerConfig(peer), { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
}

export function serverConfigPath() {
  return path.join(dirs.wireguard, `${TUNNEL_NAME}.conf`);
}

export function writeServerConfigFile() {
  const cfg = getSetting('wireguard');
  if (!cfg.privateKey) return null;
  fs.mkdirSync(dirs.wireguard, { recursive: true });
  fs.writeFileSync(serverConfigPath(), serverConfig(cfg), { mode: 0o600 });
  return serverConfigPath();
}

export function windowsWireGuardInstalled() {
  return process.platform === 'win32' && fs.existsSync(WINDOWS_WG);
}

/**
 * Windows only: (re)installs the tunnel as a WireGuard service. Needs admin rights, so it starts
 * an elevated PowerShell — Windows shows a UAC prompt on this machine's screen.
 */
export function installWindowsTunnel() {
  if (!windowsWireGuardInstalled()) throw new Error('WireGuard for Windows is not installed');
  const conf = writeServerConfigFile();
  if (!conf) throw new Error('Generate the server keys first');
  const port = getSetting('wireguard').listenPort;
  const inner = [
    `& '${WINDOWS_WG}' /uninstalltunnelservice ${TUNNEL_NAME} 2>$null`,
    'Start-Sleep -Seconds 2',
    `& '${WINDOWS_WG}' /installtunnelservice '${conf.replace(/'/g, "''")}'`,
    `if (-not (Get-NetFirewallRule -DisplayName 'Reelhouse WireGuard' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName 'Reelhouse WireGuard' -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${port} -Profile Any | Out-Null }`,
  ].join('; ');
  return runElevated(inner);
}

/** Windows only: opens the media server's ports in Windows Firewall for all network profiles. */
export function addWindowsFirewallRules(ports) {
  const list = ports.join(',');
  const inner = [
    "Remove-NetFirewallRule -DisplayName 'Reelhouse Media Server' -ErrorAction SilentlyContinue",
    `New-NetFirewallRule -DisplayName 'Reelhouse Media Server' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${list} -Profile Any | Out-Null`,
  ].join('; ');
  return runElevated(inner);
}

function runElevated(script) {
  if (process.platform !== 'win32') throw new Error('Only available on Windows');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`],
      { windowsHide: true },
    );
    let err = '';
    ps.stderr.on('data', (d) => (err += d));
    ps.on('error', reject);
    ps.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.includes('canceled') ? 'The admin prompt was cancelled' : err.trim() || `exit ${code}`))));
  });
}
