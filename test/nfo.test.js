// Rescans pick up .nfo files that are added, edited or removed after an item was first scanned.
// Uses real (tiny, generated) video files, so it's skipped when ffmpeg isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, closeDb, run, get } from '../server/db.js';
import { queueScan, scanStatus } from '../server/scanner/index.js';
import { parseNfo, mergeCast, withNfo } from '../server/scanner/local.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const needsFfmpeg = { skip: !hasFfmpeg && 'ffmpeg not installed' };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-nfo-'));
const tvRoot = path.join(tmp, 'TV');
const movieRoot = path.join(tmp, 'Movies');
const showDir = path.join(tvRoot, 'Night Shift (2019)');
const episodeFile = path.join(showDir, 'Season 01', 'Night Shift - S01E01 - Pilot.mkv');
const movieDir = path.join(movieRoot, 'Heat (1995)');
const movieFile = path.join(movieDir, 'Heat (1995).mkv');

function makeVideo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

// Each write gets a distinct modified time, as a real edit would.
let clock = Date.now() / 1000 - 3600;
function writeNfo(file, xml) {
  fs.writeFileSync(file, xml);
  clock += 60;
  fs.utimesSync(file, clock, clock);
}

async function scan(libraryId) {
  queueScan(libraryId);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const s = scanStatus();
    if (!s.running && !s.queue.length) return;
  }
  throw new Error('scan did not finish');
}

const show = () => ({ ...get("SELECT * FROM items WHERE type = 'show'") });
const episode = () => ({ ...get("SELECT * FROM items WHERE type = 'episode'") });
const movie = () => ({ ...get("SELECT * FROM items WHERE type = 'movie'") });
const cast = (row) => JSON.parse(row.cast_json || '[]');

before(() => {
  if (!hasFfmpeg) return;
  openDb(':memory:');
  makeVideo(episodeFile);
  makeVideo(movieFile);
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'TV', 'show', ?, ?), (2, 'Movies', 'movie', ?, ?)",
    JSON.stringify([tvRoot]), t, JSON.stringify([movieRoot]), t);
});

after(() => {
  if (hasFfmpeg) closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a tvshow.nfo added to a show that is already in the library is applied', needsFfmpeg, async () => {
  await scan(1);
  assert.equal(show().title, 'Night Shift');
  assert.equal(show().overview, null);
  // Pretend online metadata already gave the show a cast with photos.
  run("UPDATE items SET cast_json = ? WHERE type = 'show'", JSON.stringify([{ name: 'Ann Lee', role: 'Nurse', profile: 'tmdb:/ann.jpg' }]));

  writeNfo(path.join(showDir, 'tvshow.nfo'), `<tvshow><title>Night Shift</title><plot>Doctors at night.</plot>
    <actor><name>Ann Lee</name><role>Head Nurse</role></actor>
    <actor><name>Bo Chan</name><role>Surgeon</role><thumb>https://image.tmdb.org/t/p/original/bo.jpg</thumb></actor>
  </tvshow>`);
  await scan(1);
  const s = show();
  assert.equal(s.overview, 'Doctors at night.');
  assert.deepEqual(cast(s), [
    { name: 'Ann Lee', role: 'Head Nurse', profile: 'tmdb:/ann.jpg' }, // photo kept from the earlier cast
    { name: 'Bo Chan', role: 'Surgeon', profile: 'tmdb:/bo.jpg' }, // photo from the NFO's <thumb>
  ]);
  assert.ok(s.nfo_mtime);
});

test('editing tvshow.nfo updates the show; an unchanged NFO is left alone', needsFfmpeg, async () => {
  writeNfo(path.join(showDir, 'tvshow.nfo'), '<tvshow><title>Night Shift</title><plot>Doctors, at night, again.</plot></tvshow>');
  await scan(1);
  assert.equal(show().overview, 'Doctors, at night, again.');

  // Someone changes the row (e.g. online metadata); an untouched NFO must not overwrite it.
  run("UPDATE items SET overview = 'From TMDB' WHERE type = 'show'");
  await scan(1);
  assert.equal(show().overview, 'From TMDB');
});

