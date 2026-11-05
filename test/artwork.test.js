import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb, run, get } from '../server/db.js';
import { localArtworkFiles, setArtwork, listArtwork } from '../server/artwork.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-art-'));
const root = path.join(tmp, 'Movies');
const heatDir = path.join(root, 'Heat (1995)');
const touch = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
};

let heat;
let loose;
before(() => {
  openDb(':memory:');
  touch(path.join(heatDir, 'Heat (1995).mkv'));
  touch(path.join(heatDir, 'poster.jpg'));
  touch(path.join(heatDir, 'fanart.jpg'));
  touch(path.join(heatDir, 'clearlogo.png'));
  touch(path.join(heatDir, 'notes.txt'));
  // Movies sharing the library root: only images named after a movie belong to it.
  touch(path.join(root, 'Alien.mkv'));
  touch(path.join(root, 'Alien-poster.jpg'));
  touch(path.join(root, 'Brazil-poster.jpg'));
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', ?, ?)", JSON.stringify([root]), t);
  const insert = (fields) => {
    const all = { library_id: 1, type: 'movie', added_at: t, updated_at: t, ...fields };
    const cols = Object.keys(all);
    return Number(run(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => all[c])).lastInsertRowid);
  };
  heat = insert({ title: 'Heat', sort_title: 'heat', file_path: path.join(heatDir, 'Heat (1995).mkv'), poster: `file:${path.join(heatDir, 'poster.jpg')}` });
  loose = insert({ title: 'Alien', sort_title: 'alien', file_path: path.join(root, 'Alien.mkv') });
});

after(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const row = (id) => ({ ...get('SELECT * FROM items WHERE id = ?', id) });
const rejects = (promise, status) => assert.rejects(promise, (err) => err.status === status);

test('local artwork: everything in a movie’s own folder, only matching names in a shared folder', async () => {
  assert.deepEqual((await localArtworkFiles(row(heat))).map((f) => path.basename(f)), ['clearlogo.png', 'fanart.jpg', 'poster.jpg']);
  assert.deepEqual((await localArtworkFiles(row(loose))).map((f) => path.basename(f)), ['Alien-poster.jpg']);
});

test('listing shows local files for each kind (TMDB not set up)', async () => {
  const list = await listArtwork(row(heat));
  assert.deepEqual(list.kinds, ['poster', 'backdrop']);
  assert.equal(list.options.poster.length, 3);
  assert.equal(list.options.backdrop[0].source, 'local');
  assert.equal(list.tmdb.configured, false);
  assert.deepEqual(list.picked, { poster: false, backdrop: false });
});

test('picking a TMDB image or one of the item’s own files is remembered', async () => {
  await setArtwork(row(heat), 'backdrop', 'tmdb:/heat-alt.jpg');
  await setArtwork(row(heat), 'poster', `file:${path.join(heatDir, 'clearlogo.png')}`);
  const r = row(heat);
  assert.equal(r.backdrop, 'tmdb:/heat-alt.jpg');
  assert.equal(r.poster, `file:${path.join(heatDir, 'clearlogo.png')}`);
  assert.deepEqual(JSON.parse(r.art_json), { backdrop: 'tmdb:/heat-alt.jpg', poster: `file:${path.join(heatDir, 'clearlogo.png')}` });
});

test('anything else is refused', async () => {
  await rejects(setArtwork(row(heat), 'poster', 'tmdb:/../../etc/passwd'), 400);
  await rejects(setArtwork(row(heat), 'poster', `file:${path.join(root, 'Brazil-poster.jpg')}`), 400); // another movie's
  await rejects(setArtwork(row(heat), 'poster', `file:${path.join(heatDir, 'notes.txt')}`), 400); // not an image
  await rejects(setArtwork(row(heat), 'poster', 'https://example.com/x.jpg'), 400);
  await rejects(setArtwork(row(heat), 'thumb', 'tmdb:/x.jpg'), 400); // movies have no editable thumbnail
});

test('going back to automatic forgets the pick and uses the folder’s own artwork again', async () => {
  await setArtwork(row(heat), 'poster', null);
  const r = row(heat);
  assert.equal(r.poster, `file:${path.join(heatDir, 'poster.jpg')}`);
  assert.deepEqual(JSON.parse(r.art_json), { backdrop: 'tmdb:/heat-alt.jpg' });
  await setArtwork(row(heat), 'backdrop', null);
  assert.equal(row(heat).art_json, null);
  assert.equal(row(heat).backdrop, `file:${path.join(heatDir, 'fanart.jpg')}`);
});
