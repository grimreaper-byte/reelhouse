// A library's icon, picked in Settings → Libraries: what the list says, what's kept, and what isn't taken.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-library-icons-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run, get } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { updateSettings } = await import('../server/settings.js');
const { createApp } = await import('../server/app.js');
const { LIBRARY_ICONS, libraryIcon, pickedIcon } = await import('../server/libraries.js');

let server;
let base;
const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };
const tokens = {};
const folder = (name) => {
  const p = path.join(dataDir, 'media', name);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

async function call(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { ...H, authorization: `Bearer ${tokens[who]}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const icons = async () => Object.fromEntries((await call('owner', 'GET', '/api/libraries')).data.libraries.map((l) => [l.name, l.icon]));

before(async () => {
  openDb(':memory:');
  updateSettings({ watchFolders: false });
  const t = Date.now();
  // Two from before icons (none kept), and one with an icon this server doesn't know (a newer one picked it).
  run(`INSERT INTO libraries (id, name, type, icon, paths, created_at) VALUES
       (1, 'Movies', 'movie', NULL, '[]', ?), (2, 'TV Shows', 'show', NULL, '[]', ?), (3, 'Odd', 'show', 'rocket', '[]', ?)`, t, t, t);
  const pw = await hashPassword('a long password');
  run(`INSERT INTO users (id, username, password_hash, is_admin, library_access, created_at) VALUES
       (1, 'owner', ?, 1, NULL, ?), (2, 'sam', ?, 0, NULL, ?)`, pw, t, pw, t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['owner', 'sam']) {
    const res = await fetch(`${base}/api/auth/device`, { method: 'POST', headers: H, body: JSON.stringify({ username: who, password: 'a long password', device: 'Test' }) });
    tokens[who] = (await res.json()).token;
  }
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a library without its own icon shows its type’s, to everyone', async () => {
  assert.deepEqual(await icons(), { Movies: 'film', 'TV Shows': 'tv', Odd: 'tv' });
  const sams = (await call('sam', 'GET', '/api/libraries')).data.libraries.map((l) => l.icon);
  assert.deepEqual(sams, ['film', 'tv', 'tv']);
});

test('the icons offered are the web’s, each kept only when it isn’t the type’s own', () => {
  assert.equal(LIBRARY_ICONS.length, 10);
  assert.equal(pickedIcon('trophy', 'movie'), 'trophy');
  assert.equal(pickedIcon('film', 'movie'), null);
  assert.equal(pickedIcon('film', 'show'), 'film'); // a film strip on a show library is a choice
  assert.equal(pickedIcon('', 'show'), null);
  assert.equal(pickedIcon(null, 'show'), null);
  assert.throws(() => pickedIcon('rocket', 'show'), { status: 400 });
  assert.equal(libraryIcon({ type: 'show', icon: 'tvRecord' }), 'tvRecord');
});

test('the web app offers the same icons, in the same order, and draws each of them', () => {
  const dom = fs.readFileSync(new URL('../web/js/dom.js', import.meta.url), 'utf8');
  const offered = [...dom.match(/export const LIBRARY_ICONS = \[([\s\S]*?)\n\];/)[1].matchAll(/\['(\w+)', '/g)].map((m) => m[1]);
  assert.deepEqual(offered, LIBRARY_ICONS);
  for (const name of LIBRARY_ICONS) assert.match(dom, new RegExp(`\\n  ${name}: '`), name);
});

test('an admin picks one when adding a library, and changes it later', async () => {
  const sport = folder('Sport');
  const added = await call('owner', 'POST', '/api/libraries', { name: 'Sport', type: 'show', icon: 'trophy', paths: [sport] });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.library.icon, 'trophy');
  const id = added.data.library.id;

  const recorded = await call('owner', 'PATCH', `/api/libraries/${id}`, { icon: 'tvRecord' });
  assert.equal(recorded.data.library.icon, 'tvRecord');
  assert.equal(get('SELECT icon FROM libraries WHERE id = ?', id).icon, 'tvRecord');

  // Back to the type's own: nothing kept, so it's the default again.
  await call('owner', 'PATCH', `/api/libraries/${id}`, { icon: 'tv' });
  assert.equal(get('SELECT icon FROM libraries WHERE id = ?', id).icon, null);
  assert.equal((await icons()).Sport, 'tv');

  // Left out: no change. Someone who isn't an admin can't change it.
  await call('owner', 'PATCH', `/api/libraries/${id}`, { icon: 'heart' });
  await call('owner', 'PATCH', `/api/libraries/${id}`, { name: 'Sports' });
  assert.equal((await icons()).Sports, 'heart');
  assert.equal((await call('sam', 'PATCH', `/api/libraries/${id}`, { icon: 'film' })).status, 403);
});

test('an icon that isn’t offered is turned down, and nothing else in the request is saved', async () => {
  const bad = await call('owner', 'POST', '/api/libraries', { name: 'Space', type: 'movie', icon: 'rocket', paths: [folder('Space')] });
  assert.equal(bad.status, 400);
  assert.equal(get("SELECT COUNT(*) AS n FROM libraries WHERE name = 'Space'").n, 0);
  const renamed = await call('owner', 'PATCH', '/api/libraries/1', { name: 'Films', icon: 'rocket' });
  assert.equal(renamed.status, 400);
  assert.equal(get('SELECT name FROM libraries WHERE id = 1').name, 'Movies');
});

test('folders joining a same-named library keep its icon, unless another was picked', async () => {
  run("UPDATE libraries SET icon = 'clapperboard', paths = ? WHERE id = 1", JSON.stringify([folder('Movies A')]));
  // The dialog starts on the type's own icon: adding "Movies" from a second drive leaves the clapperboard.
  const joined = await call('owner', 'POST', '/api/libraries', { name: 'movies', type: 'movie', icon: 'film', paths: [folder('Movies B')] });
  assert.equal(joined.data.joined, true);
  assert.equal(joined.data.library.icon, 'clapperboard');
  const picked = await call('owner', 'POST', '/api/libraries', { name: 'Movies', type: 'movie', icon: 'movieCamera', paths: [folder('Movies C')] });
  assert.equal(picked.data.library.icon, 'movieCamera');
});
