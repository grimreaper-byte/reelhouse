import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireAdmin } from '../auth.js';
import { APP_DEFAULT_KEYS, MASK, appDefaults, getSetting, publicSettings, stripMasked, updateSettings } from '../settings.js';
import { defaultsChanged, liveTvChanged } from '../events.js';
import { announceRequests } from '../requests.js';
import { appInfo, saveApk, removeApk, ApkError } from '../android.js';
import { addonZip } from '../kodi.js';
import { directAddresses } from '../pairing.js';
import { detectCapabilities, cachedCapabilities, HW_ENCODERS } from '../media/ffmpeg.js';
import { scanStatus } from '../scanner/index.js';
import { listSessions } from '../transcode/hls.js';
import { listLiveSessions } from '../transcode/live.js';
import { Tvheadend, checkTvheadend, tvheadendUrl } from '../livetv/tvheadend.js';
import { refreshLiveTv } from '../livetv/guide.js';
import { QUALITIES } from '../transcode/profile.js';
import { testApiKey } from '../metadata/tmdb.js';
import { logger, recentLogs } from '../lib/log.js';
import { lanAddresses, publicIp, isCgnat } from '../remote/net.js';
import { ddnsStatus, updateDdns, DDNS_PROVIDERS, fullHostname, supportsAcmeTxt } from '../remote/ddns.js';
import { upnpStatus, applyUpnp } from '../remote/upnp.js';
import { tlsStatus, issueCertificate } from '../remote/tls.js';
import {
  ensureServerKeys, addPeer, removePeer, getPeer, peerConfig, peerQrSvg, serverConfig, serverAddress,
  endpointHost, writeServerConfigFile, serverConfigPath, windowsWireGuardInstalled, installWindowsTunnel,
  addWindowsFirewallRules,
} from '../remote/wireguard.js';
import {
  appTunnelStatus, ensureKeys as ensureAppTunnelKeys, removePeer as removeAppTunnelPeer, tunnelAddress,
} from '../remote/apptunnel.js';
import { get as dbGet, all } from '../db.js';
import { listenerStatus } from '../listeners.js';
import { inContainer, hostNetwork } from '../lib/platform.js';
import { COMMIT, VERSION } from '../version.js';

const router = Router();
router.use(requireAdmin);

// ---------- settings ----------

router.get('/settings', (req, res) => {
  res.json({
    settings: publicSettings(),
    options: { encoders: HW_ENCODERS, qualities: QUALITIES, ddnsProviders: DDNS_PROVIDERS },
  });
});

