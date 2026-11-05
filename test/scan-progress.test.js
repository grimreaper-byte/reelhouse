// The top bar's "Adding …": only files new to a library, with the name of the one being read. Needs ffmpeg.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, closeDb, run } from '../server/db.js';
import { queueScan, scanStatus, addingEvents } from '../server/scanner/index.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-adding-'));
const movies = path.join(tmp, 'Movies');

function makeVideo(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

async function scan() {
  const events = [];
  const listen = (e) => events.push(e);
  addingEvents.on('progress', listen);
  queueScan(1);
  try {
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const s = scanStatus();
      if (!s.running && !s.queue.length) return events;
    }
    throw new Error('scan did not finish');
  } finally {
    addingEvents.off('progress', listen);
  }
}

before(() => {
  if (!hasFfmpeg) return;
  openDb(':memory:');
  for (const name of ['Heat (1995).mp4', 'Up (2009).mp4', 'My Movie (2015).mp4']) makeVideo(path.join(movies, name));
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', ?, ?)", JSON.stringify([movies]), Date.now());
});

after(() => {
  if (hasFfmpeg) closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('new files: announced with their names and how far along, then finished', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const events = await scan();
  assert.ok(events.length >= 2, 'at least a start and an end');
  assert.ok(events.every((e) => e.libraryId === 1 && e.libraryName === 'Movies' && e.total === 3));
  const named = new Set(events.map((e) => e.file).filter(Boolean));
  assert.ok([...named].every((f) => ['Heat (1995).mp4', 'Up (2009).mp4', 'My Movie (2015).mp4'].includes(f)), [...named].join(', '));
  assert.ok(named.size >= 1);
  const last = events.at(-1);
  assert.deepEqual({ done: last.done, file: last.file, finished: last.finished }, { done: 3, file: null, finished: true });
  assert.ok(events.slice(0, -1).every((e) => !e.finished && e.done <= 3));
  assert.equal(scanStatus().adding, null, 'nothing left showing');
});

test('a scan that finds nothing new shows nothing; one new file shows just that one', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  assert.deepEqual(await scan(), []);
  makeVideo(path.join(movies, 'Robots (2005).mp4'));
  const events = await scan();
  assert.ok(events.every((e) => e.total === 1));
  assert.ok(events.some((e) => e.file === 'Robots (2005).mp4'));
  assert.equal(events.at(-1).finished, true);
});

test('a file that can\'t be read isn\'t "added" again on every scan', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  fs.writeFileSync(path.join(movies, 'Broken (2020).mkv'), Buffer.alloc(4096, 7));
  const first = await scan();
  assert.ok(first.some((e) => e.file === 'Broken (2020).mkv'), 'tried once, as a new file');
  assert.deepEqual(await scan(), [], 'not new the next time, unless it changes');
  fs.appendFileSync(path.join(movies, 'Broken (2020).mkv'), Buffer.alloc(16, 1));
  assert.ok((await scan()).some((e) => e.file === 'Broken (2020).mkv'), 'changed: tried again');
});
