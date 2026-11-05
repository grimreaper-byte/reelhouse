// Dynamic DNS: keeps a hostname pointed at this network's public IP. With "external" something else (often the
// router) keeps the name updated, and Reelhouse only checks that it points here.
import { Resolver } from 'node:dns/promises';
import { getSetting, settingsEvents } from '../settings.js';
import { publicIp } from './net.js';
import { logger } from '../lib/log.js';

const log = logger('ddns');
const UA = 'Reelhouse/0.1';

export const DDNS_PROVIDERS = [
  { id: 'none', label: 'None' },
  { id: 'external', label: 'Updated elsewhere (router or another program)', fields: ['hostname'] },
  { id: 'duckdns', label: 'Duck DNS (free)', fields: ['hostname', 'token'], txt: true },
  { id: 'cloudflare', label: 'Cloudflare', fields: ['hostname', 'zone', 'token'], txt: true },
  { id: 'noip', label: 'No-IP', fields: ['hostname', 'username', 'password'] },
  { id: 'dyndns2', label: 'Other DynDNS2 provider (Dynu, etc.)', fields: ['server', 'hostname', 'username', 'password'] },
  { id: 'namecheap', label: 'Namecheap', fields: ['hostname', 'zone', 'password'] },
  { id: 'custom', label: 'Custom update URL', fields: ['url', 'hostname'] },
];

const state = { lastIp: null, lastUpdate: null, lastCheck: null, ok: null, message: null };
let timer = null;

export function ddnsStatus() {
  const cfg = getSetting('ddns');
  return { provider: cfg.provider, hostname: fullHostname(cfg), ...state };
}

export function fullHostname(cfg = getSetting('ddns')) {
  // A name left over from a provider that was switched off isn't kept up to date any more.
  if (cfg.provider === 'none') return '';
  if (cfg.provider === 'duckdns') {
    const sub = cfg.hostname.replace(/\.duckdns\.org\.?$/i, '').trim();
    return sub ? `${sub}.duckdns.org` : '';
  }
  return (cfg.hostname || '').trim();
}

// ---------- providers ----------

async function getText(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text.trim();
}

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

async function duckdns(cfg, ip, txt) {
  const domain = fullHostname(cfg).replace(/\.duckdns\.org$/, '');
  const params = new URLSearchParams({ domains: domain, token: cfg.token });
  if (txt !== undefined) {
    params.set('txt', txt ?? '');
    if (txt === null) params.set('clear', 'true');
  } else if (ip) params.set('ip', ip);
  const text = await getText(`https://www.duckdns.org/update?${params}`);
  if (!text.startsWith('OK')) throw new Error('Duck DNS rejected the update (check the subdomain and token)');
  return 'Updated';
}

async function cfApi(token, pathname, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) throw new Error(`Cloudflare: ${json.errors?.[0]?.message || `HTTP ${res.status}`}`);
  return json.result;
}

async function cfZoneId(cfg) {
  const candidates = cfg.zone ? [cfg.zone] : cfg.hostname.split('.').map((_, i, a) => a.slice(i).join('.')).filter((z) => z.includes('.'));
  for (const name of candidates) {
    const zones = await cfApi(cfg.token, `/zones?name=${encodeURIComponent(name)}`);
    if (zones?.[0]) return zones[0].id;
  }
  throw new Error('Cloudflare zone not found — check the zone name and token permissions (Zone:DNS:Edit)');
}

