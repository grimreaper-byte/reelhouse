// The phone as a remote (server/remote.js): devices on the event stream as targets, only the same person's on the
// same network listed, commands down that one stream, the answers back to the phone, and what each is playing.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-remote-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { updateSettings } = await import('../server/settings.js');
const { setTunnelSecret } = await import('../server/remote/tunnel-identity.js');
const { setPeerStatusForTests } = await import('../server/remote/apptunnel.js');
const { publicIp } = await import('../server/remote/net.js');
const { networkOf, networkOfIp, clearRemote } = await import('../server/remote.js');
const { clearStreams } = await import('../server/activity.js');

let server;
let base;
const SECRET = 'tunnel-secret-for-tests';
const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };
const streams = [];

/** Where a request comes from: { ip } through a proxy that says so, { tunnel } through the app tunnel, or home. */
function from(where = {}) {
  if (where.ip) return { 'x-forwarded-for': where.ip };
  if (where.tunnel) return { 'x-reelhouse-tunnel': SECRET, 'x-reelhouse-tunnel-peer': where.tunnel };
  return {};
}

async function call(method, p, { token, body, where } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...H, ...from(where), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const signIn = async (username, device) => (await call('POST', '/api/auth/device', {
  body: { username, password: 'a long password', device },
})).data.token;

/** Opens an event stream (as a target and/or a phone) and collects its events. */
async function listen(token, query, where) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events?${query}`, {
    headers: { ...from(where), authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const events = [];
  const waiting = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) {
            events.push({ type, data: JSON.parse(data) });
            for (const w of waiting.splice(0)) w();
          }
        }
      }
    } catch {
      // closed
    }
  })();
  const stream = {
    events,
    of: (type) => events.filter((e) => e.type === type).map((e) => e.data),
    async next(type, timeout = 2000) {
      const seen = stream.of(type).length;
      const deadline = Date.now() + timeout;
      while (stream.of(type).length <= seen) {
        if (Date.now() > deadline) throw new Error(`no ${type} event`);
        await new Promise((r) => {
          waiting.push(r);
          setTimeout(r, 50);
        });
      }
      return stream.of(type).at(-1);
    },
    close: () => controller.abort(),
  };
  streams.push(stream);
  if (query.includes('target=')) await stream.next('remote-hello').catch(() => {});
  return stream;
}

const until = async (check, timeout = 2000) => {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const targets = async (token, where) => (await call('GET', '/api/remote/targets', { token, where })).data.targets;
const command = (token, id, body, where) => call('POST', `/api/remote/targets/${id}/commands`, { token, body, where });

before(async () => {
  openDb(':memory:');
  const t = Date.now();
  const file = path.join(dataDir, 'film.mp4');
  fs.writeFileSync(file, 'x');
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'TV', 'show', '[]', ?)", t, t);
  run(`INSERT INTO items (id, library_id, type, title, sort_title, file_path, duration, added_at, updated_at)
       VALUES (1, 1, 'movie', 'A Film', 'a film', ?, 6000, ?, ?)`, file, t, t);
  run(`INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at) VALUES (10, 2, 'show', 'A Show', 'a show', ?, ?)`, t, t);
  for (const [id, n] of [[11, 1], [12, 2]]) {
    run(`INSERT INTO items (id, library_id, type, title, sort_title, show_id, season_number, episode_number, file_path, duration, added_at, updated_at)
         VALUES (?, 2, 'episode', ?, ?, 10, 1, ?, ?, 1500, ?, ?)`, id, `Episode ${n}`, `episode ${n}`, n, `${file}.${n}`, t, t);
  }
  const pw = await hashPassword('a long password');
  run(`INSERT INTO users (id, username, password_hash, is_admin, library_access, created_at) VALUES
       (1, 'dave', ?, 1, NULL, ?), (2, 'sam', ?, 0, NULL, ?)`, pw, t, pw, t);
  run(`INSERT INTO tunnel_peers (id, user_id, name, public_key, preshared_key, address, created_at)
       VALUES ('p1', 1, 'Phone', 'PHONEKEY', 'x', '10.78.0.2', ?), ('p2', 1, 'Fire TV', 'TVKEY', 'x', '10.78.0.3', ?)`, t, t);
  updateSettings({ trustProxy: true });
  setTunnelSecret(SECRET);
  // The server's own public address (a router that loops connections back gives it to devices at home).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('203.0.113.1');
  await publicIp({ force: true });
  globalThis.fetch = realFetch;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await new Promise((r) => setTimeout(r, 30));
  clearRemote();
  clearStreams();
});

after(() => {
  for (const s of streams.splice(0)) s.close();
  server?.closeAllConnections?.();
  server?.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('which network an address is on', () => {
  assert.equal(networkOfIp('192.168.0.20'), 'home');
  assert.equal(networkOfIp('::ffff:10.0.0.5'), 'home');
  assert.equal(networkOfIp('203.0.113.1'), 'home', "the server's own public address");
  assert.equal(networkOfIp('198.51.100.7'), '198.51.100.7');
  assert.equal(networkOfIp('2001:db8:1:2:aa:bb:cc:dd'), '2001:db8:1:2::/64');
  assert.equal(networkOfIp('2001:0db8:0001:0002::1'), '2001:db8:1:2::/64', 'the same /64 written another way');
  assert.equal(networkOfIp('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(networkOfIp('fd00::1'), 'home');
  assert.equal(networkOfIp('2001:db8::1::2'), null, 'not an address');
  assert.equal(networkOfIp(''), null);
  assert.equal(networkOf({ wireguard: true }), null, "the admin's own WireGuard: nobody knows where");
  assert.equal(networkOf({ tunnel: '10.78.0.99' }), null, 'a tunnel address nobody has');
  setPeerStatusForTests([{ publicKey: 'PHONEKEY', endpoint: '198.51.100.7:40000' }, { publicKey: 'TVKEY', endpoint: '[2001:db8:5:6::9]:5000' }]);
  assert.equal(networkOf({ tunnel: '10.78.0.2' }), '198.51.100.7', "a tunnel device: where its tunnel traffic comes from");
  assert.equal(networkOf({ tunnel: '10.78.0.3' }), '2001:db8:5:6::/64');
});

test('a phone at home lists its owner’s devices at home, each once, but not itself or anyone else’s', async () => {
  const phone = await signIn('dave', 'Pixel');
  const tv = await signIn('dave', 'Fire TV');
  const kodi = await signIn('dave', 'Kodi');
  const samsTv = await signIn('sam', 'Sam’s TV');
  await listen(tv, 'target=tv');
  await listen(tv, 'target=tv'); // the app reconnected before the old stream went: listed once
  await listen(kodi, 'target=kodi');
  await listen(samsTv, 'target=tv');
  await listen(phone, 'target=phone&controller=1'); // a phone that may be controlled itself
  const list = await targets(phone);
  assert.deepEqual(list.map((t) => [t.kind, t.name]), [['tv', 'Fire TV'], ['kodi', 'Kodi']]);
  assert.equal(list[0].state, null, 'not playing anything');
  // The TV sees the phone (switched on there), not itself.
  assert.deepEqual((await targets(tv)).map((t) => t.name).sort(), ['Kodi', 'Pixel']);
});

test('only the same network: a phone away from home sees its devices where it is, not those at home', async () => {
  const phone = await signIn('dave', 'Pixel');
  const homeTv = await signIn('dave', 'Home TV');
  const friendsTv = await signIn('dave', 'Holiday TV');
  const browser = await signIn('dave', 'Laptop');
  await listen(homeTv, 'target=tv');
  await listen(friendsTv, 'target=tv', { ip: '198.51.100.7' });
  await listen(browser, 'target=web', { ip: '198.51.100.8' });
  assert.deepEqual((await targets(phone, { ip: '198.51.100.7' })).map((t) => t.name), ['Holiday TV']);
  assert.deepEqual((await targets(phone)).map((t) => t.name), ['Home TV']);
  assert.deepEqual((await targets(phone, { ip: '192.0.2.50' })).map((t) => t.name), []);

  // Through the tunnel: matched by where the tunnel traffic comes from.
  setPeerStatusForTests([{ publicKey: 'PHONEKEY', endpoint: '198.51.100.7:40000' }]);
  assert.deepEqual((await targets(phone, { tunnel: '10.78.0.2' })).map((t) => t.name), ['Holiday TV']);
  setPeerStatusForTests([{ publicKey: 'PHONEKEY', endpoint: '192.168.0.40:40000' }]);
  assert.deepEqual((await targets(phone, { tunnel: '10.78.0.2' })).map((t) => t.name), ['Home TV'], 'tunnelling from home');
  setPeerStatusForTests([]);
  assert.deepEqual(await targets(phone, { tunnel: '10.78.0.2' }), [], 'nobody knows where: nothing');

  // A command from somewhere else is refused, even with the id.
  const [holiday] = await targets(phone, { ip: '198.51.100.7' });
  const refused = await command(phone, holiday.id, { type: 'pause' });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error, "Holiday TV isn't on the same network as this phone.");
});

test('commands go down that one device’s stream, and its answer goes back to the phone that sent it', async () => {
  const phone = await signIn('dave', 'Pixel');
  const otherPhone = await signIn('dave', 'Tablet');
  const tv = await signIn('dave', 'Fire TV');
  const kodi = await signIn('dave', 'Kodi');
  const tvStream = await listen(tv, 'target=tv');
  const kodiStream = await listen(kodi, 'target=kodi');
  const phoneStream = await listen(phone, 'controller=1');
  const tabletStream = await listen(otherPhone, 'controller=1');
  const [target] = (await targets(phone)).filter((t) => t.name === 'Fire TV');

  const sent = await command(phone, target.id, { type: 'play', itemId: 1, start: 90 });
  assert.equal(sent.status, 202);
  const got = await tvStream.next('remote');
  assert.deepEqual(got, { id: sent.data.commandId, type: 'play', itemId: 1, start: 90, from: 'Pixel' });
  assert.equal(kodiStream.of('remote').length, 0, 'only that device');

  // Only the device itself may answer.
  assert.equal((await call('POST', `/api/remote/commands/${got.id}/done`, { token: kodi, body: { ok: true } })).status, 404);
  assert.equal((await call('POST', `/api/remote/commands/${got.id}/done`, { token: tv, body: { ok: false, problem: 'blocked' } })).status, 200);
  assert.deepEqual(await phoneStream.next('remote-done'), { id: got.id, targetId: target.id, ok: false, problem: 'blocked' });
  assert.equal(tabletStream.of('remote-done').length, 0, 'only the phone that sent it');
  assert.equal((await call('POST', `/api/remote/commands/${got.id}/done`, { token: tv, body: { ok: true } })).status, 404, 'answered once');

  for (const [body, status] of [
    [{ type: 'seek', position: 600 }, 202], [{ type: 'skip', seconds: -10 }, 202], [{ type: 'pause' }, 202],
    [{ type: 'resume' }, 202], [{ type: 'stop' }, 202], [{ type: 'dance' }, 400], [{ type: 'seek', position: -1 }, 400],
    [{ type: 'skip', seconds: 0 }, 400], [{ type: 'play', itemId: 999 }, 404], [{ type: 'play', itemId: 1, start: 'x' }, 400],
    [{ type: 'next' }, 409],
  ]) assert.equal((await command(phone, target.id, body)).status, status, JSON.stringify(body));
  assert.deepEqual(tvStream.of('remote').slice(1, 3).map((c) => [c.type, c.position ?? c.seconds]), [['seek', 600], ['skip', -10]]);

  // Someone else can't, even with the id.
  const sam = await signIn('sam', 'Sam’s phone');
  assert.equal((await command(sam, target.id, { type: 'pause' })).status, 404);
});

test('what a device plays comes from its progress reports, and its owner’s phones hear when it changes', async () => {
  const phone = await signIn('dave', 'Pixel');
  const tv = await signIn('dave', 'Fire TV');
  await listen(tv, 'target=tv');
  const phoneStream = await listen(phone, 'controller=1');
  const [target] = await targets(phone);
  const report = (state, position) => call('POST', '/api/progress', {
    token: tv, body: { itemId: 11, playId: 'play-1', position, duration: 1500, state, mode: 'direct' },
  });
  await report('playing', 100);
  const heard = await phoneStream.next('remote-state');
  assert.equal(heard.targetId, target.id);
  assert.deepEqual({ ...heard.state, age: 0 }, {
    itemId: 11, title: 'Episode 1', show: 'A Show', season: 1, episode: 1, position: 100, duration: 1500,
    state: 'playing', live: false, age: 0,
  });
  await report('paused', 130);
  assert.equal((await phoneStream.next('remote-state')).state.state, 'paused');
  assert.equal((await targets(phone))[0].state.position, 130);

  // next and previous: the episode after or before, for the device to play.
  const next = await command(phone, target.id, { type: 'next' });
  assert.equal(next.status, 202);
  assert.equal((await command(phone, target.id, { type: 'previous' })).data.error, 'This is the first episode.');

  await report('stopped', 140);
  assert.equal((await phoneStream.next('remote-state')).state, null, 'stopped: nothing playing');
});

test('a device that goes away drops off the list, and the phones are told to look again', async () => {
  const phone = await signIn('dave', 'Pixel');
  const tv = await signIn('dave', 'Fire TV');
  const phoneStream = await listen(phone, 'controller=1');
  const tvStream = await listen(tv, 'target=tv');
  const [target] = await targets(phone);
  tvStream.close();
  await phoneStream.next('remote-targets');
  await until(async () => (await targets(phone)).length === 0);
  assert.equal((await command(phone, target.id, { type: 'pause' })).status, 404);
});

test('the tabs of one browser are listed once: the one that last took the focus', async () => {
  const phone = await signIn('dave', 'Pixel');
  const browser = await signIn('dave', 'Firefox');
  const first = await listen(browser, 'target=web');
  const second = await listen(browser, 'target=web');
  const firstId = first.of('remote-hello')[0].targetId;
  const secondId = second.of('remote-hello')[0].targetId;
  assert.deepEqual((await targets(phone)).map((t) => t.id), [secondId]);
  assert.equal((await call('POST', `/api/remote/targets/${firstId}/claim`, { token: browser })).status, 200);
  assert.deepEqual((await targets(phone)).map((t) => t.id), [firstId]);
  assert.equal((await call('POST', `/api/remote/targets/${firstId}/claim`, { token: phone })).status, 404, 'only its own browser');
});

test('a phone can only send so many commands a second', async () => {
  const phone = await signIn('dave', 'Pixel');
  const tv = await signIn('dave', 'Fire TV');
  await listen(tv, 'target=tv');
  const [target] = await targets(phone);
  const statuses = await Promise.all(Array.from({ length: 30 }, () => command(phone, target.id, { type: 'pause' })));
  assert.ok(statuses.filter((s) => s.status === 202).length <= 20);
  assert.ok(statuses.some((s) => s.status === 429));
});
