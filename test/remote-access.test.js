// Remote access settings shared by every way in: the home's address (dynamic DNS) and the ports to open.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-remote-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { updateSettings, getSetting } = await import('../server/settings.js');
const { fullHostname, checkName } = await import('../server/remote/ddns.js');
const { wantedMappings } = await import('../server/remote/upnp.js');
const { endpointHost } = await import('../server/remote/wireguard.js');

let server;
let base;
let adminToken;

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'reelhouse', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  openDb(':memory:');
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?)", await hashPassword('correct horse'), Date.now());
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminToken = (await call('POST', '/api/auth/device', { body: { username: 'dave', password: 'correct horse', device: 'test runner' } })).data.token;
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a name kept updated elsewhere is used as is; one left over after switching DDNS off is not', () => {
  assert.equal(fullHostname({ provider: 'external', hostname: ' myhome.ddns.net ' }), 'myhome.ddns.net');
  assert.equal(fullHostname({ provider: 'duckdns', hostname: 'myhome' }), 'myhome.duckdns.org');
  assert.equal(fullHostname({ provider: 'none', hostname: 'myhome.duckdns.org' }), '');

  // Switching the provider off keeps the old name in the settings, but devices mustn't be sent to it.
  updateSettings({ ddns: { provider: 'none', hostname: 'stale.example.net' } });
  updateSettings({ wireguard: { endpoint: '' } });
  assert.notEqual(endpointHost(getSetting('wireguard')), 'stale.example.net');
  updateSettings({ wireguard: { endpoint: 'home.example.net' } });
  assert.equal(endpointHost(getSetting('wireguard')), 'home.example.net');
  updateSettings({ wireguard: { endpoint: '' } });
});

test('a name kept updated elsewhere is checked against the public IP', async () => {
  const dns = (answers) => async (name) => {
    if (!(name in answers)) throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
    return answers[name];
  };
  const resolve = dns({ 'myhome.ddns.net': ['203.0.113.7'], 'old.ddns.net': ['198.51.100.1'] });
  assert.equal(await checkName('myhome.ddns.net', '203.0.113.7', resolve), 'Points at your home');
  await assert.rejects(checkName('old.ddns.net', '203.0.113.7', resolve), /points at 198\.51\.100\.1, but your public IP is 203\.0\.113\.7/);
  await assert.rejects(checkName('typo.ddns.net', '203.0.113.7', resolve), /wasn't found/);
  await assert.rejects(checkName('', '203.0.113.7', resolve), /Enter the hostname/);
});

test('UPnP opens the web port only when wanted, so WireGuard alone keeps Reelhouse off the internet', () => {
  assert.equal(getSetting('upnp').enabled, false, 'UPnP is off by default');
  assert.equal(getSetting('upnp').openWebPort, false, 'and so is opening the web port');
  updateSettings({ upnp: { openWebPort: true, externalPort: 0 } });
  const web = getSetting('port'); // HTTPS is off by default
  updateSettings({ wireguard: { enabled: true, publicKey: 'x'.repeat(43) + '=', listenPort: 51820 }, appTunnel: { enabled: true, listenPort: 51821 } });
  const ports = () => wantedMappings().map((m) => `${m.protocol} ${m.externalPort}`);
  assert.deepEqual(ports(), [`TCP ${web}`, 'UDP 51820', 'UDP 51821']);
  updateSettings({ upnp: { openWebPort: false } });
  assert.deepEqual(ports(), ['UDP 51820', 'UDP 51821']);
  updateSettings({ wireguard: { enabled: false }, appTunnel: { enabled: false } });
  assert.deepEqual(ports(), []);
  updateSettings({ upnp: { openWebPort: true, externalPort: 443 } });
  assert.deepEqual(ports(), ['TCP 443']);
});

test('the server has a stable id apps use to recognise it, which reveals nothing of its secret', async () => {
  const a = await call('GET', '/api/server');
  const b = await call('GET', '/api/server');
  assert.equal(a.status, 200);
  assert.match(a.data.id, /^[0-9a-f]{20}$/);
  assert.equal(a.data.id, b.data.id);
  assert.ok(!getSetting('secret').includes(a.data.id));
});

test('addresses that go into device configs are host names, without a port or anything else', async () => {
  const put = (body) => call('PUT', '/api/settings', { token: adminToken, body });
  assert.equal((await put({ ddns: { provider: 'none', hostname: 'home.example.net\nPostUp = id' } })).status, 400);
  assert.equal((await put({ ddns: { provider: 'nonsense' } })).status, 400);
  assert.equal((await put({ wireguard: { endpoint: 'home.example.net:51820' } })).status, 400, 'the port is a setting of its own');
  assert.equal((await put({ wireguard: { endpoint: 'home.example.net\n[Peer]' } })).status, 400);
  const ok = await put({ wireguard: { endpoint: ' home.example.net ' }, upnp: { openWebPort: 0 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.wireguard.endpoint, 'home.example.net');
  assert.equal(ok.data.settings.upnp.openWebPort, false);
});