const int = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number between ${min} and ${max}`);
  return n;
};

// A host name or IPv4 address (or nothing). The port is added from its own setting, so a "host:port" here would
// make "host:port:port".
function hostField(value, message) {
  const host = String(value ?? '').trim();
  if (host && !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error(message);
  return host;
}

function validate(update) {
  const u = stripMasked(update);
  if ('port' in u) u.port = int(u.port, 1, 65535, 'Port');
  if ('scanIntervalMinutes' in u) u.scanIntervalMinutes = int(u.scanIntervalMinutes, 0, 10080, 'Scan interval');
  if ('maxTranscodes' in u) u.maxTranscodes = int(u.maxTranscodes, 0, 50, 'Max transcodes');
  if ('encoder' in u && !HW_ENCODERS.some((e) => e.id === u.encoder)) throw new Error('Unknown encoder');
  if ('vaapiDevice' in u && !/^\/dev\/dri\/[\w.-]+$/.test(u.vaapiDevice)) throw new Error('VAAPI device must be a path like /dev/dri/renderD128');
  if ('remoteQuality' in u && !QUALITIES.some((q) => q.id === u.remoteQuality)) throw new Error('Unknown quality');
  if ('requestsEnabled' in u) u.requestsEnabled = !!u.requestsEnabled;
  if ('requestsLimit' in u) u.requestsLimit = int(u.requestsLimit || 0, 0, 1000, 'Requests per person');
  if ('x264Preset' in u && !['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(u.x264Preset)) {
    throw new Error('Unknown x264 preset');
  }
  if ('transcodeDir' in u && u.transcodeDir) {
    fs.mkdirSync(u.transcodeDir, { recursive: true });
  }
  if (u.https) {
    if ('port' in u.https) u.https.port = int(u.https.port, 1, 65535, 'HTTPS port');
    if ('mode' in u.https && !['off', 'custom', 'letsencrypt'].includes(u.https.mode)) throw new Error('Unknown HTTPS mode');
    if ('challenge' in u.https && !['dns-01', 'http-01'].includes(u.https.challenge)) throw new Error('Unknown challenge type');
    const merged = { ...getSetting('https'), ...u.https };
    if (merged.mode !== 'off' && merged.port === Number(u.port ?? getSetting('port'))) {
      throw new Error('HTTPS needs a different port than HTTP');
    }
  }
  if (u.ddns) {
    if ('provider' in u.ddns && !DDNS_PROVIDERS.some((p) => p.id === u.ddns.provider)) throw new Error('Unknown DDNS provider');
    if ('intervalMinutes' in u.ddns) u.ddns.intervalMinutes = int(u.ddns.intervalMinutes, 1, 1440, 'DDNS interval');
    // It becomes the address in device configs and pairing codes.
    if ('hostname' in u.ddns) u.ddns.hostname = hostField(u.ddns.hostname, 'The DDNS hostname must be a name like myhome.example.net');
  }
  if (u.upnp) {
    if ('externalPort' in u.upnp) u.upnp.externalPort = int(u.upnp.externalPort || 0, 0, 65535, 'External port');
    if ('openWebPort' in u.upnp) u.upnp.openWebPort = !!u.upnp.openWebPort;
  }
  if (u.wireguard) {
    delete u.wireguard.privateKey;
    delete u.wireguard.publicKey;
    delete u.wireguard.peers;
    if ('listenPort' in u.wireguard) u.wireguard.listenPort = int(u.wireguard.listenPort, 1, 65535, 'WireGuard port');
    if ('endpoint' in u.wireguard) {
      u.wireguard.endpoint = hostField(u.wireguard.endpoint, 'The WireGuard address must be a host name or IPv4 address, without a port');
    }
    if ('subnet' in u.wireguard && u.wireguard.subnet !== getSetting('wireguard').subnet) {
      if (getSetting('wireguard').peers.length) throw new Error('Remove all WireGuard devices before changing the subnet');
      serverAddress({ subnet: u.wireguard.subnet }); // throws on invalid subnet
    }
  }
  if (u.appTunnel) {
    delete u.appTunnel.privateKey;
    delete u.appTunnel.publicKey;
    if ('enabled' in u.appTunnel) u.appTunnel.enabled = !!u.appTunnel.enabled;
    if ('listenPort' in u.appTunnel) u.appTunnel.listenPort = int(u.appTunnel.listenPort, 1, 65535, 'App tunnel port');
    if ('endpoint' in u.appTunnel) {
      u.appTunnel.endpoint = hostField(u.appTunnel.endpoint, 'The app tunnel address must be a host name or IPv4 address, without a port');
    }
    const wgPort = Number(u.wireguard?.listenPort ?? getSetting('wireguard').listenPort);
    const wgOn = u.wireguard?.enabled ?? getSetting('wireguard').enabled;
    if (wgOn && Number(u.appTunnel.listenPort ?? getSetting('appTunnel').listenPort) === wgPort) {
      throw new Error('The app tunnel needs a different UDP port than WireGuard');
    }
    if ('subnet' in u.appTunnel && u.appTunnel.subnet !== getSetting('appTunnel').subnet) {
      if (dbGet('SELECT COUNT(*) AS n FROM tunnel_peers').n) throw new Error('Sign out the paired apps before changing the app tunnel subnet');
      tunnelAddress({ subnet: u.appTunnel.subnet }); // throws on invalid subnet
      if (u.appTunnel.subnet === (u.wireguard?.subnet ?? getSetting('wireguard').subnet)) {
        throw new Error('The app tunnel needs a different subnet than WireGuard');
      }
    }
  }
  if (u.liveTv) {
    if ('enabled' in u.liveTv) u.liveTv.enabled = !!u.liveTv.enabled;
    if ('url' in u.liveTv) u.liveTv.url = tvheadendUrl(u.liveTv.url);
    if ('username' in u.liveTv) u.liveTv.username = String(u.liveTv.username ?? '').trim();
    if ('password' in u.liveTv) u.liveTv.password = String(u.liveTv.password ?? '');
    if ('dvrConfig' in u.liveTv) {
      u.liveTv.dvrConfig = String(u.liveTv.dvrConfig ?? '').trim();
      if (u.liveTv.dvrConfig && !/^[0-9a-f]{32}$/i.test(u.liveTv.dvrConfig)) throw new Error('Unknown recording profile');
    }
    if ({ ...getSetting('liveTv'), ...u.liveTv }.enabled && !{ ...getSetting('liveTv'), ...u.liveTv }.url) {
      throw new Error('Enter Tvheadend\'s address to turn Live TV on');
    }
  }
  return u;
}

router.put('/settings', (req, res) => {
  let update;
  try {
    update = validate(req.body || {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const changed = updateSettings(update);
  if (changed.wireguard) writeServerConfigFile();
  // Apps that are open hear straight away, e.g. to hide Download once downloads are turned off.
  if (APP_DEFAULT_KEYS.some((k) => k in changed)) defaultsChanged(appDefaults());
  // Pages show or hide Live TV.
  if (changed.liveTv) liveTvChanged();
  // Pages and apps show or hide Requests (turned on or off, or a TMDB key added or taken away).
  if ('requestsEnabled' in changed || 'tmdbApiKey' in changed) announceRequests();
  res.json({ settings: publicSettings(), changed: Object.keys(changed) });
});

// ---------- status ----------

router.get('/admin/status', async (req, res) => {
  const port = getSetting('port');
  res.json({
    version: VERSION,
    commit: COMMIT,
    serverName: getSetting('serverName'),
    platform: `${os.type()} ${os.release()} (${os.arch()})${inContainer() ? ` · container${hostNetwork() ? ' (host network)' : ''}` : ''}`,
    os: process.platform,
    container: inContainer(),
    node: process.version,
    uptime: process.uptime(),
    cpus: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem() },
    ffmpeg: cachedCapabilities() || (await detectCapabilities()),
    lan: lanAddresses().map((a) => ({ ...a, url: `http://${a.address}:${port}` })),
    listeners: listenerStatus(),
    scan: scanStatus(),
    transcodes: [...listSessions(), ...listLiveSessions()].map((s) => s.info()),
  });
});

