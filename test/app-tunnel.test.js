// Pairing the Reelhouse app and the built-in app tunnel. The last test runs the real tunnel helper and the
// tunnel-check client when they've been built (tunnel/bin), and is skipped otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-tunnel-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run, get, all } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { updateSettings } = await import('../server/settings.js');
const { setTunnelSecret } = await import('../server/remote/tunnel-identity.js');
const { cleanupPeers, startAppTunnel, stopAppTunnel, helperPath } = await import('../server/remote/apptunnel.js');
const { ROOT_DIR } = await import('../server/lib/paths.js');
const { LOGOUT_KEY_GRACE_MS } = await import('../server/routes/auth.js');
const { recentLogs } = await import('../server/lib/log.js');

let server;
let base;
let adminToken;
const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };

async function call(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...H, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, data };
}

const payloadOf = (link) => JSON.parse(Buffer.from(new URL(link).searchParams.get('d'), 'base64url').toString());

before(async () => {
  openDb(':memory:');
  const t = Date.now();
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?)", await hashPassword('correct horse'), t);
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (2, 'kid', ?, 0, ?)", await hashPassword('kid password'), t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  adminToken = (await call('POST', '/api/auth/device', { body: { username: 'dave', password: 'correct horse', device: 'test runner' } })).data.token;
});

after(() => {
  stopAppTunnel();
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const kidToken = async () => (await call('POST', '/api/auth/device', { body: { username: 'kid', password: 'kid password', device: 'kid laptop' } })).data.token;

test('pairing without the app tunnel: a one-time code for a device sign-in', async () => {
  updateSettings({ appTunnel: { enabled: false } });
  const kid = await kidToken();
  const { status, data } = await call('POST', '/api/me/pairings', { token: kid });
  assert.equal(status, 200);
  assert.match(data.code, /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(data.tunnel, false);
  assert.match(data.qr, /^<svg/);
  const payload = payloadOf(data.link);
  assert.deepEqual([payload.v, payload.code, payload.tunnel], [1, data.code, null]);
  assert.ok(payload.expiresAt > Date.now() + 9 * 60 * 1000);
  // The app pairs at a direct address only where this same server answers.
  assert.equal(payload.id, (await call('GET', '/api/server')).data.id);

  // Codes are forgiving about case and the dash, and work once.
  const typed = data.code.toLowerCase().replace('-', ' ');
  const paired = await call('POST', '/api/auth/pair', { body: { code: typed, device: 'Pixel 8' } });
  assert.equal(paired.status, 200);
  assert.equal(paired.data.user.username, 'kid');
  assert.equal(paired.data.tunnel, null);
  const me = await call('GET', '/api/me', { token: paired.data.token });
  assert.equal(me.data.user.username, 'kid');
  const again = await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'Pixel 8' } });
  assert.equal(again.status, 401);
  // The pairing screen follows its own pairing; nobody else's.
  assert.deepEqual((await call('GET', `/api/me/pairings/${data.id}`, { token: kid })).data, { status: 'used', device: 'Pixel 8' });
  assert.equal((await call('GET', `/api/me/pairings/${data.id}`, { token: adminToken })).data.status, 'expired');
  const devices = (await call('GET', '/api/me/devices', { token: kid })).data.devices;
  assert.ok(devices.some((d) => d.name === 'Pixel 8' && d.tunnel === false));
});

