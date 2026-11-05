// How many devices someone may play on at once: set per user by an admin, enforced when playback starts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-limit-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { recentLogs } = await import('../server/lib/log.js');

let server;
let base;
const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };
const movie = path.join(dataDir, 'My Movie (2015).mp4');
const MEDIA = { container: 'mp4', duration: 477, bitrate: 2_000_000, video: { index: 0, codec: 'h264', profile: 'High', bitDepth: 8, width: 1280, height: 720 }, audio: [{ index: 1, codec: 'aac', isDefault: true }], subtitles: [] };

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, { method, headers: { ...H, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const signIn = async (username, password, device) => (await call('POST', '/api/auth/device', { body: { username, password, device } })).data.token;
const play = (token) => call('POST', '/api/playback/1', { token, body: { direct: true } }); // Kodi-style: no conversion
const stop = (token, playId) => call('POST', '/api/progress', { token, body: { itemId: 1, playId, position: 60, duration: 477, state: 'stopped', mode: 'direct', quality: 'original' } });

before(async () => {
  openDb(':memory:');
  fs.writeFileSync(movie, 'not really a movie');
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?)", t);
  run("INSERT INTO items (id, library_id, type, title, sort_title, year, file_path, media_json, duration, added_at, updated_at) VALUES (1, 1, 'movie', 'My Movie', 'my movie', 2015, ?, ?, 477, ?, ?)",
    movie, JSON.stringify(MEDIA), t, t);
  const pw = await hashPassword('a long password');
  run(`INSERT INTO users (id, username, password_hash, is_admin, stream_limit, created_at) VALUES
       (1, 'dave', ?, 1, NULL, ?), (2, 'kid', ?, 0, 1, ?), (3, 'sam', ?, 0, 2, ?)`, pw, t, pw, t, pw, t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('one device at a time: a second device is refused with what is playing where, until the first stops', async () => {
  const tv = await signIn('kid', 'a long password', 'Living room TV');
  const phone = await signIn('kid', 'a long password', 'Kid’s phone');
  const first = await play(tv);
  assert.equal(first.status, 200);
  assert.equal((await play(tv)).status, 200, 'the same device can start again (another quality, the next episode)');

  const refused = await play(phone);
  assert.equal(refused.status, 429);
  assert.equal(refused.data.code, 'stream_limit');
  assert.equal(refused.data.error, 'Your account can play on one device at a time, and “My Movie” is playing on Living room TV. '
    + 'Stop it there first (a player that was just closed frees up within a few minutes).');
  assert.ok(recentLogs(20).some((l) => l.msg.startsWith('User "kid" couldn\'t start "My Movie" on Kid’s phone')
    && l.msg.endsWith('already playing on 1 device, the most the account allows')), 'logged for the admin');

  const latest = (await play(tv)).data.playId;
  assert.equal((await stop(tv, latest)).status, 200);
  assert.equal((await play(phone)).status, 200, 'free again once the TV stopped');
});

test('two at a time: the third device is told about both; someone without a limit is never refused', async () => {
  const [tv, phone, tablet] = await Promise.all(['TV', 'Phone', 'Tablet'].map((d) => signIn('sam', 'a long password', d)));
  assert.equal((await play(tv)).status, 200);
  assert.equal((await play(phone)).status, 200);
  const refused = await play(tablet);
  assert.equal(refused.status, 429);
  assert.match(refused.data.error, /^Your account can play on 2 devices at a time, and they’re all in use: “My Movie” on (Phone|TV), “My Movie” on (Phone|TV)\. Stop one of them first/);

  const devices = await Promise.all(['A', 'B', 'C', 'D'].map((d) => signIn('dave', 'a long password', d)));
  for (const token of devices) assert.equal((await play(token)).status, 200);
});

test('only admins set limits: none, or 1 to 20', async () => {
  const admin = await signIn('dave', 'a long password', 'browser');
  const kid = await signIn('kid', 'a long password', 'browser');
  assert.equal((await call('PATCH', '/api/users/2', { token: kid, body: { streamLimit: null } })).status, 403);
  assert.equal((await call('PATCH', '/api/users/2', { token: admin, body: { streamLimit: 3 } })).data.user.streamLimit, 3);
  assert.equal((await call('PATCH', '/api/users/2', { token: admin, body: { streamLimit: '' } })).data.user.streamLimit, null);
  for (const bad of [0.5, 21, -1, 'two']) {
    const r = await call('PATCH', '/api/users/2', { token: admin, body: { streamLimit: bad } });
    assert.equal(r.status, 400, String(bad));
    assert.match(r.data.error, /from 1 to 20/);
  }
  const created = await call('POST', '/api/users', { token: admin, body: { username: 'guest', password: 'a long password', streamLimit: 1 } });
  assert.equal(created.data.user.streamLimit, 1);
  assert.equal((await call('GET', '/api/users', { token: admin })).data.users.find((u) => u.username === 'guest').streamLimit, 1);
});

test('2 at a time unless an admin chooses otherwise: existing accounts, new ones, and "no limit" on purpose', async () => {
  // An account from before limits existed (inserted without the column), as the database upgrade finds it.
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (9, 'older', 'x', 0, ?)", Date.now());
  const admin = await signIn('dave', 'a long password', 'browser');
  const users = (await call('GET', '/api/users', { token: admin })).data.users;
  assert.equal(users.find((u) => u.username === 'older').streamLimit, 2);
  const plain = await call('POST', '/api/users', { token: admin, body: { username: 'newcomer', password: 'a long password' } });
  assert.equal(plain.data.user.streamLimit, 2, 'a new user starts at 2');
  const free = await call('POST', '/api/users', { token: admin, body: { username: 'unlimited', password: 'a long password', streamLimit: null } });
  assert.equal(free.data.user.streamLimit, null, 'no limit, when the admin says so');
});
