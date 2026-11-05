import crypto from 'node:crypto';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { all, run, tx } from './db.js';

export const settingsEvents = new EventEmitter();

const DEFAULTS = {
  serverName: process.env.REELHOUSE_SERVER_NAME || os.hostname(),
  port: 8484,
  bindAddress: '0.0.0.0',
  trustProxy: false,
  secret: null, // generated on first run

  // Library
  scanIntervalMinutes: 60,
  watchFolders: true,

  // Metadata
  tmdbApiKey: '',
  metadataLanguage: 'en-US',
  preferLocalArtwork: true,

  // Transcoder
  ffmpegPath: '',
  ffprobePath: '',
  encoder: 'libx264',
  vaapiDevice: '/dev/dri/renderD128',
  x264Preset: 'veryfast',
  maxTranscodes: 3,
  transcodeDir: '',
  tonemapHdr: true,
  remoteQuality: '4m-720',
  allowDownloads: false, // servers set up before this default keep theirs (migration v18)

  // Requests (server/requests.js): anyone can ask for a film that isn't on the server; finding films needs tmdbApiKey.
  requestsEnabled: true,
  requestsLimit: 0, // the most requests one person (not an admin) can have waiting at once; 0: no limit

  // Remote access
  https: {
    mode: 'off', // off | custom | letsencrypt
    port: 8443,
    certPath: '',
    keyPath: '',
    domain: '',
    email: '',
    challenge: 'dns-01', // dns-01 (via DDNS provider) | http-01 (needs port 80)
    staging: false,
    agreeTos: false,
  },
  ddns: {
    provider: 'none', // none | external (kept updated elsewhere) | duckdns | cloudflare | noip | dyndns2 | namecheap | custom
    hostname: '',
    token: '',
    username: '',
    password: '',
    zone: '',
    server: '',
    url: '',
    intervalMinutes: 5,
  },
  upnp: {
    enabled: false,
    externalPort: 0, // 0 = same as the internal port
    openWebPort: false, // the web port is only needed for direct access (Option 3), not for the app tunnel or WireGuard
  },
  wireguard: {
    enabled: false,
    privateKey: '',
    publicKey: '',
    listenPort: 51820,
    subnet: '10.77.0.0/24',
    endpoint: '',
    dns: '',
    peers: [], // { id, name, privateKey, publicKey, presharedKey, address, createdAt }
  },
  // The WireGuard endpoint built into Reelhouse for its apps (tunnel/ helper). Only Reelhouse is reachable
  // through it; each paired device's key lives in the tunnel_peers table.
  appTunnel: {
    enabled: false,
    privateKey: '',
    publicKey: '',
    listenPort: 51821,
    subnet: '10.78.0.0/24',
    endpoint: '',
  },
  // Live TV from Tvheadend (server/livetv/): its address (http://host:9981, plus any web root), the account Reelhouse
  // signs in with, and the recording profile used when someone records from the guide ('' = Tvheadend's default).
  liveTv: {
    enabled: false,
    url: '',
    username: '',
    password: '',
    dvrConfig: '',
  },
};

// Settings that must never be sent to the browser in clear text.
export const SECRET_PATHS = [
  'secret',
  'tmdbApiKey',
  'ddns.token',
  'ddns.password',
  'wireguard.privateKey',
  'appTunnel.privateKey',
  'liveTv.password',
];

let cache = null;

function load() {
  cache = structuredClone(DEFAULTS);
  for (const row of all('SELECT key, value FROM settings')) {
    try {
      const value = JSON.parse(row.value);
      if (isPlainObject(DEFAULTS[row.key]) && isPlainObject(value)) {
        cache[row.key] = { ...DEFAULTS[row.key], ...value };
      } else {
        cache[row.key] = value;
      }
    } catch {
      // ignore corrupt values; defaults apply
    }
  }
  if (!cache.secret) {
    cache.secret = crypto.randomBytes(32).toString('base64url');
    persist({ secret: cache.secret });
  }
  // Environment override (not saved), handy when the saved port is taken.
  if (process.env.PORT) cache.port = Number(process.env.PORT);
}

function persist(partial) {
  tx(() => {
    for (const [key, value] of Object.entries(partial)) {
      run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify(value),
      );
    }
  });
}

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

export function getSettings() {
  if (!cache) load();
  return cache;
}

export function getSetting(key) {
  return getSettings()[key];
}

/** True when the setting has been saved (as opposed to still using its default). */
export function isSettingStored(key) {
  return all('SELECT 1 FROM settings WHERE key = ?', key).length > 0;
}

/**
 * Merge a partial update into the settings. Object-valued settings are merged one level deep,
 * so `{ ddns: { token: 'x' } }` only changes the token.
 */
export function updateSettings(partial) {
  const current = getSettings();
  const changed = {};
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in DEFAULTS)) continue;
    const next = isPlainObject(DEFAULTS[key]) && isPlainObject(value) ? { ...current[key], ...value } : value;
    if (JSON.stringify(next) !== JSON.stringify(current[key])) {
      changed[key] = next;
      current[key] = next;
    }
  }
  if (Object.keys(changed).length) {
    persist(changed);
    settingsEvents.emit('change', changed);
  }
  return changed;
}

/**
 * This install's id: stable, and revealing nothing of the secret it's derived from. Apps check it before they send
 * a pairing code or their sign-in to an address (a home address may be someone else's on another network).
 */
export function serverId() {
  return crypto.createHash('sha256').update(`reelhouse-server-id:${getSetting('secret')}`).digest('hex').slice(0, 20);
}

// What apps follow from the server's settings: their quality away from home, and whether they may download.
export const APP_DEFAULT_KEYS = ['remoteQuality', 'allowDownloads'];
export function appDefaults() {
  return { remoteQuality: getSetting('remoteQuality'), allowDownloads: !!getSetting('allowDownloads') };
}

export const MASK = '••••••••';

// A copy of the settings safe to send to an admin's browser: secrets replaced with a mask.
export function publicSettings() {
  const copy = structuredClone(getSettings());
  delete copy.secret;
  for (const p of SECRET_PATHS) {
    const [a, b] = p.split('.');
    if (b) {
      if (copy[a]?.[b]) copy[a][b] = MASK;
    } else if (copy[a]) copy[a] = MASK;
  }
  if (copy.wireguard?.peers) {
    copy.wireguard.peers = copy.wireguard.peers.map(({ privateKey, presharedKey, ...rest }) => rest);
  }
  return copy;
}

// Drops masked values from an incoming update so unchanged secrets are kept.
export function stripMasked(update) {
  const out = structuredClone(update);
  for (const p of SECRET_PATHS) {
    const [a, b] = p.split('.');
    if (b) {
      if (out[a]?.[b] === MASK) delete out[a][b];
    } else if (out[a] === MASK) delete out[a];
  }
  delete out.secret;
  return out;
}
