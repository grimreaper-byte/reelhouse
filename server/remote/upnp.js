// UPnP IGD client: asks the home router to forward ports to this machine (like "automatic
// remote access" in other media servers). Works only when UPnP is enabled on the router.
import dgram from 'node:dgram';
import { getSetting, settingsEvents } from '../settings.js';
import { logger } from '../lib/log.js';

const log = logger('upnp');
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const LEASE_SECONDS = 3600;

const state = { gateway: null, externalIp: null, mappings: [], ok: null, message: null, lastRun: null };
let timer = null;

/** The ports to forward: the web port (direct access, if wanted), WireGuard's and the app tunnel's when they're on. */
export function wantedMappings() {
  const https = getSetting('https');
  const upnp = getSetting('upnp');
  const wg = getSetting('wireguard');
  const appTunnel = getSetting('appTunnel');
  const maps = [];
  if (upnp.openWebPort) {
    const webPort = https.mode !== 'off' ? Number(https.port) : Number(getSetting('port'));
    maps.push({ internalPort: webPort, externalPort: Number(upnp.externalPort) || webPort, protocol: 'TCP', description: 'Reelhouse Media Server' });
  }
  if (wg.enabled && wg.publicKey) {
    maps.push({ internalPort: wg.listenPort, externalPort: wg.listenPort, protocol: 'UDP', description: 'Reelhouse WireGuard' });
  }
  if (appTunnel.enabled) {
    const p = Number(appTunnel.listenPort);
    maps.push({ internalPort: p, externalPort: p, protocol: 'UDP', description: 'Reelhouse app tunnel' });
  }
  return maps;
}

export function upnpStatus() {
  return {
    enabled: !!getSetting('upnp').enabled,
    gateway: state.gateway ? { location: state.gateway.location, model: state.gateway.model, localAddress: state.gateway.localAddress } : null,
    externalIp: state.externalIp,
    mappings: state.mappings,
    ok: state.ok,
    message: state.message,
    lastRun: state.lastRun,
  };
}

function discoverLocations(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const loc = text.match(/^location:\s*(.+)$/im)?.[1]?.trim();
      if (loc && !found.has(loc)) found.set(loc, rinfo.address);
    });
    socket.on('error', () => {});
    socket.bind(() => {
      for (const st of SEARCH_TARGETS) {
        const msg = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
        );
        socket.send(msg, SSDP_PORT, SSDP_ADDR);
      }
    });
    setTimeout(() => {
      socket.close();
      resolve([...found.entries()].map(([location, address]) => ({ location, address })));
    }, timeoutMs);
  });
}

// The local IP the OS uses to reach the router — that's where the router should forward to.
function localAddressFor(remote) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.connect(SSDP_PORT, remote, () => {
      const addr = s.address().address;
      s.close();
      resolve(addr);
    });
    s.on('error', () => {
      s.close();
      resolve(null);
    });
  });
}

async function describe({ location, address }) {
  const res = await fetch(location, { signal: AbortSignal.timeout(5000) });
  const xml = await res.text();
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => ({
    type: m[1].match(/<serviceType>([^<]+)<\/serviceType>/i)?.[1]?.trim(),
    control: m[1].match(/<controlURL>([^<]+)<\/controlURL>/i)?.[1]?.trim(),
  }));
  const svc = services.find((s) => /WANIPConnection/.test(s.type || '')) || services.find((s) => /WANPPPConnection/.test(s.type || ''));
  if (!svc?.control) return null;
  const base = xml.match(/<URLBase>([^<]+)<\/URLBase>/i)?.[1]?.trim() || location;
  return {
    location,
    serviceType: svc.type,
    controlUrl: new URL(svc.control, base).toString(),
    model: xml.match(/<friendlyName>([^<]+)<\/friendlyName>/i)?.[1]?.trim() || null,
    localAddress: await localAddressFor(address),
  };
}

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

