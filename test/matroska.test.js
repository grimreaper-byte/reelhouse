import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matroskaTracks, matroskaEncodedStreams } from '../server/media/matroska.js';
import { decide } from '../server/transcode/profile.js';

// ---------- a tiny Matroska writer (just the elements the reader looks at) ----------

const idBytes = (id) => {
  const hex = id.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
};
const sizeBytes = (n) => {
  if (n < 0x7f) return Buffer.from([0x80 | n]);
  if (n < 0x3fff) return Buffer.from([0x40 | (n >> 8), n & 0xff]);
  return Buffer.from([0x10 | (n >>> 24), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
};
const el = (id, ...kids) => {
  const data = Buffer.concat(kids.map((k) => (Buffer.isBuffer(k) ? k : typeof k === 'number' ? Buffer.from([k]) : Buffer.from(k, 'latin1'))));
  return Buffer.concat([idBytes(id), sizeBytes(data.length), data]);
};
const ebmlHeader = el(0x1a45dfa3, el(0x4282, 'matroska'));
const track = (number, type, codec, ...encoding) => el(0xae,
  el(0xd7, number), el(0x83, type), el(0x86, codec),
  ...(encoding.length ? [el(0x6d80, el(0x6240, ...encoding))] : []));
const headerStripping = el(0x5034, el(0x4254, 3), el(0x4255, 0));
const zlibByDefault = el(0x5034); // ContentCompression without ContentCompAlgo means zlib
const cluster = el(0x1f43b675, el(0xe7, 0));

let dir;
const write = (name, ...parts) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-mkv-'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const types = new Map([[0, 'video'], [1, 'audio'], [2, 'subtitle']]);

test('finds header removal compression on the video track', async () => {
  const file = write('old.mkv', ebmlHeader, el(0x18538067,
    el(0x1654ae6b, track(1, 1, 'V_MPEG4/ISO/AVC', headerStripping), track(2, 2, 'A_AAC'), track(3, 17, 'S_TEXT/UTF8')),
    cluster));
  const tracks = await matroskaTracks(file);
  assert.deepEqual(tracks.map((t) => [t.number, t.type, t.encoding]), [[1, 'video', 'header-stripping'], [2, 'audio', null], [3, 'subtitle', null]]);
  assert.deepEqual(await matroskaEncodedStreams(file, types), [{ index: 0, type: 'video', codec: 'V_MPEG4/ISO/AVC', encoding: 'header-stripping' }]);
});

test('a normal MKV has no encoded tracks', async () => {
  const file = write('new.mkv', ebmlHeader, el(0x18538067, el(0x1654ae6b, track(1, 1, 'V_MPEG4/ISO/AVC'), track(2, 2, 'A_AC3')), cluster));
  assert.deepEqual(await matroskaEncodedStreams(file, types), []);
});

test('compression without an algorithm is zlib; tracks without a codec are not streams', async () => {
  const file = write('zlib.mkv', ebmlHeader, el(0x18538067, el(0x1654ae6b,
    el(0xae, el(0xd7, 1), el(0x83, 1)), // no CodecID: ffmpeg skips it, so it has no stream index
    track(2, 1, 'V_MPEG4/ISO/AVC'),
    track(3, 2, 'A_AAC', zlibByDefault))));
  assert.deepEqual(await matroskaEncodedStreams(file, types), [{ index: 1, type: 'audio', codec: 'A_AAC', encoding: 'zlib' }]);
});

test('follows the SeekHead when the track list is far into the file', async () => {
  const filler = el(0xec, Buffer.alloc(3 * 1024 * 1024)); // Void element, bigger than the 2 MB first read
  const tracks = el(0x1654ae6b, track(1, 1, 'V_MPEG4/ISO/AVC', headerStripping), track(2, 2, 'A_AAC'));
  const seekHeadFor = (pos) => el(0x114d9b74, el(0x4dbb, el(0x53ab, idBytes(0x1654ae6b)), el(0x53ac, Buffer.from([pos >>> 24, (pos >>> 16) & 0xff, (pos >>> 8) & 0xff, pos & 0xff]))));
  const pos = seekHeadFor(0).length + filler.length; // Tracks' offset from the start of the Segment's data
  const file = write('late.mkv', ebmlHeader, el(0x18538067, seekHeadFor(pos), filler, tracks, cluster));
  assert.deepEqual((await matroskaEncodedStreams(file, types)).map((t) => [t.index, t.encoding]), [[0, 'header-stripping']]);
});

test('track types that disagree with ffprobe leave the stream index unknown', async () => {
  const file = write('odd.mkv', ebmlHeader, el(0x18538067, el(0x1654ae6b, track(1, 2, 'A_AAC', headerStripping), track(2, 1, 'V_MPEG4/ISO/AVC'))));
  assert.deepEqual((await matroskaEncodedStreams(file, types)).map((t) => [t.index, t.type]), [[null, 'audio']]);
});

test('anything that is not Matroska gives null', async () => {
  assert.equal(await matroskaTracks(write('x.mp4', Buffer.from('....ftypisom'))), null);
});

// ---------- playback decisions ----------

const firefox = { containers: ['mp4', 'webm', 'mkv'], video: ['h264'], audio: ['aac'] };
const chrome = { ...firefox, mkvContentEncoding: true };
const media = (mkvEncoded) => ({
  container: 'mkv',
  bitrate: 700_000,
  video: { index: 0, codec: 'h264', profile: 'High', bitDepth: 8, width: 1280, height: 528 },
  audio: [{ index: 1, codec: 'aac', isDefault: true }, { index: 2, codec: 'aac', isDefault: false }],
  subtitles: [{ index: 3, codec: 'subrip', text: true }],
  mkvEncoded,
});

test('header-compressed video converts in Firefox but plays directly in Chrome/Edge', () => {
  const m = media([{ index: 0, type: 'video', encoding: 'header-stripping' }]);
  const d = decide(m, firefox);
  assert.equal(d.mode, 'hls');
  assert.deepEqual(d.reasons, ['MKV header compression']);
  assert.equal(decide(m, chrome).mode, 'direct');
});

test('only the tracks being played matter', () => {
  assert.equal(decide(media([{ index: 3, type: 'subtitle', encoding: 'zlib' }]), firefox).mode, 'direct');
  const otherAudio = media([{ index: 2, type: 'audio', encoding: 'header-stripping' }]);
  assert.equal(decide(otherAudio, firefox).mode, 'direct');
  assert.ok(decide(otherAudio, firefox, { audioIndex: 2 }).reasons.includes('MKV header compression'));
  // Unknown stream index: go by type.
  assert.equal(decide(media([{ index: null, type: 'video', encoding: 'header-stripping' }]), firefox).mode, 'hls');
  // Not checked yet / no encodings.
  assert.equal(decide(media(undefined), firefox).mode, 'direct');
  assert.equal(decide(media([]), firefox).mode, 'direct');
});
