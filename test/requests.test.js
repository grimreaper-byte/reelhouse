// Requests: asking for films that aren't on the server, who may remove which, and requests going once the film is in.
// TMDB is answered from canned responses (no network); the server is real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-requests-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { updateSettings } = await import('../server/settings.js');
const { createApp } = await import('../server/app.js');
const { fulfilRequests } = await import('../server/requests.js');

const TMDB = {
  '/3/search/movie': { results: [
    { id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: '/heat.jpg', popularity: 30, overview: 'A thief…' },
    { id: 9361, title: 'The Last of the Mohicans', release_date: '1992-08-26', poster_path: '/mohicans.jpg', popularity: 20 },
    { id: 1878, title: 'Fear and Loathing', release_date: '1998-05-22', poster_path: 'not a path', popularity: 10 },
  ] },
  '/3/movie/949': { id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: '/heat.jpg', overview: 'A thief…' },
  '/3/movie/9361': { id: 9361, title: 'The Last of the Mohicans', release_date: '1992-08-26', poster_path: '/mohicans.jpg' },
  '/3/movie/1878': { id: 1878, title: 'Fear and Loathing in Las Vegas', release_date: '1998-05-22' },
  '/3/movie/603': { id: 603, title: 'The Matrix', release_date: '1999-03-30', poster_path: '/matrix.jpg' },
  '/3/movie/680': { id: 680, title: 'Pulp Fiction', release_date: '1994-09-10', poster_path: '/pulp.jpg' },
  '/3/movie/155': { id: 155, title: 'The Dark Knight', release_date: '2008-07-16', poster_path: '/knight.jpg' },
  '/3/movie/13': { id: 13, title: 'Forrest Gump', release_date: '1994-06-23', poster_path: '/gump.jpg' },
};

let server;
let base;
let realFetch;
const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };
const tokens = {};

