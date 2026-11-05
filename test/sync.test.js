import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb } from '../server/db.js';
import { decide, clampOffset, MAX_AUDIO_OFFSET_MS } from '../server/transcode/profile.js';
import { buildArgs } from '../server/transcode/hls.js';
import { updateSettings } from '../server/settings.js';

const chrome = { containers: ['mp4'], video: ['h264'], audio: ['aac'] };
const media = {
  container: 'mp4',
  bitrate: 5_000_000,
  duration: 600,
  video: { index: 0, codec: 'h264', profile: 'High', bitDepth: 8, width: 1920, height: 1080 },
  audio: [{ index: 1, codec: 'aac', isDefault: true }, { index: 2, codec: 'aac', isDefault: false }],
  subtitles: [{ index: 3, codec: 'hdmv_pgs_subtitle', text: false, image: true }],
};

before(() => openDb(':memory:'));
after(() => closeDb());

const args = (decision, segment = 0) => buildArgs({ media, item: { file_path: '/m/film.mp4' }, decision, dir: '/tmp/x' }, segment);
const after_ = (list, flag) => list[list.indexOf(flag) + 1];

test('offsets are clamped whole milliseconds, both directions', () => {
  assert.equal(clampOffset(250.4, 1000), 250);
  assert.equal(clampOffset(-250, 1000), -250);
  assert.equal(clampOffset('-75', 1000), -75);
  assert.equal(clampOffset(99999, 1000), 1000);
  assert.equal(clampOffset(-99999, 1000), -1000);
  assert.equal(clampOffset('nope', 1000), 0);
  assert.equal(clampOffset(undefined, 1000), 0);
});

test('an audio offset needs conversion; zero keeps direct play', () => {
  assert.equal(decide(media, chrome, { audioOffsetMs: 0 }).mode, 'direct');
  for (const ms of [200, -200]) {
    const d = decide(media, chrome, { audioOffsetMs: ms });
    assert.equal(d.mode, 'hls');
    assert.equal(d.audioOffsetMs, ms);
    assert.deepEqual(d.reasons, ['audio sync adjustment']);
  }
  assert.equal(decide(media, chrome, { audioOffsetMs: 60000 }).audioOffsetMs, MAX_AUDIO_OFFSET_MS);
});

test('subtitle offsets only reach the server for burned-in subtitles', () => {
  assert.equal(decide(media, chrome, { subtitleOffsetMs: 500 }).subtitleOffsetMs, 0);
  assert.equal(decide(media, chrome, { subtitleOffsetMs: 500 }).mode, 'direct');
  assert.equal(decide(media, chrome, { burnSubtitle: 3, subtitleOffsetMs: -500 }).subtitleOffsetMs, -500);
});

test('no offset: one input, audio mapped from it', () => {
  const a = args(decide(media, chrome, { forceTranscode: true }));
  assert.equal(a.filter((x) => x === '-i').length, 1);
  assert.ok(!a.includes('-itsoffset'));
  assert.ok(a.join(' ').includes('-map 0:1'));
});

test('positive audio offset: audio read from a second input shifted later', () => {
  const a = args(decide(media, chrome, { audioOffsetMs: 250 }), 10); // starts at 60 s
  assert.equal(a.filter((x) => x === '-i').length, 2);
  assert.equal(after_(a, '-itsoffset'), '0.250');
  // The audio input is seeked so that, after shifting, it starts where the video does.
  const second = a.indexOf('-itsoffset');
  assert.equal(a[a.lastIndexOf('-ss', second)], '-ss');
  assert.equal(a[a.lastIndexOf('-ss', second) + 1], '59.750');
  assert.ok(a.includes('-noaccurate_seek'));
  // ...and cut exactly at the segment start, so segments from different runs don't overlap or gap.
  assert.ok(after_(a, '-filter_complex').endsWith(';[1:1]atrim=start=60.000[aout]'));
  assert.ok(a.join(' ').includes('-map [aout]'));
});

test('negative audio offset: audio shifted earlier, seeked ahead', () => {
  const a = args(decide(media, chrome, { audioOffsetMs: -400, audioIndex: 2 }), 10);
  assert.equal(after_(a, '-itsoffset'), '-0.400');
  assert.equal(a[a.lastIndexOf('-ss', a.indexOf('-itsoffset')) + 1], '60.400');
  assert.ok(after_(a, '-filter_complex').endsWith(';[1:2]atrim=start=60.000[aout]'));
  assert.ok(a.join(' ').includes('-map [aout]'));
});

test('audio offset at the very start never seeks before zero', () => {
  const a = args(decide(media, chrome, { audioOffsetMs: 300 }), 0);
  assert.ok(!a.includes('-ss'));
  assert.equal(after_(a, '-itsoffset'), '0.300');
});

test('burned-in subtitle offset shifts the subtitle frames', () => {
  const plain = after_(args(decide(media, chrome, { burnSubtitle: 3 })), '-filter_complex');
  assert.match(plain, /^\[0:0\]\[0:3\]overlay/);
  const late = after_(args(decide(media, chrome, { burnSubtitle: 3, subtitleOffsetMs: 1500 })), '-filter_complex');
  assert.match(late, /^\[0:3\]setpts=PTS\+1\.500\/TB\[subs\];\[0:0\]\[subs\]overlay/);
  const early = after_(args(decide(media, chrome, { burnSubtitle: 3, subtitleOffsetMs: -1500 })), '-filter_complex');
  assert.match(early, /setpts=PTS-1\.500\/TB/);
});

test('NVENC encodes without B-frames (they break timestamps with ffmpeg 5.x)', () => {
  updateSettings({ encoder: 'h264_nvenc' });
  try {
    const a = args(decide(media, chrome, { forceTranscode: true }), 3);
    assert.equal(after_(a, '-c:v'), 'h264_nvenc');
    assert.equal(after_(a, '-bf'), '0');
  } finally {
    updateSettings({ encoder: 'libx264' });
  }
});
