// Even frame times in MPEG-TS segments (server/transcode/even-timestamps.js). Needs ffmpeg and ffprobe on the PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evenSegmentFile, evenVideoTimestamps, exactRate } from '../server/transcode/even-timestamps.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-even-'));
const FILM = 24000 / 1001;

/** Video frame times (s, in display order) and whether any frame is decoded after it's shown. */
function frames(file) {
  const json = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,dts_time', '-of', 'json', file]).toString());
  const pts = json.packets.map((p) => Number(p.pts_time));
  return { pts: [...pts].sort((a, b) => a - b), reordered: json.packets.some((p) => Number(p.dts_time) < Number(p.pts_time) - 1e-6) };
}
const gapsMs = (pts) => pts.slice(1).map((t, i) => (t - pts[i]) * 1000);

/** MPEG-TS of a 23.976 fps picture (B-frames, so decode and display order differ) by way of [container]. */
function segment(name, container, extra = []) {
  const src = path.join(dir, `${name}.${container}`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=160x90:r=${FILM}:d=8`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', ...extra, src]);
  const ts = path.join(dir, `${name}.ts`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-c:v', 'copy', '-f', 'mpegts', ts]);
  return ts;
}

let mkv;
before(() => {
  mkv = segment('film', 'mkv');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('common frame rates as exact fractions', () => {
  assert.deepEqual(exactRate(23.976), [24000, 1001]);
  assert.deepEqual(exactRate(29.97), [30000, 1001]);
  assert.deepEqual(exactRate(25), [25, 1]);
  assert.equal(exactRate(23.5), null);
});

test("a Matroska film's millisecond frame times are put back on its even 23.976 fps grid, order and all", async () => {
  const before = frames(mkv);
  assert.ok(gapsMs(before.pts).some((g) => Math.abs(g - 1000 / FILM) > 0.2), 'the times start uneven (41 and 42 ms)');
  const changed = await evenSegmentFile(mkv, exactRate(23.976));
  assert.ok(changed > 0);
  const after = frames(mkv);
  assert.equal(after.pts.length, before.pts.length);
  for (const g of gapsMs(after.pts)) assert.ok(Math.abs(g - 1000 / FILM) < 0.02, `gap ${g} ms`);
  assert.ok(after.reordered, 'B-frames still decoded before they show');
  for (const [i, t] of after.pts.entries()) assert.ok(Math.abs(t - before.pts[i]) < 0.0006, 'no frame moves more than its rounding');
  execFileSync('ffmpeg', ['-v', 'error', '-i', mkv, '-f', 'null', '-']); // still decodes
  assert.equal(await evenSegmentFile(mkv, exactRate(23.976)), 0, 'nothing more to do the second time');
});

test("times that are already even, or don't fit the rate given, are left alone", () => {
  const mp4 = fs.readFileSync(segment('even', 'mp4', ['-video_track_timescale', '24000']));
  const copy = Buffer.from(mp4);
  assert.deepEqual(evenVideoTimestamps(copy, exactRate(23.976)), []);
  assert.ok(copy.equals(mp4));
  // The Matroska film taken for 25 fps: its frames don't sit on that grid, so nothing changes.
  const film = fs.readFileSync(segment('film25', 'mkv'));
  const copy25 = Buffer.from(film);
  assert.deepEqual(evenVideoTimestamps(copy25, exactRate(25)), []);
  assert.ok(copy25.equals(film));
});