test('removing an NFO forgets it and asks for online metadata again', needsFfmpeg, async () => {
  run("UPDATE items SET metadata_at = 1 WHERE type = 'show'");
  fs.rmSync(path.join(showDir, 'tvshow.nfo'));
  await scan(1);
  const s = show();
  assert.equal(s.nfo_json, null);
  assert.equal(s.nfo_mtime, null);
  assert.equal(s.metadata_at, null);
});

test('an episode NFO is picked up without the video changing', needsFfmpeg, async () => {
  writeNfo(episodeFile.replace(/\.mkv$/, '.nfo'), '<episodedetails><title>The First Night</title><plot>It begins.</plot></episodedetails>');
  await scan(1);
  assert.equal(episode().title, 'The First Night');
  assert.equal(episode().overview, 'It begins.');
});

test('editing a movie NFO updates the movie without re-reading the video', needsFfmpeg, async () => {
  await scan(2);
  assert.equal(movie().title, 'Heat');
  // A re-probe would overwrite this marker.
  run("UPDATE items SET media_json = '{\"marker\":true}' WHERE type = 'movie'");

  writeNfo(path.join(movieDir, 'movie.nfo'), '<movie><title>Heat</title><tagline>A Los Angeles crime saga</tagline><uniqueid type="tmdb">949</uniqueid></movie>');
  await scan(2);
  let m = movie();
  assert.equal(m.tagline, 'A Los Angeles crime saga');
  assert.equal(m.tmdb_id, 949);
  assert.equal(m.metadata_at, null, 'a new TMDB id in the NFO means fetching online metadata again');
  assert.equal(m.media_json, '{"marker":true}');

  // An NFO named after the video takes precedence over movie.nfo.
  writeNfo(path.join(movieDir, 'Heat (1995).nfo'), '<movie><title>Heat (Director\'s Cut)</title></movie>');
  await scan(2);
  m = movie();
  assert.equal(m.title, "Heat (Director's Cut)");
  assert.equal(m.sort_title, 'heat directors cut');
  assert.equal(m.media_json, '{"marker":true}');
});

test('a hand-picked match is not changed by an NFO id', needsFfmpeg, async () => {
  run("UPDATE items SET tmdb_id = 500, match_locked = 1, metadata_at = 1 WHERE type = 'movie'");
  writeNfo(path.join(movieDir, 'Heat (1995).nfo'), '<movie><title>Heat</title><uniqueid type="tmdb">949</uniqueid></movie>');
  await scan(2);
  const m = movie();
  assert.equal(m.title, 'Heat');
  assert.equal(m.tmdb_id, 500);
  assert.equal(m.metadata_at, 1);
});

// ---------- pure helpers ----------

test('actor thumbs from TMDB become cast photos; other thumbs are ignored', () => {
  const nfo = parseNfo(`<movie><title>X</title>
    <actor><name>A</name><thumb>https://image.tmdb.org/t/p/w185/a1.jpg</thumb></actor>
    <actor><name>B</name><thumb>https://example.com/b.jpg</thumb></actor>
    <actor><name>C</name></actor></movie>`);
  assert.deepEqual(nfo.cast.map((c) => c.profile), ['tmdb:/a1.jpg', null, null]);
});

test('NFO values win over online metadata, ids excepted; cast photos are matched by name', () => {
  const nfoJson = JSON.stringify({
    title: 'Heat (Director’s Cut)',
    tmdb_id: 1,
    cast_json: JSON.stringify([{ name: 'al pacino', role: 'Lt. Hanna', profile: null }]),
  });
  const tmdb = { title: 'Heat', tmdb_id: 949, overview: 'Thieves.', cast_json: JSON.stringify([{ name: 'Al Pacino', role: 'Vincent Hanna', profile: 'tmdb:/al.jpg' }]) };
  const out = withNfo(tmdb, nfoJson, null);
  assert.equal(out.title, 'Heat (Director’s Cut)');
  assert.equal(out.tmdb_id, 949);
  assert.equal(out.overview, 'Thieves.');
  assert.deepEqual(JSON.parse(out.cast_json), [{ name: 'al pacino', role: 'Lt. Hanna', profile: 'tmdb:/al.jpg' }]);
  assert.deepEqual(withNfo(tmdb, null, null), tmdb);
  assert.deepEqual(mergeCast([{ name: 'Z', role: null, profile: null }], []), [{ name: 'Z', role: null, profile: null }]);
});
