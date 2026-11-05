// Device sign-in and the sync API (used by the Kodi add-on), exercised over HTTP against the real app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, run } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { createApp } from '../server/app.js';

let server;
let base;
const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...H, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

before(async () => {
  openDb(':memory:');
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'TV', 'show', '[]', ?)", t, t);
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?)", await hashPassword('correct horse'), t);
  run("INSERT INTO users (id, username, password_hash, is_admin, library_access, created_at) VALUES (2, 'kid', ?, 0, '[1]', ?)", await hashPassword('kid password'), t);
  const item = (fields) => {
    const all = { added_at: t, updated_at: 100, sort_title: fields.title.toLowerCase(), ...fields };
    const cols = Object.keys(all);
    run(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => all[c]));
  };
  item({ id: 1, library_id: 1, type: 'movie', title: 'Heat', year: 1995, file_path: 'C:/m/Heat (1995).mkv', container: 'mkv', duration: 10200,
    genres: '["Crime"]', cast_json: '[{"name":"Al Pacino","role":"Vincent Hanna","profile":"tmdb:/al.jpg"}]', tmdb_id: 949,
    media_json: JSON.stringify({ video: { codec: 'hevc', width: 3840, height: 2160, hdr: 'HDR10' }, audio: [{ codec: 'truehd', channels: 8, language: 'eng' }], subtitles: [{ language: 'eng' }] }),
    subs_json: '[{"language":"fre","format":"srt"}]' });
  item({ id: 10, library_id: 2, type: 'show', title: 'Breaking Bad' });
  item({ id: 11, library_id: 2, type: 'season', title: 'Season 1', parent_id: 10, show_id: 10, season_number: 1 });
  item({ id: 12, library_id: 2, type: 'episode', title: 'Pilot', parent_id: 11, show_id: 10, season_number: 1, episode_number: 1, file_path: 'C:/tv/1.mkv' });
  run('INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (1, 12, 0, 1, 2, 500)');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
});

let token;