test('pairing needs a device name and a signed-in user', async () => {
  assert.equal((await call('POST', '/api/me/pairings')).status, 401);
  assert.equal((await call('POST', '/api/auth/pair', { body: { code: 'AAAA-AAAA' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/pair', { body: { code: 'AAAA-AAAA', device: 'x' } })).status, 401);
});

test('an admin can pair a phone for someone else, without their password', async () => {
  updateSettings({ appTunnel: { enabled: false } });
  const kid = await kidToken();
  assert.equal((await call('POST', '/api/users/1/pairings', { token: kid })).status, 403, 'admins only');
  assert.equal((await call('POST', '/api/users/99/pairings', { token: adminToken })).status, 404);

  const { status, data } = await call('POST', '/api/users/2/pairings', { token: adminToken });
  assert.equal(status, 200);
  assert.match(data.qr, /^<svg/);
  assert.equal(payloadOf(data.link).code, data.code);
  assert.ok(recentLogs().some((l) => l.msg.includes('Admin "dave" made a pairing code for "kid"')), 'logged');
  assert.equal((await call('GET', `/api/users/2/pairings/${data.id}`, { token: adminToken })).data.status, 'waiting');
  assert.equal((await call('GET', `/api/users/2/pairings/${data.id}`, { token: kid })).status, 403);

  const paired = await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'Kid’s phone' } });
  assert.equal(paired.data.user.username, 'kid', 'the phone is signed in as them, not the admin');
  assert.deepEqual((await call('GET', `/api/users/2/pairings/${data.id}`, { token: adminToken })).data, { status: 'used', device: 'Kid’s phone' });
  assert.ok((await call('GET', '/api/me/devices', { token: kid })).data.devices.some((d) => d.name === 'Kid’s phone'));

  // Closing the dialog unused cancels the code.
  const second = (await call('POST', '/api/users/2/pairings', { token: adminToken })).data;
  assert.deepEqual((await call('DELETE', `/api/users/2/pairings/${second.id}`, { token: adminToken })).data, { cancelled: true });
  assert.equal((await call('POST', '/api/auth/pair', { body: { code: second.code, device: 'x' } })).status, 401);
});

test('with the app tunnel on, each pairing carries its own tunnel key, tied to the sign-in it becomes', async () => {
  updateSettings({ appTunnel: { enabled: true, endpoint: 'home.example.net' } });
  const kid = await kidToken();
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  assert.equal(data.tunnel, true);
  const { tunnel } = payloadOf(data.link);
  assert.equal(tunnel.endpoint, 'home.example.net:51821');
  assert.equal(tunnel.url, 'http://10.78.0.1');
  assert.match(tunnel.address, /^10\.78\.0\.\d+$/);
  assert.equal(Buffer.from(tunnel.privateKey, 'base64').length, 32);
  const peer = get('SELECT * FROM tunnel_peers WHERE address = ?', tunnel.address);
  assert.ok(peer.pending_until > Date.now(), 'pending until the code is used');
  assert.equal(get('SELECT COUNT(*) AS n FROM tunnel_peers WHERE public_key = ?', tunnel.publicKey).n, 0, 'the server key is not a device key');

  const paired = await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'Pixel 8' } });
  // The answer repeats the tunnel settings, without the private key.
  assert.deepEqual(paired.data.tunnel, { endpoint: tunnel.endpoint, publicKey: tunnel.publicKey, presharedKey: tunnel.presharedKey, address: tunnel.address, url: tunnel.url });
  assert.equal(get('SELECT pending_until FROM tunnel_peers WHERE id = ?', peer.id).pending_until, null);
  assert.equal(get('SELECT name FROM tunnel_peers WHERE id = ?', peer.id).name, 'Pixel 8');
  const device = (await call('GET', '/api/me/devices', { token: kid })).data.devices.find((d) => d.tunnel);
  assert.ok(device);

  // Signing the phone out takes its tunnel key away.
  assert.equal((await call('DELETE', `/api/me/devices/${device.id}`, { token: kid })).status, 200);
  assert.equal(get('SELECT COUNT(*) AS n FROM tunnel_peers WHERE id = ?', peer.id).n, 0);
});

test('an app signing out keeps its tunnel key just long enough for the answer to get back through the tunnel', async () => {
  updateSettings({ appTunnel: { enabled: true } });
  const kid = await kidToken();
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  const { address } = payloadOf(data.link).tunnel;
  const paired = await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'phone signing out' } });
  assert.equal((await call('POST', '/api/auth/logout', { token: paired.data.token })).status, 200);
  assert.equal((await call('GET', '/api/me', { token: paired.data.token })).status, 401, 'the sign-in is gone at once');
  assert.equal(get('SELECT COUNT(*) AS n FROM tunnel_peers WHERE address = ?', address).n, 1, 'the key, a moment later');
  await new Promise((r) => setTimeout(r, LOGOUT_KEY_GRACE_MS + 300));
  assert.equal(get('SELECT COUNT(*) AS n FROM tunnel_peers WHERE address = ?', address).n, 0);
});

