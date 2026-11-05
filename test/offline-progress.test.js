// Watch progress the Android app made offline (downloads) reaches the server later, saying how old it is. It must
// not undo what happened since, e.g. finishing the episode on the TV in the meantime.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, run, get } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { createApp } from '../server/app.js';

let server;
let base;
let token;
const DAY = 24 * 60 * 60 * 1000;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'reelhouse', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const state = (itemId) => ({ ...get('SELECT position, watched, view_count FROM user_state WHERE user_id = 1 AND item_id = ?', itemId) });

before(async () => {
  openDb(':memory:');
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'TV', 'show', '[]', ?)", t);
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?)", await hashPassword('correct horse'), t);
  for (const id of [1, 2, 3]) {
    run(
      "INSERT INTO items (id, library_id, type, title, sort_title, file_path, container, duration, added_at, updated_at) VALUES (?, 1, 'episode', ?, ?, ?, 'mkv', 3000, ?, ?)",
      id, `Episode ${id}`, `episode ${id}`, `C:/tv/${id}.mkv`, t, t,
    );
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('POST', '/api/auth/device', { username: 'dave', password: 'correct horse', device: 'Phone' })).data.token;
});

after(() => {
  server.close();
  closeDb();
});

test('an offline report older than a later change is ignored', async () => {
  // Watched to the end on the TV today...
  await call('POST', '/api/progress', { itemId: 1, position: 3000, duration: 3000, state: 'ended' });
  assert.deepEqual(state(1), { position: 0, watched: 1, view_count: 1 });
  // ...after stopping part-way on the phone, offline, two days ago.
  const res = await call('POST', '/api/progress', { itemId: 1, position: 1200, duration: 3000, state: 'stopped', age: 2 * DAY });
  assert.equal(res.status, 200);
  assert.deepEqual(state(1), { position: 0, watched: 1, view_count: 1 });
  assert.deepEqual(res.data, { watched: true, position: 0 });
});

test('an offline report newer than anything the server has still counts', async () => {
  await call('POST', '/api/progress', { itemId: 2, position: 600, duration: 3000, state: 'paused' });
  await new Promise((r) => setTimeout(r, 20));
  // Made after that pause (10 ms ago), sent now.
  await call('POST', '/api/progress', { itemId: 2, position: 1500, duration: 3000, state: 'stopped', age: 10 });
  assert.equal(state(2).position, 1500);
  // Never watched anywhere else: an old report is all there is.
  await call('POST', '/api/progress', { itemId: 3, position: 3000, duration: 3000, state: 'ended', age: 5 * DAY });
  assert.deepEqual(state(3), { position: 0, watched: 1, view_count: 1 });
});

test('reports without an age (the web player, Kodi, playing online) are as before', async () => {
  await call('POST', '/api/progress', { itemId: 1, position: 900, duration: 3000, state: 'paused' });
  assert.equal(state(1).position, 900);
  // Nonsense ages are ignored rather than trusted.
  await call('POST', '/api/progress', { itemId: 1, position: 950, duration: 3000, state: 'paused', age: -5 });
  assert.equal(state(1).position, 950);
});
