// Converting only the sound: the picture is copied as it is, in segments cut at the file's own keyframes.
// Needs ffmpeg and ffprobe on the PATH (they make the test film, and the server uses them).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-copy-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { probe } = await import('../server/media/ffmpeg.js');
const { matroskaKeyframes } = await import('../server/media/matroska.js');
const { decide } = await import('../server/transcode/profile.js');
const { copyFailedFor, copyLimits, copySegmentStarts, createSession } = await import('../server/transcode/hls.js');

// Keyframes at uneven times, as films have them; B-frames, like most films. (Some ffmpeg versions' encoders delay the
// whole film by a few ms, so the times are checked from its first keyframe.)
const KEYFRAMES = [0, 2.5, 5, 6.5, 9, 12.75, 14, 18.5, 20, 25.25, 27, 31, 33.5, 38];
const FRAMES = 40 * 24;
// Each segment starts at the keyframe that makes the one before closest to 6 s.
const STARTS = [0, 6.5, 12.75, 18.5, 25.25, 31, 38];
const firefox = { containers: ['mp4', 'webm', 'mkv'], video: ['h264', 'hevc10'], audio: ['aac', 'mp3', 'opus', 'flac'], copyVideo: ['h264', 'hevc10'] };

let film;

before(() => {
  openDb(':memory:');
  film = path.join(dataDir, 'film.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=40', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '1000', '-sc_threshold', '0',
    '-force_key_frames', KEYFRAMES.join(','), '-c:a', 'ac3', '-b:a', '192k', film]);
});

after(() => {
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** A segment's packets of one kind ('v:0' or 'a:0'): [{ pts, key }], in file order. */
function packets(file, stream) {
  const json = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream,
    '-show_entries', 'packet=pts_time,flags', '-of', 'json', file]).toString());
  return json.packets.map((p) => ({ pts: Number(p.pts_time), key: p.flags.startsWith('K') }));
}

/** A segment's video frames are 1/24 s apart (in display order). */
function evenlySpaced(video, what) {
  const pts = video.map((p) => p.pts).sort((a, b) => a - b);
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i] - pts[i - 1];
    assert.ok(Math.abs(gap * 24 - 1) < 0.001, `${what}: frames ${(gap * 1000).toFixed(2)} ms apart`);
  }
}

const media4k = (over = {}) => ({
  container: 'mkv',
  bitrate: 60_000_000,
  duration: 7200,
  video: { index: 0, codec: 'hevc', profile: 'Main 10', bitDepth: 10, width: 3840, height: 2160, hdr: 'HDR10' },
  audio: [{ index: 1, codec: 'eac3', isDefault: true }, { index: 2, codec: 'aac', isDefault: false }],
  subtitles: [{ index: 3, codec: 'hdmv_pgs_subtitle', text: false }],
  ...over,
});

test('the picture is copied when only the sound or the file around it needs converting', () => {
  const d = decide(media4k(), firefox);
  assert.equal(d.mode, 'hls');
  assert.deepEqual(d.reasons, ['eac3 audio']);
  assert.equal(d.videoCopy, true);
  // Another audio track, or an MKV the browser doesn't read: still only the sound and the file around the picture.
  assert.equal(decide(media4k({ audio: [{ index: 1, codec: 'aac', isDefault: true }, { index: 2, codec: 'aac' }] }), firefox, { audioIndex: 2 }).videoCopy, true);
  assert.equal(decide(media4k(), { ...firefox, containers: ['mp4'] }).videoCopy, true);
});