test('at home the app can pair with its own key, so its private key never leaves the phone', async () => {
  updateSettings({ appTunnel: { enabled: true } });
  const kid = await kidToken();
  const own = crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x;
  const ownKey = Buffer.from(own, 'base64url').toString('base64');
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  const qrKeyAddress = payloadOf(data.link).tunnel.address;
  assert.equal((await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'phone', publicKey: 'nonsense' } })).status, 400);
  const paired = await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'phone', publicKey: ownKey } });
  assert.equal(paired.status, 200);
  assert.equal(paired.data.tunnel.address, qrKeyAddress);
  assert.equal(get('SELECT public_key FROM tunnel_peers WHERE address = ?', qrKeyAddress).public_key, ownKey);
  // Through the tunnel the key stays (swapping it would cut the connection the answer goes back on).
  const second = (await call('POST', '/api/me/pairings', { token: kid })).data;
  const secondAddress = payloadOf(second.link).tunnel.address;
  const before = get('SELECT public_key FROM tunnel_peers WHERE address = ?', secondAddress).public_key;
  setTunnelSecret('s');
  try {
    const other = Buffer.from(crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
    const viaTunnel = await call('POST', '/api/auth/pair', {
      body: { code: second.code, device: 'phone 2', publicKey: other },
      headers: { 'x-reelhouse-tunnel': 's', 'x-reelhouse-tunnel-peer': secondAddress },
    });
    assert.equal(viaTunnel.status, 200);
  } finally {
    setTunnelSecret(null);
  }
  assert.equal(get('SELECT public_key FROM tunnel_peers WHERE address = ?', secondAddress).public_key, before);
});

test('closing the pairing screen cancels the code and its tunnel key', async () => {
  updateSettings({ appTunnel: { enabled: true } });
  const kid = await kidToken();
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  const address = payloadOf(data.link).tunnel.address;
  assert.deepEqual((await call('DELETE', `/api/me/pairings/${data.id}`, { token: adminToken })).data, { cancelled: false }, 'only its owner can');
  assert.deepEqual((await call('DELETE', `/api/me/pairings/${data.id}`, { token: kid })).data, { cancelled: true });
  assert.equal(get('SELECT COUNT(*) AS n FROM tunnel_peers WHERE address = ?', address).n, 0);
  assert.equal((await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'phone' } })).status, 401);
});

test('a user has at most three open pairings, so nobody can use up the tunnel addresses', async () => {
  updateSettings({ appTunnel: { enabled: true } });
  const kid = await kidToken();
  run('DELETE FROM pairings WHERE user_id = 2');
  const made = [];
  for (let i = 0; i < 5; i++) made.push((await call('POST', '/api/me/pairings', { token: kid })).data);
  const open = all('SELECT id FROM pairings WHERE user_id = 2 AND used_at IS NULL').map((r) => r.id).sort();
  assert.deepEqual(open, made.slice(2).map((p) => p.id).sort(), 'the newest three stay');
  assert.equal((await call('GET', `/api/me/pairings/${made[0].id}`, { token: kid })).data.status, 'expired');
  const addresses = made.map((p) => payloadOf(p.link).tunnel.address);
  assert.equal(get(`SELECT COUNT(*) AS n FROM tunnel_peers WHERE address IN (${addresses.map(() => '?').join(',')})`, ...addresses).n, 3);
  assert.equal((await call('POST', '/api/auth/pair', { body: { code: made[0].code, device: 'phone' } })).status, 401);
});

test('a paired app can ask for its current tunnel settings (the public address may change)', async () => {
  updateSettings({ appTunnel: { enabled: true, endpoint: 'old.example.net' } });
  const kid = await kidToken();
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  const paired = (await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'phone' } })).data;
  updateSettings({ appTunnel: { endpoint: 'new.example.net' } });
  const now = (await call('GET', '/api/me/tunnel', { token: paired.token })).data.tunnel;
  assert.equal(now.endpoint, 'new.example.net:51821');
  assert.equal(now.address, paired.tunnel.address);
  assert.equal(now.privateKey, undefined);
  assert.deepEqual((await call('GET', '/api/me/tunnel', { token: kid })).data, { tunnel: null }, 'not for a sign-in without a tunnel key');
  updateSettings({ appTunnel: { endpoint: 'home.example.net' } });
});