async function call(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { ...H, authorization: `Bearer ${tokens[who]}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  openDb(':memory:');
  updateSettings({ tmdbApiKey: '0123456789abcdef0123456789abcdef' });
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.hostname !== 'api.themoviedb.org') return realFetch(url, opts);
    const body = TMDB[u.pathname];
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'Grown-ups', 'movie', '[]', ?)", t, t);
  // Heat is in Movies; The Matrix only in a library the kid can't open.
  run("INSERT INTO items (id, library_id, type, title, sort_title, year, file_path, tmdb_id, added_at, updated_at) VALUES (1, 1, 'movie', 'Heat', 'heat', 1995, 'C:/m/heat.mkv', 949, ?, ?), (2, 2, 'movie', 'The Matrix', 'matrix', 1999, 'C:/g/matrix.mkv', 603, ?, ?)", t, t, t, t);
  const pw = await hashPassword('a long password');
  run(`INSERT INTO users (id, username, password_hash, is_admin, library_access, created_at) VALUES
       (1, 'owner', ?, 1, NULL, ?), (2, 'sam', ?, 0, NULL, ?), (3, 'kid', ?, 0, '[1]', ?)`, pw, t, pw, t, pw, t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['owner', 'sam', 'kid']) {
    const res = await realFetch(`${base}/api/auth/device`, { method: 'POST', headers: H, body: JSON.stringify({ username: who, password: 'a long password', device: 'Test' }) });
    tokens[who] = (await res.json()).token;
  }
});

after(() => {
  globalThis.fetch = realFetch;
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('searching TMDB shows what is already on the server, for the libraries you can open', async () => {
  const { status, data } = await call('sam', 'GET', '/api/requests/search?q=heat');
  assert.equal(status, 200);
  assert.deepEqual(data.results.map((r) => [r.tmdbId, r.title, r.year, r.onServer, r.request]), [
    [949, 'Heat', 1995, 1, null],
    [9361, 'The Last of the Mohicans', 1992, null, null],
    [1878, 'Fear and Loathing', 1998, null, null],
  ]);
  assert.equal(data.results[0].poster, '/api/tmdb-image/poster/heat.jpg');
  assert.equal(data.results[2].poster, null, 'only real image paths');
  assert.deepEqual((await call('sam', 'GET', '/api/requests/search?q=')).data, { results: [] });
});

test('asking for a film keeps TMDB’s details and who asked; one request per film', async () => {
  const asked = await call('sam', 'POST', '/api/requests', { tmdbId: 9361, title: 'Not what TMDB says' });
  assert.equal(asked.status, 201);
  const r = asked.data.request;
  assert.deepEqual([r.tmdbId, r.title, r.year, r.poster, r.user.username, r.canRemove], [9361, 'The Last of the Mohicans', 1992, '/api/tmdb-image/poster/mohicans.jpg', 'sam', true]);
  assert.ok(Math.abs(r.requestedAt - Date.now()) < 5000);

  const again = await call('kid', 'POST', '/api/requests', { tmdbId: 9361 });
  assert.deepEqual([again.status, again.data.error], [409, 'sam has already asked for it']);
  assert.equal((await call('sam', 'POST', '/api/requests', { tmdbId: 9361 })).data.error, 'You’ve already asked for it');
  const there = await call('sam', 'POST', '/api/requests', { tmdbId: 949 });
  assert.deepEqual([there.status, there.data.itemId], [409, 1], 'Heat is on the server');
  assert.equal((await call('sam', 'POST', '/api/requests', { tmdbId: 424242 })).status, 404, 'not a film TMDB knows');
  assert.equal((await call('sam', 'POST', '/api/requests', { tmdbId: 'heat' })).status, 400);

  // The Matrix is in a library the kid can't open: for them it isn't on the server, so they can ask for it.
  assert.equal((await call('kid', 'POST', '/api/requests', { tmdbId: 603 })).status, 201);
  assert.equal((await call('sam', 'POST', '/api/requests', { tmdbId: 1878 })).status, 201);

  const search = await call('kid', 'GET', '/api/requests/search?q=heat');
  assert.deepEqual(search.data.results[1].request, { id: r.id, username: 'sam', mine: false });
});

test('everyone sees every request, newest first; you can remove your own, an admin any', async () => {
  const list = async (who) => (await call(who, 'GET', '/api/requests')).data;
  const sam = await list('sam');
  assert.equal(sam.available, true);
  assert.deepEqual(sam.requests.map((r) => [r.title, r.user.username, r.canRemove]), [
    ['Fear and Loathing in Las Vegas', 'sam', true],
    ['The Matrix', 'kid', false],
    ['The Last of the Mohicans', 'sam', true],
  ]);
  assert.deepEqual((await list('owner')).requests.map((r) => r.canRemove), [true, true, true]);
  assert.equal((await call('sam', 'GET', '/api/me')).data.requests.count, 3);

  const [fear, matrix] = sam.requests;
  assert.equal((await call('sam', 'DELETE', `/api/requests/${matrix.id}`)).status, 403, 'not sam’s');
  assert.equal((await call('sam', 'DELETE', `/api/requests/${fear.id}`)).status, 200);
  assert.equal((await call('sam', 'DELETE', `/api/requests/${fear.id}`)).status, 404);
  assert.equal((await call('owner', 'DELETE', `/api/requests/${matrix.id}`)).status, 200, 'an admin removes anyone’s');
  assert.deepEqual((await list('kid')).requests.map((r) => r.title), ['The Last of the Mohicans']);

  assert.equal((await call('sam', 'DELETE', '/api/requests')).status, 403, 'only admins remove them all');
  assert.equal((await call('kid', 'POST', '/api/requests', { tmdbId: 603 })).status, 201);
  assert.deepEqual((await call('owner', 'DELETE', '/api/requests')).data, { removed: 2 });
  assert.deepEqual((await list('sam')).requests, []);
});

test('a request goes by itself once its film is in a library the person who asked can open', async () => {
  assert.equal((await call('sam', 'POST', '/api/requests', { tmdbId: 9361 })).status, 201);
  assert.equal((await call('kid', 'POST', '/api/requests', { tmdbId: 603 })).status, 201);
  assert.equal(fulfilRequests(), 0, 'nothing has arrived');
  // Mohicans arrives in Movies; The Matrix is still only where the kid can't watch it.
  const t = Date.now();
  run("INSERT INTO items (id, library_id, type, title, sort_title, year, file_path, tmdb_id, added_at, updated_at) VALUES (3, 1, 'movie', 'Mohicans', 'mohicans', 1992, 'C:/m/mohicans.mkv', 9361, ?, ?)", t, t);
  assert.deepEqual((await call('owner', 'GET', '/api/requests')).data.requests.map((r) => r.title), ['The Matrix']);
  // Once the kid may open that library, it goes too.
  run("UPDATE users SET library_access = '[1,2]' WHERE id = 3");
  assert.equal(fulfilRequests(), 1);
  assert.equal((await call('kid', 'GET', '/api/me')).data.requests.count, 0);
});

test('without a TMDB key (a fresh install) Requests stays off, and comes on once a key is added', async () => {
  updateSettings({ tmdbApiKey: '' });
  try {
    // Hidden from everyone, whatever the switch says, and nothing answers: it says a key is needed.
    assert.deepEqual((await call('sam', 'GET', '/api/me')).data.requests, { enabled: false, count: 0, available: false });
    for (const [method, p, body] of [['GET', '/api/requests'], ['GET', '/api/requests/search?q=heat'], ['POST', '/api/requests', { tmdbId: 9361 }]]) {
      const r = await call('sam', method, p, body);
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.equal(r.data.needsKey, true);
      assert.match(r.data.error, /TMDB API key/);
    }
  } finally {
    updateSettings({ tmdbApiKey: '0123456789abcdef0123456789abcdef' });
  }
  // A key: on again by itself (the switch was never turned off).
  const me = (await call('sam', 'GET', '/api/me')).data.requests;
  assert.equal(me.enabled, true);
  assert.equal(me.available, true);
  assert.equal((await call('sam', 'GET', '/api/requests')).status, 200);
});

test('an admin can turn Requests off: hidden from everyone, nothing answers, and the list is kept for later', async () => {
  assert.ok([201, 409].includes((await call('sam', 'POST', '/api/requests', { tmdbId: 1878 })).status));
  const before = (await call('owner', 'GET', '/api/requests')).data.requests.length;
  assert.ok(before > 0);
  assert.deepEqual((await call('sam', 'GET', '/api/me')).data.requests, { enabled: true, count: before, available: true });
  assert.equal((await call('sam', 'PUT', '/api/settings', { requestsEnabled: false })).status, 403); // admins only
  const off = await call('owner', 'PUT', '/api/settings', { requestsEnabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.data.settings.requestsEnabled, false);
  try {
    // Apps that don't know the switch see no row to show: nothing to ask for, no count.
    assert.deepEqual((await call('sam', 'GET', '/api/me')).data.requests, { enabled: false, count: 0, available: false });
    for (const [who, method, p, body] of [
      ['sam', 'GET', '/api/requests'], ['sam', 'GET', '/api/requests/search?q=heat'], ['sam', 'POST', '/api/requests', { tmdbId: 9361 }],
      ['sam', 'DELETE', '/api/requests/1'], ['owner', 'GET', '/api/requests'], ['owner', 'DELETE', '/api/requests'],
    ]) {
      const r = await call(who, method, p, body);
      assert.equal(r.status, 403, `${who} ${method} ${p}`);
      assert.equal(r.data.off, true);
    }
  } finally {
    await call('owner', 'PUT', '/api/settings', { requestsEnabled: true });
  }
  assert.equal((await call('sam', 'GET', '/api/requests')).data.requests.length, before);
  assert.deepEqual((await call('sam', 'GET', '/api/me')).data.requests, { enabled: true, count: before, available: true });
});

test('an admin can limit how many requests each person has waiting; admins are not limited', async () => {
  await call('owner', 'DELETE', '/api/requests');
  assert.equal((await call('sam', 'PUT', '/api/settings', { requestsLimit: 2 })).status, 403); // admins only
  assert.equal((await call('owner', 'PUT', '/api/settings', { requestsLimit: -1 })).status, 400);
  assert.equal((await call('owner', 'PUT', '/api/settings', { requestsLimit: 2 })).status, 200);
  try {
    assert.deepEqual((await call('sam', 'GET', '/api/requests')).data.limit, { max: 2, open: 0 });
    assert.equal((await call('sam', 'POST', '/api/requests', { tmdbId: 680 })).status, 201);
    assert.equal((await call('sam', 'POST', '/api/requests', { tmdbId: 155 })).status, 201);
    const third = await call('sam', 'POST', '/api/requests', { tmdbId: 1878 });
    assert.equal(third.status, 403);
    assert.equal(third.data.limit, true);
    assert.match(third.data.error, /already have 2 requests waiting/);
    assert.deepEqual((await call('sam', 'GET', '/api/requests')).data.limit, { max: 2, open: 2 });
    // Admins aren't limited.
    assert.equal((await call('owner', 'GET', '/api/requests')).data.limit, null);
    assert.equal((await call('owner', 'POST', '/api/requests', { tmdbId: 1878 })).status, 201);
    // One of theirs removed: a place again.
    const mine = (await call('sam', 'GET', '/api/requests')).data.requests.find((r) => r.tmdbId === 680);
    assert.equal((await call('sam', 'DELETE', `/api/requests/${mine.id}`)).status, 200);
    assert.equal((await call('sam', 'POST', '/api/requests', { tmdbId: 13 })).status, 201);
  } finally {
    await call('owner', 'PUT', '/api/settings', { requestsLimit: 0 });
  }
  assert.equal((await call('sam', 'GET', '/api/requests')).data.limit, null); // 0: no limit
});