test('anything that changes the picture converts it', () => {
  assert.equal(decide(media4k(), firefox, { quality: '8m-1080' }).videoCopy, false);
  assert.equal(decide(media4k(), firefox, { burnSubtitle: 3 }).videoCopy, false);
  assert.equal(decide(media4k(), firefox, { audioOffsetMs: 200 }).videoCopy, false);
  assert.equal(decide(media4k(), firefox, { forceTranscode: true }).videoCopy, false);
  assert.equal(decide(media4k({ video: { ...media4k().video, interlaced: true } }), firefox).videoCopy, false);
  // The picture itself is the problem, or the player didn't say it takes copied pictures.
  assert.equal(decide(media4k(), { ...firefox, video: ['h264'] }).videoCopy, false);
  assert.equal(decide(media4k(), { ...firefox, copyVideo: ['h264'] }).videoCopy, false);
  assert.equal(decide(media4k(), { ...firefox, copyVideo: undefined }).videoCopy, false);
  // Only Matroska files have the keyframe index the segments are cut by.
  assert.equal(decide(media4k({ container: 'mp4' }), { ...firefox, audio: [] }).videoCopy, false);
  // Nothing to convert at all: played directly.
  assert.equal(decide(media4k({ audio: [{ index: 1, codec: 'aac', isDefault: true }] }), firefox).mode, 'direct');
});

test('segments come as close to 6 s as the keyframes allow, with no sliver at the end', () => {
  assert.deepEqual(copySegmentStarts(KEYFRAMES, 40), STARTS);
  assert.deepEqual(copySegmentStarts([0, 6, 12, 18, 23.5], 24), [0, 6, 12, 18]);
  assert.deepEqual(copySegmentStarts([0], 3), [0]);
  // Keyframes 10 s apart where one falls just short of 6 s (as in most films): cut there, not 10 s later.
  assert.deepEqual(copySegmentStarts([0, 5.9, 15.9, 25.9, 31.8, 41.8], 50), [0, 5.9, 15.9, 25.9, 31.8, 41.8]);
  // Never shorter than 1 s.
  assert.deepEqual(copySegmentStarts([0, 0.8, 12, 18], 30), [0, 12, 18]);
  assert.deepEqual(copySegmentStarts([0, 1.5, 12, 18], 30), [0, 1.5, 12, 18]);
  // Keyframes far apart make long segments, up to 20 s, and none too big for a browser's buffer in one piece.
  assert.deepEqual(copySegmentStarts([0, 10, 21], 30), [0, 10, 21]);
  assert.equal(copySegmentStarts([0, 25], 40), null);
  assert.deepEqual(copySegmentStarts([0, 10, 20], 30, 60_000_000), [0, 10, 20]);
  assert.equal(copySegmentStarts([0, 10, 20], 30, 100_000_000), null);
  // One with another right after it isn't a start (a run could land on the other one).
  assert.deepEqual(copySegmentStarts([0, 6, 6.1, 12.1, 13], 20), [0, 6.1, 12.1]);
  // A picture that starts a little after the sound: the stream starts with it (not when the first keyframe is a
  // second or more in: that's taken as the index missing the first).
  assert.deepEqual(copySegmentStarts([0.25, 6.25, 12.25, 18.25], 24), [0.25, 6.25, 12.25, 18.25]);
  assert.deepEqual(copySegmentStarts([1.5, 7.5, 13.5], 20), [0, 7.5, 13.5]);
});

test('the keyframes come from the Matroska index', async () => {
  const keys = await matroskaKeyframes(film);
  assert.deepEqual(keys.map((k) => Math.round((k - keys[0]) * 1000) / 1000), KEYFRAMES);
  // No index (or not Matroska): nothing to cut by.
  const plain = path.join(dataDir, 'film.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', film, '-c', 'copy', '-t', '3', plain]);
  assert.equal(await matroskaKeyframes(plain), null);
});