router.post('/admin/ffmpeg/detect', async (req, res) => {
  res.json({ ffmpeg: await detectCapabilities(true) });
});

// Settings → Live TV's "Test connection", with what's in the form (a masked password means the saved one).
router.post('/admin/livetv/test', async (req, res) => {
  const saved = getSetting('liveTv');
  const body = req.body || {};
  let url;
  try {
    url = tvheadendUrl(body.url ?? saved.url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!url) return res.status(400).json({ error: 'Enter Tvheadend\'s address first' });
  const password = body.password == null || body.password === MASK ? saved.password : String(body.password);
  const username = String(body.username ?? saved.username).trim();
  try {
    res.json(await checkTvheadend(new Tvheadend({ url, username, password })));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const liveTvLog = logger('livetv');

// Settings → Live TV's "Delete cached guide data and fetch again", with the saved connection.
router.post('/admin/livetv/refresh', async (req, res) => {
  if (!getSetting('liveTv').url) return res.status(400).json({ error: 'Save Tvheadend\'s address first' });
  try {
    const r = await refreshLiveTv();
    liveTvLog.info(`User "${req.user.username}" deleted Live TV's kept guide data and ${r.removedLogos} logos, and fetched them again: `
      + `${r.channels} channels (${r.radio} radio), ${r.logos} logos${r.logosPending ? ' so far' : ''}, `
      + `${r.guideError ? `no guide (${r.guideError})` : `${r.programmes} programmes in the next day`}`);
    // Pages show or hide Radio as the fresh channel list says.
    liveTvChanged();
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/admin/tmdb/test', async (req, res) => {
  try {
    await testApiKey();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- the Kodi add-on, handed out at /kodi/ ----------

// The add-on Kodi installs, the addresses Kodi can add as a file source to install it from (the same ones a phone is
// given when pairing), and the Kodis signed in to any account (the add-on's sign-in names contain "Kodi").
router.get('/admin/kodi-addon', async (req, res) => {
  const { version, name, file } = await addonZip();
  const { size, mtime } = await fs.promises.stat(file);
  const devices = all(
    `SELECT u.username, s.device, s.created_at, s.last_seen_at, s.ip FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.device LIKE '%kodi%' ORDER BY s.last_seen_at DESC`,
  ).map((d) => ({ user: d.username, name: d.device, createdAt: d.created_at, lastSeenAt: d.last_seen_at, ip: d.ip }));
  res.json({
    addon: { version, fileName: name, size, builtAt: mtime.getTime() },
    addresses: directAddresses(req).map((u) => `${u}/kodi/`),
    devices,
  });
});

// ---------- the Reelhouse app for Android, handed out at /android/ ----------

router.get('/admin/android-app', async (req, res) => res.json({ app: await appInfo() }));

// The APK is the request body itself (not JSON), checked before it replaces the current one.
router.put('/admin/android-app', async (req, res) => {
  try {
    res.json({ app: await saveApk(req) });
  } catch (err) {
    if (!(err instanceof ApkError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

router.delete('/admin/android-app', async (req, res) => {
  await removeApk();
  res.json({ app: null });
});

router.get('/admin/logs', (req, res) => {
  res.json({ logs: recentLogs(Number(req.query.limit) || 300) });
});

// ---------- folder browser ----------

router.get('/fs', (req, res) => {
  const p = String(req.query.path || '');
  if (!p) {
    const roots = [];
    if (process.platform === 'win32') {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const drive = `${letter}:\\`;
        try {
          fs.accessSync(drive);
          roots.push({ name: drive, path: drive });
        } catch {
          // no such drive
        }
      }
    } else {
      roots.push({ name: '/', path: '/' });
      // Usual mount points, plus the folders Docker setups typically map media into.
      for (const m of ['/media', '/mnt', '/data', '/movies', '/tv', '/srv', '/Volumes']) {
        if (fs.existsSync(m)) roots.push({ name: m, path: m });
      }
    }
    if (!inContainer()) roots.push({ name: 'Home', path: os.homedir() });
    return res.json({ path: '', parent: null, entries: roots });
  }
  const dir = path.resolve(p);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `Cannot open ${dir}: ${err.code || err.message}` });
  }
  const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
  res.json({
    path: dir,
    parent,
    entries: entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })),
  });
});

// ---------- remote access ----------

router.get('/remote/status', async (req, res) => {
  let ip = null;
  let ipError = null;
  try {
    ip = await publicIp({ force: req.query.refresh === '1' });
  } catch (err) {
    ipError = err.message;
  }
  const wg = getSetting('wireguard');
  const https = getSetting('https');
  const upnp = upnpStatus();
  res.json({
    publicIp: ip,
    publicIpError: ipError,
    cgnat: (ip && isCgnat(ip)) || (upnp.externalIp && (isCgnat(upnp.externalIp) || (ip && upnp.externalIp !== ip))),
    container: inContainer(),
    hostNetwork: hostNetwork(),
    lan: lanAddresses(),
    ports: { http: getSetting('port'), https: https.mode !== 'off' ? https.port : null, wireguard: wg.listenPort, appTunnel: getSetting('appTunnel').listenPort },
    listeners: listenerStatus(),
    ddns: { ...ddnsStatus(), hostname: fullHostname(), supportsDnsChallenge: supportsAcmeTxt() },
    upnp,
    tls: tlsStatus(),
    wireguard: {
      enabled: wg.enabled,
      configured: !!wg.publicKey,
      publicKey: wg.publicKey || null,
      serverAddress: wg.subnet ? serverAddress(wg) : null,
      endpoint: endpointHost(wg),
      peers: wg.peers.map(({ privateKey, presharedKey, ...p }) => p),
      configPath: wg.publicKey ? serverConfigPath() : null,
      windowsInstalled: windowsWireGuardInstalled(),
      platform: process.platform,
    },
    appTunnel: await appTunnelStatus(),
  });
});

router.post('/remote/ddns/update', async (req, res) => {
  res.json({ ddns: await updateDdns({ force: true }) });
});

router.post('/remote/upnp/apply', async (req, res) => {
  res.json({ upnp: await applyUpnp() });
});

router.post('/remote/tls/issue', async (req, res) => {
  try {
    await issueCertificate();
    res.json({ tls: tlsStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message, tls: tlsStatus() });
  }
});

router.post('/remote/app-tunnel/init', (req, res) => {
  ensureAppTunnelKeys();
  res.json({ ok: true });
});

router.delete('/remote/app-tunnel/peers/:id', (req, res) => {
  // The device stays signed in; it just can't use the tunnel any more (it would need pairing again).
  removeAppTunnelPeer(req.params.id);
  res.json({ ok: true });
});

router.post('/remote/wireguard/init', (req, res) => {
  ensureServerKeys();
  writeServerConfigFile();
  res.json({ ok: true });
});

router.post('/remote/wireguard/peers', async (req, res) => {
  try {
    const peer = addPeer(req.body?.name);
    res.json({ peer: { id: peer.id, name: peer.name, address: peer.address }, config: peerConfig(peer), qr: await peerQrSvg(peer) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/remote/wireguard/peers/:id', async (req, res) => {
  const peer = getPeer(req.params.id);
  if (!peer) return res.status(404).json({ error: 'No such device' });
  res.json({ peer: { id: peer.id, name: peer.name, address: peer.address }, config: peerConfig(peer), qr: await peerQrSvg(peer) });
});

router.get('/remote/wireguard/peers/:id/download', (req, res) => {
  const peer = getPeer(req.params.id);
  if (!peer) return res.status(404).end();
  const name = `reelhouse-${peer.name.replace(/[^\w-]+/g, '-').toLowerCase()}.conf`;
  res.attachment(name).type('text/plain').send(peerConfig(peer));
});

router.delete('/remote/wireguard/peers/:id', (req, res) => {
  removePeer(req.params.id);
  res.json({ ok: true });
});

router.get('/remote/wireguard/server.conf', (req, res) => {
  const wg = getSetting('wireguard');
  if (!wg.privateKey) return res.status(404).end();
  res.attachment('reelhouse.conf').type('text/plain').send(serverConfig(wg));
});

router.post('/remote/wireguard/install-windows', async (req, res) => {
  try {
    await installWindowsTunnel();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/remote/firewall', async (req, res) => {
  const https = getSetting('https');
  const ports = [getSetting('port'), ...(https.mode !== 'off' ? [https.port] : [])];
  try {
    await addWindowsFirewallRules(ports);
    res.json({ ok: true, ports });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