async function soap(gw, action, args = {}) {
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${gw.serviceType}">${Object.entries(args).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('')}</u:${action}></s:Body>
</s:Envelope>`;
  const res = await fetch(gw.controlUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${gw.serviceType}#${action}"` },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = text.match(/<errorCode>(\d+)<\/errorCode>/)?.[1];
    const desc = text.match(/<errorDescription>([^<]+)<\/errorDescription>/)?.[1];
    const err = new Error(`${action} failed: ${desc || `HTTP ${res.status}`}${code ? ` (${code})` : ''}`);
    err.upnpCode = Number(code);
    throw err;
  }
  return text;
}

export async function findGateway() {
  const locations = await discoverLocations();
  for (const loc of locations) {
    try {
      const gw = await describe(loc);
      if (gw) return gw;
    } catch {
      // try the next responder
    }
  }
  return null;
}

async function addMapping(gw, { externalPort, internalPort, protocol, description }) {
  const args = {
    NewRemoteHost: '',
    NewExternalPort: externalPort,
    NewProtocol: protocol,
    NewInternalPort: internalPort,
    NewInternalClient: gw.localAddress,
    NewEnabled: 1,
    NewPortMappingDescription: description,
    NewLeaseDuration: LEASE_SECONDS,
  };
  try {
    await soap(gw, 'AddPortMapping', args);
  } catch (err) {
    // 725 = OnlyPermanentLeasesSupported
    if (err.upnpCode !== 725) throw err;
    await soap(gw, 'AddPortMapping', { ...args, NewLeaseDuration: 0 });
  }
}

export async function applyUpnp() {
  state.lastRun = Date.now();
  if (!getSetting('upnp').enabled) {
    await removeUpnp();
    return upnpStatus();
  }
  try {
    const gw = state.gateway || (await findGateway());
    if (!gw) throw new Error('No UPnP router found. Enable UPnP on your router, or forward the ports manually.');
    state.gateway = gw;
    const ipXml = await soap(gw, 'GetExternalIPAddress').catch(() => '');
    state.externalIp = ipXml.match(/<NewExternalIPAddress>([^<]*)<\/NewExternalIPAddress>/)?.[1] || null;
    const desired = wantedMappings();
    // Remove mappings we created earlier that are no longer wanted (e.g. the port changed).
    for (const old of state.mappings) {
      if (!desired.some((d) => d.externalPort === old.externalPort && d.protocol === old.protocol)) {
        await soap(gw, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: old.externalPort, NewProtocol: old.protocol }).catch(() => {});
      }
    }
    const results = [];
    for (const m of desired) {
      try {
        await addMapping(gw, m);
        results.push({ ...m, ok: true });
      } catch (err) {
        results.push({ ...m, ok: false, error: err.message });
      }
    }
    state.mappings = results;
    state.ok = results.every((r) => r.ok);
    state.message = !results.length ? 'Nothing to forward: no way in is turned on'
      : state.ok ? `Forwarding ${results.map((r) => `${r.protocol} ${r.externalPort}`).join(', ')} to ${gw.localAddress}` : results.find((r) => !r.ok)?.error;
    if (!state.ok) log.warn(state.message);
  } catch (err) {
    state.gateway = null;
    state.ok = false;
    state.message = err.message;
    log.warn(err.message);
  }
  return upnpStatus();
}

export async function removeUpnp() {
  const gw = state.gateway;
  if (!gw) return;
  for (const m of state.mappings) {
    try {
      await soap(gw, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.externalPort, NewProtocol: m.protocol });
    } catch {
      // already gone
    }
  }
  state.mappings = [];
  state.ok = null;
  state.message = null;
}

export function startUpnp() {
  clearInterval(timer);
  void applyUpnp();
  timer = setInterval(() => void applyUpnp(), (LEASE_SECONDS / 2) * 1000);
  timer.unref();
}

settingsEvents.on('change', (changed) => {
  if (changed.upnp || changed.port || changed.https || changed.wireguard || changed.appTunnel) startUpnp();
});