test('the address of the tunnel itself is never offered as a direct address, whatever the subnet size', async () => {
  run('DELETE FROM pairings');
  run('DELETE FROM tunnel_peers');
  updateSettings({ appTunnel: { enabled: false, subnet: '10.80.0.0/16' } });
  // fetch() won't send a Host header of our choosing; http.request will.
  const pairAs = (token, host) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/me/pairings`, { method: 'POST', headers: { ...H, host, authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const kid = await kidToken();
    const viaTunnel = await pairAs(kid, '10.80.5.1');
    assert.ok(!viaTunnel.urls.some((u) => u.includes('10.80.5.1')), JSON.stringify(viaTunnel.urls));
    const lan = await pairAs(kid, '192.168.1.20:8484');
    assert.equal(lan.urls[0], 'http://192.168.1.20:8484');
  } finally {
    run('DELETE FROM pairings');
    updateSettings({ appTunnel: { subnet: '10.78.0.0/24' } });
  }
});

test('an unused pairing expires together with its tunnel key', async () => {
  updateSettings({ appTunnel: { enabled: true } });
  const kid = await kidToken();
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  const address = payloadOf(data.link).tunnel.address;
  run('UPDATE pairings SET expires_at = ?', Date.now() - 1);
  run('UPDATE tunnel_peers SET pending_until = ? WHERE address = ?', Date.now() - 1, address);
  assert.equal((await call('GET', `/api/me/pairings/${data.id}`, { token: kid })).data.status, 'expired');
  assert.equal((await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'late phone' } })).status, 401);
  cleanupPeers();
  assert.equal(get('SELECT COUNT(*) AS n FROM tunnel_peers WHERE address = ?', address).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM pairings').n, 0);
});

test('changing the password signs other devices out and drops their tunnel keys', async () => {
  updateSettings({ appTunnel: { enabled: true } });
  const kid = await kidToken();
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  await call('POST', '/api/auth/pair', { body: { code: data.code, device: 'phone' } });
  assert.ok(get('SELECT COUNT(*) AS n FROM tunnel_peers WHERE pending_until IS NULL').n >= 1);
  const changed = await call('POST', '/api/me/password', { token: kid, body: { current: 'kid password', next: 'kid password 2' } });
  assert.equal(changed.status, 200);
  assert.equal(get("SELECT COUNT(*) AS n FROM tunnel_peers WHERE user_id = 2").n, 0);
  run('UPDATE users SET password_hash = ? WHERE id = 2', await hashPassword('kid password'));
});

test('only the tunnel helper, holding the secret, can make a request count as tunnelled', async () => {
  setTunnelSecret('the-secret-of-this-run');
  try {
    const through = await call('GET', '/api/server', { headers: { 'x-reelhouse-tunnel': 'the-secret-of-this-run', 'x-reelhouse-tunnel-peer': '10.78.0.9' } });
    assert.deepEqual(through.data.network, { ip: '10.78.0.9', local: false, wireguard: false, tunnel: true });
    const forged = await call('GET', '/api/server', { headers: { 'x-reelhouse-tunnel': 'a-guess', 'x-reelhouse-tunnel-peer': '10.78.0.9' } });
    assert.equal(forged.data.network.tunnel, false);
    assert.equal(forged.data.network.ip, '127.0.0.1');
  } finally {
    setTunnelSecret(null);
  }
  const off = await call('GET', '/api/server', { headers: { 'x-reelhouse-tunnel': 'the-secret-of-this-run', 'x-reelhouse-tunnel-peer': '10.78.0.9' } });
  assert.equal(off.data.network.tunnel, false, 'no helper running, nothing counts as tunnelled');
});

test('app tunnel settings are checked', async () => {
  const put = (appTunnel, wireguard) => call('PUT', '/api/settings', { token: adminToken, body: { appTunnel, ...(wireguard ? { wireguard } : {}) } });
  assert.equal((await put({ listenPort: 51820 }, { enabled: true, listenPort: 51820 })).status, 400);
  await call('PUT', '/api/settings', { token: adminToken, body: { wireguard: { enabled: false } } });
  assert.equal((await put({ listenPort: 70000 })).status, 400);
  assert.equal((await put({ subnet: 'nonsense' })).status, 400);
  assert.equal((await put({ endpoint: 'home.example.net:51821' })).status, 400, 'the port is a setting of its own');
  assert.equal((await put({ endpoint: 'home example' })).status, 400);
  const kid = await kidToken();
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  assert.ok(data.tunnel);
  assert.equal((await put({ subnet: '10.79.0.0/24' })).status, 400, 'not while devices have keys in the old subnet');
  const st = await call('GET', '/api/remote/status', { token: adminToken });
  assert.equal(st.status, 200);
  assert.ok(st.data.appTunnel.peers.some((p) => p.pending && p.user === 'kid'));
  const settings = (await call('GET', '/api/settings', { token: adminToken })).data.settings;
  assert.equal(settings.appTunnel.privateKey, '••••••••', 'the private key never reaches the browser');
});

const binDir = path.join(ROOT_DIR, 'tunnel', 'bin');
const checkPath = path.join(binDir, process.platform === 'win32' ? 'tunnel-check.exe' : 'tunnel-check');
const built = fs.existsSync(helperPath()) && fs.existsSync(checkPath);

function tunnelCheck(args) {
  return new Promise((resolve) => {
    execFile(checkPath, args, { timeout: 60000 }, (err, stdout) => {
      const steps = Object.fromEntries(stdout.trim().split('\n').filter(Boolean).map((l) => {
        const o = JSON.parse(l);
        return [o.step, o];
      }));
      resolve({ code: err ? err.code ?? 1 : 0, steps });
    });
  });
}

/** A UDP port nothing uses, as the system hands them out. */
async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

test('end to end: pair through the real tunnel and use the API', { skip: !built && 'tunnel/bin not built' }, async () => {
  // A UDP port the system says is free: a random one could land in a range Windows reserves (e.g. for Hyper-V/WSL).
  const udp = await freeUdpPort();
  // Like the first time in the UI: no keys yet, turned on by a settings change (making the keys is a settings
  // change too, which once started a second helper that kept the port).
  run('DELETE FROM tunnel_peers');
  updateSettings({ appTunnel: { enabled: false, privateKey: '', publicKey: '', listenPort: udp, endpoint: '127.0.0.1' } });
  startAppTunnel(server.address().port);
  updateSettings({ appTunnel: { enabled: true } });
  let running = false;
  for (let i = 0; i < 50 && !running; i++) {
    running = (await call('GET', '/api/remote/status', { token: adminToken })).data.appTunnel.running;
    if (!running) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(running, 'the endpoint starts');
  const kid = await kidToken();
  const { data } = await call('POST', '/api/me/pairings', { token: kid });
  const first = await tunnelCheck(['-pair', '-get', '/api/server', data.link]);
  assert.equal(first.code, 0, JSON.stringify(first.steps));
  assert.deepEqual(first.steps.get.body.network, { ip: payloadOf(data.link).tunnel.address, local: false, wireguard: false, tunnel: true });
  assert.equal(first.steps.pair.user, 'kid');
  assert.equal(first.steps.me.body.network.tunnel, true);

  // The admin sees the device's handshake.
  const st = (await call('GET', '/api/remote/status', { token: adminToken })).data.appTunnel;
  const peer = st.peers.find((p) => p.address === payloadOf(data.link).tunnel.address);
  assert.ok(peer && !peer.pending && peer.lastHandshake > Date.now() - 60000, JSON.stringify(st.peers));

  // Signed out: the same tunnel settings get no answer any more.
  const device = (await call('GET', '/api/me/devices', { token: kid })).data.devices.find((d) => d.name.startsWith('tunnel-check'));
  await call('DELETE', `/api/me/devices/${device.id}`, { token: kid });
  const after = await tunnelCheck(['-timeout', '5s', data.link]);
  assert.notEqual(after.code, 0);
  assert.equal(after.steps.get.ok, false);

  // At home: the device's own key, the code used directly, then the tunnel with the server's answer.
  const atHome = (await call('POST', '/api/me/pairings', { token: kid })).data;
  const own = await tunnelCheck(['-own-key', '-direct', base, atHome.link]);
  assert.equal(own.code, 0, JSON.stringify(own.steps));
  assert.equal(own.steps['pair-direct'].user, 'kid');
  assert.equal(own.steps.me.body.network.tunnel, true);
  // The QR code's key was replaced, so it no longer works.
  const qrKey = await tunnelCheck(['-timeout', '5s', atHome.link]);
  assert.notEqual(qrKey.code, 0);
});