test('a device signs in with a password and gets a token', async () => {
  const bad = await call('POST', '/api/auth/device', { body: { username: 'dave', password: 'nope', device: 'Kodi (Lounge)' } });
  assert.equal(bad.status, 401);
  const noName = await call('POST', '/api/auth/device', { body: { username: 'dave', password: 'correct horse' } });
  assert.equal(noName.status, 400);
  const ok = await call('POST', '/api/auth/device', { body: { username: 'dave', password: 'correct horse', device: 'Kodi (Lounge)' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token.length > 20);
  assert.equal(ok.data.user.username, 'dave');
  token = ok.data.token;
});

test('the token works as a Bearer header, an X-Reelhouse-Token header, or a query parameter on reads', async () => {
  assert.equal((await call('GET', '/api/me', { token })).status, 200);
  assert.equal((await call('GET', '/api/me', { headers: { 'x-reelhouse-token': token } })).status, 200);
  assert.equal((await call('GET', `/api/me?X-Reelhouse-Token=${token}`)).status, 200);
  // Not for writes: a link can't make a signed-in device change anything.
  const write = await call('POST', `/api/items/1/watched?X-Reelhouse-Token=${token}`, { body: { watched: true } });
  assert.equal(write.status, 401);
});

test('sync: libraries, item list with checksums and states, and details', async () => {
  const libs = await call('GET', '/api/sync/libraries', { token });
  assert.deepEqual(libs.data.libraries.map((l) => [l.id, l.type]), [[1, 'movie'], [2, 'show']]);

  const tv = await call('GET', '/api/sync/libraries/2/items', { token });
  assert.deepEqual(tv.data.items.map((i) => [i.id, i.type]), [[10, 'show'], [11, 'season'], [12, 'episode']], 'parents first');
  assert.equal(tv.data.items[0].checksum, '100');
  assert.equal(tv.data.items[0].state, undefined, 'shows and seasons carry no state');
  assert.deepEqual(tv.data.items[2].state, { watched: true, viewCount: 2, position: 0, updatedAt: 500 });

  const details = await call('POST', '/api/sync/items', { token, body: { ids: [12, 1, 999] } });
  const [movie, ep] = details.data.items;
  assert.equal(movie.title, 'Heat');
  assert.equal(movie.file.name, 'Heat (1995).mkv');
  assert.deepEqual(movie.streams.video, { codec: 'hevc', width: 3840, height: 2160, aspect: 1.777778, hdr: 'HDR10' });
  assert.deepEqual(movie.streams.subtitles, [{ language: 'eng' }, { language: 'fre' }]);
  assert.equal(movie.cast[0].profile, '/api/tmdb-image/profile/al.jpg');
  assert.equal(movie.tmdbId, 949);
  assert.match(movie.images.poster, /^\/api\/images\/1\/poster\?v=100$/);
  assert.equal(ep.seasonNumber, 1);
  assert.equal(ep.state.watched, true);

  const states = await call('POST', '/api/sync/states', { token, body: { ids: [1, 12] } });
  assert.deepEqual(states.data.states.map((s) => [s.id, s.state.watched]), [[1, false], [12, true]]);
});

test('sync respects library access', async () => {
  const signIn = await call('POST', '/api/auth/device', { body: { username: 'kid', password: 'kid password', device: 'Kodi (Kids)' } });
  assert.equal(signIn.status, 200, JSON.stringify(signIn.data));
  const kid = signIn.data.token;
  const libs = await call('GET', '/api/sync/libraries', { token: kid });
  assert.equal(libs.status, 200, JSON.stringify(libs.data));
  assert.deepEqual(libs.data.libraries.map((l) => l.id), [1]);
  assert.equal((await call('GET', '/api/sync/libraries/2/items', { token: kid })).status, 404);
  const details = await call('POST', '/api/sync/items', { token: kid, body: { ids: [1, 12] } });
  assert.deepEqual(details.data.items.map((i) => i.id), [1]);
});

test('libraries keep the order an admin gives them: the list, Home and the sync API', async () => {
  const names = async (path, t = token) => (await call('GET', path, { token: t })).data.libraries.map((l) => l.name);
  assert.deepEqual(await names('/api/libraries'), ['Movies', 'TV']); // by name to start with
  const kid = (await call('POST', '/api/auth/device', { body: { username: 'kid', password: 'kid password', device: 'Kodi (Kids)' } })).data.token;
  assert.equal((await call('PUT', '/api/libraries/order', { token: kid, body: { ids: [2, 1] } })).status, 403);
  assert.equal((await call('PUT', '/api/libraries/order', { token, body: {} })).status, 400);
  const r = await call('PUT', '/api/libraries/order', { token, body: { ids: [2, 1] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.libraries.map((l) => l.name), ['TV', 'Movies']);
  assert.deepEqual(await names('/api/libraries'), ['TV', 'Movies']);
  assert.deepEqual(await names('/api/hubs/home'), ['TV', 'Movies']);
  assert.deepEqual(await names('/api/sync/libraries'), ['TV', 'Movies']);
  await call('PUT', '/api/libraries/order', { token, body: { ids: [1, 2] } });
  assert.deepEqual(await names('/api/libraries'), ['Movies', 'TV']);
});

test('devices are listed and can be signed out', async () => {
  const list = await call('GET', '/api/me/devices', { token });
  assert.equal(list.data.devices.length, 1);
  const [device] = list.data.devices;
  assert.equal(device.name, 'Kodi (Lounge)');
  assert.match(device.id, /^[0-9a-f]{16}$/);
  assert.equal((await call('DELETE', '/api/me/devices/0000000000000000', { token })).status, 404);
  assert.equal((await call('DELETE', `/api/me/devices/${device.id}`, { token })).status, 200);
  assert.equal((await call('GET', '/api/sync/libraries', { token })).status, 401, 'the token stops working');
});