test('copied segments start on their keyframes and line up across runs, seeks included', async () => {
  const media = await probe(film);
  const decision = decide(media, firefox);
  assert.equal(decision.videoCopy, true);
  const keys = await matroskaKeyframes(film);
  const starts = copySegmentStarts(keys, media.duration);
  assert.deepEqual(starts.slice(1).map((s) => Math.round((s - keys[0]) * 1000) / 1000), STARTS.slice(1));
  decision.segmentStarts = starts;
  const item = { id: 'copy-film', title: 'Copy film', file_path: film, duration: media.duration };
  // Runs of 2 segments, so the test crosses from one run to the next.
  const perRun = copyLimits.segmentsPerRun;
  copyLimits.segmentsPerRun = 2;
  const session = createSession({ item, media, decision, userId: 1 });
  try {
    assert.equal(session.copy, true);
    assert.equal(session.segmentCount, STARTS.length);
    const playlist = session.playlist();
    assert.match(playlist, /#EXT-X-TARGETDURATION:7\n/);
    assert.match(playlist, /\n0\.ts\n#EXTINF:6\.250000,\n1\.ts\n#EXTINF:5\.750000,\n2\.ts\n#EXTINF:6\.750000,\n3\.ts/);

    // Start in the middle (a seek), then from the start, then the rest in order.
    const seen = new Map();
    for (const n of [3, 4, 0, 1, 2, 3, 4, 5, 6]) {
      const file = await session.getSegment(n);
      if (!seen.has(n)) seen.set(n, { video: packets(file, 'v:0'), audio: packets(file, 'a:0') });
    }
    // MPEG-TS (and the B-frames' delay) move every timestamp by the same amount: measure it from the first segment.
    const offset = seen.get(0).video[0].pts - keys[0];
    for (const [n, { video, audio }] of seen) {
      const first = n === 0 ? keys[0] : starts[n];
      const next = starts[n + 1];
      assert.ok(video[0].key, `segment ${n} starts on a keyframe`);
      assert.ok(Math.abs(video[0].pts - offset - first) < 0.002, `segment ${n} starts at ${first} (got ${video[0].pts - offset})`);
      if (next != null) assert.ok(Math.max(...video.map((p) => p.pts)) - offset < next - 0.01, `segment ${n} ends before the next one starts`);
      assert.ok(Math.abs(audio[0].pts - offset - first) < 0.15, `segment ${n}'s sound starts with its picture (${audio[0].pts - offset})`);
      // 24 frames a second, none missing or doubled.
      const frames = next != null ? Math.round((next - first) * 24) : FRAMES - Math.round((first - keys[0]) * 24);
      assert.equal(video.length, frames, `segment ${n} has all its frames`);
    }

    // Matroska keeps frame times in milliseconds (41 or 42 ms apart at 24 fps): served, they're an even 1/24 s apart.
    for (const [n, { video }] of seen) evenlySpaced(video, `segment ${n}`);

    // Only the finished pieces are kept: what runs wrote past their share, or were writing when stopped, is removed.
    await new Promise((r) => setTimeout(r, 300));
    const kept = new Set([...session.files.values()].map((f) => path.basename(f)));
    assert.deepEqual(fs.readdirSync(session.dir).filter((f) => f.endsWith('.ts')).sort(), [...kept].sort());
    assert.equal(copyFailedFor(item.id), false);
  } finally {
    copyLimits.segmentsPerRun = perRun;
    session.destroy();
  }
});

test('frames that show before their keyframe (open GOPs) keep their times when a run starts there', async () => {
  // As x265 makes films by default: after a keyframe come B-frames that show before it. ffmpeg can't time those when
  // it starts at that keyframe, and squeezes them into a tick or two (a hitch, and frame times that can't be evened).
  const open = path.join(dataDir, 'open-gop.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=25',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '3', '-x264-params', 'open-gop=1', '-g', '1000', '-sc_threshold', '0',
    '-force_key_frames', '0,5,10,15,20', '-c:a', 'ac3', '-b:a', '192k', open]);
  const film = packets(open, 'v:0');
  const k = film.findIndex((p, i) => i > 0 && p.key);
  assert.ok(film[k + 1].pts < film[k].pts, 'the frame after the second keyframe shows before it');
  const media = await probe(open);
  const decision = { ...decide(media, firefox), segmentStarts: copySegmentStarts(await matroskaKeyframes(open), media.duration) };
  assert.equal(decision.segmentStarts.length, 5);
  const item = { id: 'open-gop', title: 'Open GOP film', file_path: open, duration: media.duration };
  const perRun = copyLimits.segmentsPerRun;
  copyLimits.segmentsPerRun = 2;
  const session = createSession({ item, media, decision, userId: 1 });
  try {
    // A seek to segment 3 starts a run there, one back to 2 another; then the rest.
    const seen = new Map();
    for (const n of [3, 2, 4, 0, 1]) {
      const file = await session.getSegment(n);
      if (!seen.has(n)) seen.set(n, packets(file, 'v:0'));
    }
    for (const [n, video] of seen) evenlySpaced(video, `segment ${n}`);
    // The frames before a segment's keyframe follow on from the segment before, from whichever run.
    const times = (n) => seen.get(n).map((p) => p.pts);
    for (const n of [1, 2, 3, 4]) {
      const gap = Math.min(...times(n)) - Math.max(...times(n - 1));
      assert.ok(Math.abs(gap * 24 - 1) < 0.001, `segments ${n - 1} and ${n}: ${(gap * 1000).toFixed(2)} ms between them`);
    }
    assert.equal([...seen.values()].reduce((sum, video) => sum + video.length, 0), 25 * 24, 'every frame once');
  } finally {
    copyLimits.segmentsPerRun = perRun;
    session.destroy();
  }
});

test('a picture that starts after the sound: the stream starts with it, and runs from the start line up with the rest', async () => {
  // As in about 1 film in 20: here the picture starts 0.25 s in. The first run used to count its cut times from 0
  // (one ffmpeg version cut a segment late, another left a gap where the next run took over).
  const late = path.join(dataDir, 'late-start.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-itsoffset', '0.25', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=24',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=24.25', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '2', '-g', '1000', '-sc_threshold', '0',
    '-force_key_frames', '0,6,12,18', '-c:a', 'ac3', late]);
  const media = await probe(late);
  const keys = await matroskaKeyframes(late);
  const starts = copySegmentStarts(keys, media.duration);
  assert.ok(Math.abs(starts[0] - 0.25) < 0.01, `the stream starts with the picture (${starts[0]})`);
  const decision = { ...decide(media, firefox), segmentStarts: starts };
  const item = { id: 'late-start', title: 'Late start', file_path: late, duration: media.duration };
  const perRun = copyLimits.segmentsPerRun;
  copyLimits.segmentsPerRun = 2;
  const session = createSession({ item, media, decision, userId: 1 });
  try {
    // From the start, in runs of 2: the run for segment 2 takes over from the first one.
    const seen = [];
    for (const n of [0, 1, 2, 3]) {
      const file = await session.getSegment(n);
      seen[n] = { video: packets(file, 'v:0'), audio: packets(file, 'a:0') };
    }
    const offset = seen[0].video[0].pts - starts[0];
    seen.forEach(({ video, audio }, n) => {
      assert.ok(video[0].key && Math.abs(video[0].pts - offset - starts[n]) < 0.002, `segment ${n} starts on its keyframe (${video[0].pts - offset})`);
      assert.ok(Math.abs(audio[0].pts - offset - starts[n]) < 0.15, `segment ${n}'s sound starts with its picture`);
      evenlySpaced(video, `segment ${n}`);
      if (n) {
        const gap = Math.min(...video.map((p) => p.pts)) - Math.max(...seen[n - 1].video.map((p) => p.pts));
        assert.ok(Math.abs(gap * 24 - 1) < 0.001, `segments ${n - 1} and ${n}: ${(gap * 1000).toFixed(2)} ms between them`);
      }
    });
    assert.equal(seen.reduce((sum, { video }) => sum + video.length, 0), 24 * 24, 'every frame once');
  } finally {
    copyLimits.segmentsPerRun = perRun;
    session.destroy();
  }
});

