// A Tvheadend recordings folder as a library: a new episode's recording is named "New_ <show>" (the UK guide's
// "New: " with the ":" written as "_"), and those join their show. Scans real (tiny, generated) video files named as
// on a user's drive; skipped when ffmpeg isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, closeDb, run, get, all } from '../server/db.js';
import { queueScan, scanStatus } from '../server/scanner/index.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-rec-'));
const root = path.join(tmp, 'Recordings');
const file = (show, name) => path.join(root, show, name);
const files = {
  married11: file('Married at First Sight UK', 'Married at First Sight UK - S10E11 - Brand new series.ts'),
  married25: file('New_ Married at First Sight UK', 'New_ Married at First Sight UK - S10E25 - Brand new series.ts'),
  mock7: file('Mock The Week', 'Mock The Week - S02E07 -.ts'),
  mock8: file('New_ Mock The Week', 'New_ Mock The Week - S02E08 -.ts'),
  jury: file('New_ The Jury', 'New_ The Jury - S01E03 -.ts'),
};

function makeVideo(f) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]);
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

const t = 1_000;
function item(fields) {
  const f = { library_id: 1, title: 'x', sort_title: 'x', added_at: t, updated_at: t, ...fields };
  const cols = Object.keys(f);
  return Number(run(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...Object.values(f)).lastInsertRowid);
}
// An episode as an earlier scan stored it, so this scan finds its file unchanged.
function storedEpisode(show, season, episode, f) {
  const st = fs.statSync(f);
  return item({ type: 'episode', parent_id: season, show_id: show, season_number: 10, episode_number: episode, file_path: f,
    file_size: st.size, file_mtime: Math.floor(st.mtimeMs) });
}

// What the library shows: each show's title with its episodes' files.
const library = () => all("SELECT id, title, folder_path FROM items WHERE library_id = 1 AND type = 'show' ORDER BY sort_title")
  .map((s) => [s.title, all("SELECT file_path FROM items WHERE show_id = ? AND type = 'episode' ORDER BY season_number, episode_number", s.id)
    .map((e) => path.basename(e.file_path))]);

let old;

before(() => {
  if (!hasFfmpeg) return;
  openDb(':memory:');
  for (const f of Object.values(files)) makeVideo(f);
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Recorded TV', 'show', ?, ?)", JSON.stringify([root]), t);
  // Married at First Sight UK and The Jury as before 0.18.1: the "New_" show first, titled "New …", TMDB asked in vain.
  const newShow = item({ type: 'show', title: 'New Married at First Sight UK', sort_title: 'new married at first sight uk',
    folder_path: path.dirname(files.married25), metadata_at: t });
  const newSeason = item({ type: 'season', parent_id: newShow, show_id: newShow, season_number: 10 });
  const plainShow = item({ type: 'show', title: 'Married at First Sight UK', sort_title: 'married at first sight uk',
    folder_path: path.dirname(files.married11), metadata_at: t });
  const plainSeason = item({ type: 'season', parent_id: plainShow, show_id: plainShow, season_number: 10 });
  const juryShow = item({ type: 'show', title: 'New The Jury', sort_title: 'new the jury', folder_path: path.dirname(files.jury), metadata_at: t });
  const jurySeason = item({ type: 'season', parent_id: juryShow, show_id: juryShow, season_number: 1 });
  old = {
    plainShow,
    juryShow,
    e25: storedEpisode(newShow, newSeason, 25, files.married25),
    e11: storedEpisode(plainShow, plainSeason, 11, files.married11),
  };
  const st = fs.statSync(files.jury);
  item({ type: 'episode', parent_id: jurySeason, show_id: juryShow, season_number: 1, episode_number: 3, file_path: files.jury,
    file_size: st.size, file_mtime: Math.floor(st.mtimeMs) });
  const viewer = Number(run("INSERT INTO users (username, password_hash, created_at) VALUES ('viewer', 'x', ?)", t).lastInsertRowid);
  run('INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (?, ?, 0, 1, 1, ?)', viewer, old.e25, t);
});

after(() => {
  if (hasFfmpeg) closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('"New_ …" recordings join their show, old and new, and keep what was watched', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  await scan(1);
  assert.deepEqual(library(), [
    ['The Jury', ['New_ The Jury - S01E03 -.ts']],
    ['Married at First Sight UK', ['Married at First Sight UK - S10E11 - Brand new series.ts', 'New_ Married at First Sight UK - S10E25 - Brand new series.ts']],
    ['Mock The Week', ['Mock The Week - S02E07 -.ts', 'New_ Mock The Week - S02E08 -.ts']],
  ]);
  // The plain-named show is the one kept (with its id), the episode moved keeps its id and its watched mark.
  const married = get("SELECT id FROM items WHERE library_id = 1 AND type = 'show' AND title = 'Married at First Sight UK'");
  assert.equal(married.id, old.plainShow);
  assert.equal(get('SELECT show_id FROM items WHERE id = ?', old.e25).show_id, old.plainShow);
  assert.equal(get('SELECT watched FROM user_state WHERE item_id = ?', old.e25).watched, 1);
  // The Jury is asked about on TMDB again, under its plain name.
  assert.deepEqual({ ...get('SELECT id, sort_title, metadata_at FROM items WHERE id = ?', old.juryShow) },
    { id: old.juryShow, sort_title: 'jury', metadata_at: null });
});

test('a second scan changes nothing', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const first = library();
  const ids = all("SELECT id FROM items WHERE library_id = 1 ORDER BY id").map((r) => r.id);
  await scan(1);
  assert.deepEqual(library(), first);
  assert.deepEqual(all("SELECT id FROM items WHERE library_id = 1 ORDER BY id").map((r) => r.id), ids);
});

test('recordings lying in the library folder (Tvheadend\'s default) join their show too', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const loose = path.join(tmp, 'DVR');
  const e7 = path.join(loose, 'Mock The Week - S02E07 -.ts');
  const e8 = path.join(loose, 'New_ Mock The Week - S02E08 -.ts');
  const e9 = path.join(loose, 'New_ Mock The Week - S02E09 -.ts');
  for (const f of [e7, e8, e9]) makeVideo(f);
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (2, 'DVR', 'show', ?, ?)", JSON.stringify([loose]), t);
  // E08 as a scan before 0.18.1 filed it: under a show of its own, "New Mock The Week"; E07 and E09 are new.
  const show = item({ library_id: 2, type: 'show', title: 'New Mock The Week', sort_title: 'new mock the week',
    folder_path: `${loose}${path.sep}::new mock the week`, metadata_at: t });
  const season = item({ library_id: 2, type: 'season', parent_id: show, show_id: show, season_number: 2 });
  const st = fs.statSync(e8);
  const old8 = item({ library_id: 2, type: 'episode', parent_id: season, show_id: show, season_number: 2, episode_number: 8, file_path: e8,
    file_size: st.size, file_mtime: Math.floor(st.mtimeMs) });

  await scan(2);
  const shows = all("SELECT id, title FROM items WHERE library_id = 2 AND type = 'show'").map((r) => ({ ...r }));
  assert.deepEqual(shows, [{ id: show, title: 'Mock The Week' }]);
  assert.deepEqual(all("SELECT file_path FROM items WHERE show_id = ? AND type = 'episode' ORDER BY episode_number", show)
    .map((e) => path.basename(e.file_path)), [e7, e8, e9].map((f) => path.basename(f)));
  assert.equal(get('SELECT show_id FROM items WHERE id = ?', old8).show_id, show);
});
