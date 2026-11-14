// Artwork added to a folder after its film or show was scanned: a rescan picks it up (a hand-picked choice stays,
// and TMDB's stays unless local artwork is preferred). Scans real (tiny, generated) video files; skipped when ffmpeg
// isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, closeDb, run, get } from '../server/db.js';
import { queueScan, scanStatus } from '../server/scanner/index.js';
import { updateSettings } from '../server/settings.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const skip = !hasFfmpeg && 'ffmpeg not installed';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-art-'));
const films = path.join(tmp, 'Movies');
const tv = path.join(tmp, 'TV');
const show = path.join(tv, 'Some Show (2020)');
const episode = path.join(show, 'Season 01', 'Some Show - S01E01 - Pilot.mp4');

function makeVideo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}
const picture = (file) => fs.writeFileSync(file, 'not really a picture: the scanner goes by the name');

async function scan(libraryId) {
  queueScan(libraryId);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const s = scanStatus();
    if (!s.running && !s.queue.length) return;
  }
  throw new Error('scan did not finish');
}

const film = (title) => ({ ...get('SELECT poster, backdrop, art_json, updated_at FROM items WHERE type = ? AND title = ?', 'movie', title) });
const item = (type) => ({ ...get('SELECT poster, backdrop, thumb FROM items WHERE type = ?', type) });
const ref = (...parts) => `file:${path.join(...parts)}`;

before(async () => {
  if (!hasFfmpeg) return;
  openDb(':memory:');
  for (const name of ['Late Art (2020)', 'Picked (2021)', 'Online (2019)']) makeVideo(path.join(films, name, `${name}.mp4`));
  makeVideo(episode);
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', ?, ?)", JSON.stringify([films]), Date.now());
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (2, 'TV', 'show', ?, ?)", JSON.stringify([tv]), Date.now());
  await scan(1);
  await scan(2);
});

after(() => {
  if (hasFfmpeg) closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a film scanned before its poster and background were added gets them on the next scan', { skip }, async () => {
  const dir = path.join(films, 'Late Art (2020)');
  assert.equal(film('Late Art').poster, null);
  picture(path.join(dir, 'poster.jpg'));
  picture(path.join(dir, 'fanart.jpg'));
  await scan(1);
  assert.equal(film('Late Art').poster, ref(dir, 'poster.jpg'));
  assert.equal(film('Late Art').backdrop, ref(dir, 'fanart.jpg'));

  // Nothing new: nothing written again.
  const before = film('Late Art').updated_at;
  await scan(1);
  assert.equal(film('Late Art').updated_at, before);

  // A renamed picture is followed.
  fs.renameSync(path.join(dir, 'poster.jpg'), path.join(dir, 'folder.jpg'));
  await scan(1);
  assert.equal(film('Late Art').poster, ref(dir, 'folder.jpg'));
});

test('a show, its season and its episode pick up artwork added after them', { skip }, async () => {
  assert.deepEqual(item('show'), { poster: null, backdrop: null, thumb: null });
  picture(path.join(show, 'poster.jpg'));
  picture(path.join(show, 'fanart.jpg'));
  picture(path.join(show, 'season01-poster.jpg'));
  picture(episode.replace(/\.mp4$/, '-thumb.jpg'));
  await scan(2);
  assert.equal(item('show').poster, ref(show, 'poster.jpg'));
  assert.equal(item('show').backdrop, ref(show, 'fanart.jpg'));
  assert.equal(item('season').poster, ref(show, 'season01-poster.jpg'));
  assert.equal(item('episode').thumb, episode.replace(/\.mp4$/, '-thumb.jpg').replace(/^/, 'file:'));
});

test("an admin's hand-picked artwork stays; what they didn't pick comes from the folder", { skip }, async () => {
  run("UPDATE items SET poster = 'tmdb:/picked.jpg', art_json = ? WHERE title = 'Picked'", JSON.stringify({ poster: 'tmdb:/picked.jpg' }));
  const dir = path.join(films, 'Picked (2021)');
  picture(path.join(dir, 'poster.jpg'));
  picture(path.join(dir, 'fanart.jpg'));
  await scan(1);
  assert.equal(film('Picked').poster, 'tmdb:/picked.jpg');
  assert.equal(film('Picked').backdrop, ref(dir, 'fanart.jpg'));
});

test("TMDB's poster stays unless local artwork is preferred (as when metadata arrives)", { skip }, async () => {
  run("UPDATE items SET poster = 'tmdb:/online.jpg' WHERE title = 'Online'");
  const dir = path.join(films, 'Online (2019)');
  picture(path.join(dir, 'poster.jpg'));
  updateSettings({ preferLocalArtwork: false });
  await scan(1);
  assert.equal(film('Online').poster, 'tmdb:/online.jpg');
  updateSettings({ preferLocalArtwork: true });
  await scan(1);
  assert.equal(film('Online').poster, ref(dir, 'poster.jpg'));
});