test('converted segments have even frame times too', async () => {
  const media = await probe(film);
  const decision = decide(media, { ...firefox, copyVideo: [] });
  assert.equal(decision.videoCopy, false);
  const item = { id: 'convert-film', title: 'Converted film', file_path: film, duration: media.duration };
  const session = createSession({ item, media, decision, userId: 1 });
  try {
    for (const n of [0, 1]) evenlySpaced(packets(await session.getSegment(n), 'v:0'), `converted segment ${n}`);
  } finally {
    session.destroy();
  }
});

test('Firefox gets an MKV it could play itself copied for even frame times, or as it is without an index', async () => {
  // The same 24 fps film with sound Firefox plays (AAC), with the usual keyframe index and without one (as a recording
  // written live has none).
  const made = {};
  for (const [name, extra] of [['indexed', []], ['no-index', ['-live', '1']]]) {
    made[name] = path.join(dataDir, `${name}.mkv`);
    execFileSync('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:a', 'aac', ...extra, made[name]]);
  }
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?)", t);
  made['late-start'] = path.join(dataDir, 'late-start.mkv'); // from the test above
  for (const [id, name] of [[1, 'indexed'], [2, 'no-index'], [3, 'late-start']]) {
    const media = await probe(made[name]);
    run("INSERT INTO items (id, library_id, type, title, sort_title, year, file_path, media_json, duration, added_at, updated_at) VALUES (?, 1, 'movie', ?, ?, 2026, ?, ?, 8, ?, ?)",
      id, name, name, made[name], JSON.stringify(media), t, t);
  }
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'owner', ?, 1, ?)", await hashPassword('a long password'), t);
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };
  try {
    const signIn = await fetch(`${base}/api/auth/device`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'owner', password: 'a long password', device: 'Test' }) });
    const auth = { ...H, authorization: `Bearer ${(await signIn.json()).token}` };
    const play = async (id, caps) => (await fetch(`${base}/api/playback/${id}`, { method: 'POST', headers: auth, body: JSON.stringify({ caps }) })).json();
    const stampedFirefox = { ...firefox, stampedFrameTimes: true };

    const copied = await play(1, stampedFirefox);
    assert.deepEqual([copied.mode, copied.videoCopy, copied.reasons], ['hls', true, ['MKV frame times']]);
    // (Some ffmpeg versions write the picture a few ms in, after the AAC encoder's start-up.)
    assert.ok(copied.timelineStart < 0.05, `timeline starts with the film (${copied.timelineStart})`);
    await fetch(`${base}/api/hls/${copied.sessionId}`, { method: 'DELETE', headers: auth });
    // A picture that starts after the sound: the player's time 0 is where it starts.
    const late = await play(3, stampedFirefox);
    assert.ok(late.videoCopy && Math.abs(late.timelineStart - 0.25) < 0.01, `timeline starts at ${late.timelineStart}`);
    await fetch(`${base}/api/hls/${late.sessionId}`, { method: 'DELETE', headers: auth });
    const noIndex = await play(2, stampedFirefox);
    assert.deepEqual([noIndex.mode, noIndex.reasons], ['direct', []], 'nothing to cut by: played as it is, not converted');
    assert.equal((await play(1, firefox)).mode, 'direct', 'a player that doesn’t show frames at their stamped times plays it as it is');
  } finally {
    server.close();
  }
});

test('a file copying fails for is converted in full from then on', async () => {
  const media = await probe(film);
  const decision = { ...decide(media, firefox), segmentStarts: STARTS };
  const item = { id: 'copy-missing', title: 'Missing film', file_path: path.join(dataDir, 'gone.mkv'), duration: media.duration };
  const session = createSession({ item, media, decision, userId: 1 });
  try {
    await assert.rejects(session.getSegment(0), /Couldn't copy the picture/);
    assert.equal(copyFailedFor(item.id), true);
    // Asking again doesn't try again: the player starts a new session, which converts the picture.
    await assert.rejects(session.getSegment(1), /Couldn't copy the picture/);
    assert.equal(session.run, 1);
  } finally {
    session.destroy();
  }
});
