// Scans real (tiny, generated) video files. Skipped when ffmpeg isn't installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, closeDb, run, all } from '../server/db.js';
import { queueScan, scanStatus } from '../server/scanner/index.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-scan-'));
const tvRoot = path.join(tmp, 'TV');
const parked = path.join(tmp, 'parked');

function makeVideo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
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

// node:sqlite rows have a null prototype; copy them so deepEqual compares plain objects.
const episodes = () => all("SELECT title, season_number, episode_number FROM items WHERE type = 'episode' ORDER BY season_number, episode_number")
  .map((r) => ({ ...r }));

before(() => {
  if (!hasFfmpeg) return;
  openDb(':memory:');
  makeVideo(path.join(tvRoot, 'Some Show (2020)', 'Season 01', 'Some Show - S01E01 - Pilot.mp4'));
  makeVideo(path.join(tvRoot, 'Some Show (2020)', 'Season 01', 'Some Show - S01E02 - Second.mp4'));
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'TV', 'show', ?, ?)", JSON.stringify([tvRoot]), Date.now());
});

after(() => {
  if (hasFfmpeg) closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scans shows, seasons and episodes', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  await scan(1);
  assert.deepEqual(episodes(), [
    { title: 'Pilot', season_number: 1, episode_number: 1 },
    { title: 'Second', season_number: 1, episode_number: 2 },
  ]);
  assert.equal(all("SELECT title FROM items WHERE type = 'show'")[0].title, 'Some Show');
});

test('a deleted file is removed on rescan', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  fs.mkdirSync(parked, { recursive: true });
  fs.renameSync(path.join(tvRoot, 'Some Show (2020)', 'Season 01', 'Some Show - S01E02 - Second.mp4'), path.join(parked, 'e2.mp4'));
  await scan(1);
  assert.deepEqual(episodes().map((e) => e.title), ['Pilot']);
});

test('an empty library folder (unmounted share) keeps its items', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  fs.renameSync(path.join(tvRoot, 'Some Show (2020)'), path.join(parked, 'Some Show (2020)'));
  await scan(1);
  assert.deepEqual(episodes().map((e) => e.title), ['Pilot'], 'items survive while the folder is empty');
  fs.renameSync(path.join(parked, 'Some Show (2020)'), path.join(tvRoot, 'Some Show (2020)'));
});

test('a missing library folder keeps its items', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  fs.renameSync(tvRoot, `${tvRoot}-offline`);
  await scan(1);
  assert.deepEqual(episodes().map((e) => e.title), ['Pilot']);
  fs.renameSync(`${tvRoot}-offline`, tvRoot);
});