async function cloudflare(cfg, ip) {
  const zoneId = await cfZoneId(cfg);
  const name = cfg.hostname.trim();
  const records = await cfApi(cfg.token, `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`);
  if (records[0]) {
    if (records[0].content === ip) return 'Already up to date';
    await cfApi(cfg.token, `/zones/${zoneId}/dns_records/${records[0].id}`, { method: 'PATCH', body: JSON.stringify({ content: ip }) });
  } else {
    await cfApi(cfg.token, `/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'A', name, content: ip, ttl: 120, proxied: false }),
    });
  }
  return 'Updated';
}

async function cloudflareTxt(cfg, name, value) {
  const zoneId = await cfZoneId(cfg);
  const existing = await cfApi(cfg.token, `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`);
  for (const r of existing) await cfApi(cfg.token, `/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
  if (value) {
    await cfApi(cfg.token, `/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'TXT', name, content: value, ttl: 60 }),
    });
  }
}

async function dyndns2(server, cfg, ip) {
  const params = new URLSearchParams({ hostname: cfg.hostname.trim(), myip: ip });
  const text = await getText(`https://${server}/nic/update?${params}`, {
    headers: { authorization: basic(cfg.username, cfg.password) },
  });
  if (/^(good|nochg)/.test(text)) return text.startsWith('nochg') ? 'Already up to date' : 'Updated';
  const reasons = {
    badauth: 'wrong username or password',
    nohost: 'hostname not found in your account',
    notfqdn: 'hostname is not a fully qualified domain',
    abuse: 'account blocked for abuse',
    '!donator': 'feature not available on this account',
    911: 'provider is having problems, will retry',
  };
  throw new Error(`Provider answered "${text}"${reasons[text.split(' ')[0]] ? ` (${reasons[text.split(' ')[0]]})` : ''}`);
}

async function namecheap(cfg, ip) {
  const zone = cfg.zone.trim();
  const host = cfg.hostname.trim() === zone ? '@' : cfg.hostname.trim().replace(new RegExp(`\\.${zone.replace(/\./g, '\\.')}$`), '');
  const params = new URLSearchParams({ host, domain: zone, password: cfg.password, ip });
  const text = await getText(`https://dynamicdns.park-your-domain.com/update?${params}`);
  if (!/<ErrCount>0<\/ErrCount>/.test(text)) {
    throw new Error(`Namecheap: ${text.match(/<Err1>([^<]+)<\/Err1>/)?.[1] || 'update failed'}`);
  }
  return 'Updated';
}

async function custom(cfg, ip) {
  const url = cfg.url.replaceAll('{ip}', encodeURIComponent(ip)).replaceAll('{hostname}', encodeURIComponent(cfg.hostname || ''));
  await getText(url);
  return 'Updated';
}

async function pushUpdate(cfg, ip) {
  switch (cfg.provider) {
    case 'duckdns': return duckdns(cfg, ip);
    case 'cloudflare': return cloudflare(cfg, ip);
    case 'noip': return dyndns2('dynupdate.no-ip.com', cfg, ip);
    case 'dyndns2': return dyndns2(cfg.server.replace(/^https?:\/\//, '').replace(/\/.*$/, ''), cfg, ip);
    case 'namecheap': return namecheap(cfg, ip);
    case 'custom': return custom(cfg, ip);
    default: throw new Error('No DDNS provider configured');
  }
}

async function lookup(name) {
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  return resolver.resolve4(name);
}

/** For a name updated elsewhere: checks it points at this network's public IP. */
export async function checkName(name, ip, resolve4 = lookup) {
  if (!name) throw new Error('Enter the hostname your router or other program keeps updated');
  let addresses;
  try {
    addresses = await resolve4(name);
  } catch (err) {
    throw new Error(err.code === 'ENOTFOUND' || err.code === 'ENODATA' ? `${name} wasn't found in DNS` : `Couldn't look up ${name} (${err.code || err.message})`);
  }
  if (!addresses.includes(ip)) throw new Error(`${name} points at ${addresses.join(', ')}, but your public IP is ${ip}`);
  return 'Points at your home';
}

/** Sets (value) or clears (null) the _acme-challenge TXT record. Only some providers support it. */
export async function setAcmeTxt(domain, value) {
  const cfg = getSetting('ddns');
  if (cfg.provider === 'duckdns') return duckdns(cfg, null, value);
  if (cfg.provider === 'cloudflare') return cloudflareTxt(cfg, `_acme-challenge.${domain}`, value);
  throw new Error('DNS challenges need Duck DNS or Cloudflare as the DDNS provider. Use the HTTP challenge instead.');
}

export const supportsAcmeTxt = () => ['duckdns', 'cloudflare'].includes(getSetting('ddns').provider);

// ---------- scheduler ----------

export async function updateDdns({ force = false } = {}) {
  const cfg = getSetting('ddns');
  if (cfg.provider === 'none') return ddnsStatus();
  state.lastCheck = Date.now();
  try {
    const ip = await publicIp({ force });
    if (cfg.provider === 'external') {
      // Nothing to send; just check, every time, since the name can drift without Reelhouse noticing.
      const msg = await checkName(fullHostname(cfg), ip);
      if (state.ok !== true) log.info(`${fullHostname(cfg)}: ${msg} (${ip})`);
      Object.assign(state, { lastIp: ip, ok: true, message: `${msg} (${ip})` });
      return ddnsStatus();
    }
    const stale = !state.lastUpdate || Date.now() - state.lastUpdate > 24 * 60 * 60 * 1000;
    if (force || ip !== state.lastIp || state.ok === false || stale) {
      const msg = await pushUpdate(cfg, ip);
      Object.assign(state, { lastIp: ip, lastUpdate: Date.now(), ok: true, message: `${msg} → ${ip}` });
      log.info(`${fullHostname(cfg)}: ${msg} (${ip})`);
    }
  } catch (err) {
    Object.assign(state, { ok: false, message: err.message });
    log.warn(`Update failed: ${err.message}`);
  }
  return ddnsStatus();
}

export function startDdns() {
  clearInterval(timer);
  const cfg = getSetting('ddns');
  if (cfg.provider === 'none') return;
  Object.assign(state, { lastIp: null, lastUpdate: null, ok: null, message: null });
  void updateDdns();
  const minutes = Math.max(1, Number(cfg.intervalMinutes) || 5);
  timer = setInterval(() => void updateDdns(), minutes * 60 * 1000);
  timer.unref();
}

settingsEvents.on('change', (changed) => {
  if (changed.ddns) startDdns();
});
