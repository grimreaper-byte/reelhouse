import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, qualitiesFor, videoKey } from '../server/transcode/profile.js';
import { parseNfo } from '../server/scanner/local.js';

const chrome = { containers: ['mp4', 'webm'], video: ['h264', 'vp9', 'av1'], audio: ['aac', 'mp3', 'opus', 'flac'] };

const media = (over = {}) => ({
  container: 'mp4',
  bitrate: 5_000_000,
  video: { index: 0, codec: 'h264', profile: 'High', bitDepth: 8, width: 1920, height: 1080 },
  audio: [{ index: 1, codec: 'aac', isDefault: true }],
  subtitles: [],
  ...over,
});

test('compatible mp4 plays directly', () => {
  assert.equal(decide(media(), chrome).mode, 'direct');
});

test('unsupported pieces force a transcode, with reasons', () => {
  const d = decide(media({ container: 'mkv', audio: [{ index: 1, codec: 'ac3', isDefault: true }] }), chrome);
  assert.equal(d.mode, 'hls');
  assert.deepEqual(d.reasons, ['mkv container', 'ac3 audio']);
});

test('a player that plays files itself (Kodi) is never sent a conversion', () => {
  const dvd = media({ container: 'mpeg', video: { index: 0, codec: 'mpeg2video', bitDepth: 8, width: 720, height: 480 }, audio: [{ index: 1, codec: 'pcm_dvd', isDefault: true }] });
  assert.equal(decide(dvd, { containers: ['mkv'], video: [], audio: [] }).mode, 'hls');
  const d = decide(dvd, {}, { direct: true, quality: '4m-720', burnSubtitle: 3, audioOffsetMs: 500, forceTranscode: true });
  assert.equal(d.mode, 'direct');
  assert.deepEqual([d.reasons, d.quality.id, d.burnSubtitle, d.audioOffsetMs], [[], 'original', null, 0]);
});

test('Firefox gets MKVs whose frames fall between milliseconds copied, for even frame times', () => {
  const firefox = { containers: ['mp4', 'webm', 'mkv'], video: ['h264', 'hevc', 'hevc10', 'vp9'], audio: ['aac', 'mp3', 'opus', 'flac'], copyVideo: ['h264', 'hevc', 'hevc10'], stampedFrameTimes: true };
  const mkv = (fps, over = {}) => media({ container: 'mkv', ...over, video: { ...media().video, fps, ...over.video } });
  const d = decide(mkv(23.976), firefox);
  assert.deepEqual([d.mode, d.reasons, d.videoCopy, d.directIfNoCopy], ['hls', ['MKV frame times'], true, true]);
  for (const fps of [24, 29.97, 30, 59.94, 60]) assert.equal(decide(mkv(fps), firefox).videoCopy, true, `${fps} fps`);
  // Frames on whole milliseconds, an MP4, or a player that doesn't show frames at their stamped times: as they are.
  for (const fps of [25, 50, null]) assert.equal(decide(mkv(fps), firefox).mode, 'direct', `${fps} fps`);
  assert.equal(decide(media({ video: { ...media().video, fps: 23.976 } }), firefox).mode, 'direct');
  assert.equal(decide(mkv(23.976), { ...firefox, stampedFrameTimes: false }).mode, 'direct');
  // A picture that can't be copied is still played as it is rather than converted.
  assert.equal(decide(mkv(23.976, { container: 'webm', video: { codec: 'vp9', profile: 'Profile 0' } }), firefox).mode, 'direct');
  assert.equal(decide(mkv(23.976, { video: { interlaced: true } }), firefox).mode, 'direct');
  // Converting for something else anyway: as before.
  const ac3 = decide(mkv(23.976, { audio: [{ index: 1, codec: 'ac3', isDefault: true }] }), firefox);
  assert.deepEqual([ac3.reasons, ac3.videoCopy, ac3.directIfNoCopy], [['ac3 audio'], true, false]);
});

test('10-bit H.264 is not browser-playable', () => {
  assert.equal(videoKey({ codec: 'h264', bitDepth: 10, profile: 'High 10' }), 'h264-hi');
  assert.equal(decide(media({ video: { index: 0, codec: 'h264', bitDepth: 10, profile: 'High 10', width: 1920, height: 1080 } }), chrome).mode, 'hls');
});

test('MPEG-4 Part 2 beyond Simple Profile (XviD, DivX) is converted for a phone that only decodes Simple', () => {
  const phone = { containers: ['mp4', 'mkv', 'avi'], video: ['h264', 'mpeg4'], audio: ['aac', 'mp3'] };
  const xvid = (profile, container = 'mkv') => media({
    container,
    bitrate: 719_000,
    video: { index: 0, codec: 'mpeg4', profile, bitDepth: 8, width: 576, height: 320 },
    audio: [{ index: 1, codec: 'mp3', isDefault: false }],
  });
  assert.equal(videoKey({ codec: 'mpeg4', profile: 'Simple Profile' }), 'mpeg4');
  assert.equal(videoKey({ codec: 'mpeg4', profile: 'Advanced Simple Profile' }), 'mpeg4-asp');
  assert.equal(videoKey({ codec: 'mpeg4', profile: null }), 'mpeg4-asp');
  assert.equal(decide(xvid('Simple Profile'), phone).mode, 'direct');
  const d = decide(xvid('Advanced Simple Profile'), phone);
  assert.equal(d.mode, 'hls');
  assert.deepEqual(d.reasons, ['mpeg4 Advanced Simple Profile video']);
  // In an AVI (where these usually are) both reasons show.
  assert.deepEqual(decide(xvid('Advanced Simple Profile', 'avi'), phone).reasons, ['avi container', 'mpeg4 Advanced Simple Profile video']);
  // Kodi plays it itself.
  assert.equal(decide(xvid('Advanced Simple Profile'), {}, { direct: true }).mode, 'direct');
});

test('AVI is converted even for a phone that says it reads AVI, but Kodi still plays it itself', () => {
  // Media3 times AVI sound chunks evenly; VirtualDub files put ~0.5 s of sound in the first one, so the sound ran
  // half a second ahead of the picture (seen with an XviD + AC3 AVI on two Samsung phones).
  const phone = { containers: ['mp4', 'mkv', 'avi'], video: ['h264', 'mpeg4'], audio: ['aac', 'ac3'] };
  const avi = media({ container: 'avi', bitrate: 1_900_000, audio: [{ index: 1, codec: 'ac3', isDefault: true }] });
  const d = decide(avi, phone);
  assert.deepEqual([d.mode, d.reasons], ['hls', ['avi container']]);
  assert.equal(decide(avi, {}, { direct: true }).mode, 'direct');
  assert.equal(decide(media({ container: 'mkv', audio: [{ index: 1, codec: 'ac3', isDefault: true }] }), phone).mode, 'direct');
});

test('picking a non-default audio track needs a transcode', () => {
  const m = media({ audio: [{ index: 1, codec: 'aac', isDefault: true }, { index: 2, codec: 'aac', isDefault: false }] });
  assert.equal(decide(m, chrome, { audioIndex: 1 }).mode, 'direct');
  const d = decide(m, chrome, { audioIndex: 2 });
  assert.equal(d.mode, 'hls');
  assert.equal(d.audio.index, 2);
});

test('quality limits apply to bitrate and resolution', () => {
  assert.equal(decide(media(), chrome, { quality: '8m-1080' }).mode, 'direct');
  assert.equal(decide(media(), chrome, { quality: '4m-720' }).mode, 'hls');
  assert.equal(decide(media({ bitrate: 15_000_000 }), chrome, { quality: '8m-1080' }).mode, 'hls');
  // Scope movies (1920x800) still count as 1080p.
  assert.equal(decide(media({ video: { index: 0, codec: 'h264', bitDepth: 8, width: 1920, height: 800 } }), chrome, { quality: '8m-1080' }).mode, 'direct');
});

test('only presets below the file are offered, and a higher one means the original', () => {
  const ids = (m) => qualitiesFor(m).map((q) => q.id);
  // 1080p at 5 Mbps: the 1080p presets all have more bitrate.
  assert.deepEqual(ids(media()), ['original', '4m-720', '2m-720', '1500k-480', '720k-360']);
  // A 0.7 Mbps SD AVI: nothing is below it.
  const sd = media({ bitrate: 719_000, video: { index: 0, codec: 'h264', bitDepth: 8, width: 576, height: 320 } });
  assert.deepEqual(ids(sd), ['original']);
  // 720p at 10 Mbps: lower bitrate alone isn't enough when the preset has more lines.
  assert.deepEqual(ids(media({ bitrate: 10_000_000, video: { index: 0, codec: 'h264', bitDepth: 8, width: 1280, height: 720 } })),
    ['original', '4m-720', '2m-720', '1500k-480', '720k-360']);
  // Unknown details don't hide anything.
  assert.equal(ids(media({ bitrate: null, video: null })).length, 8);
  // The remote default (or a preset picked for another file) above the file: the original, converted only if needed.
  const d = decide(sd, chrome, { quality: '4m-720' });
  assert.deepEqual([d.mode, d.quality.id, d.reasons], ['direct', 'original', []]);
  assert.equal(decide({ ...sd, container: 'avi' }, chrome, { quality: '4m-720' }).quality.id, 'original');
});

test('image subtitles are burned in', () => {
  const m = media({ subtitles: [{ index: 3, codec: 'hdmv_pgs_subtitle', text: false, image: true }] });
  const d = decide(m, chrome, { burnSubtitle: 3 });
  assert.equal(d.mode, 'hls');
  assert.equal(d.burnSubtitle, 3);
});

test('Kodi NFO files', () => {
  const nfo = parseNfo(`<?xml version="1.0"?>
<movie>
  <title>Heat</title>
  <year>1995</year>
  <plot>A group of professional bank robbers &amp; a detective.</plot>
  <genre>Crime</genre><genre>Thriller</genre>
  <director>Michael Mann</director>
  <uniqueid type="tmdb" default="true">949</uniqueid>
  <uniqueid type="imdb">tt0113277</uniqueid>
  <actor><name>Al Pacino</name><role>Vincent Hanna</role></actor>
</movie>`);
  assert.equal(nfo.title, 'Heat');
  assert.equal(nfo.year, 1995);
  assert.equal(nfo.overview, 'A group of professional bank robbers & a detective.');
  assert.deepEqual(nfo.genres, ['Crime', 'Thriller']);
  assert.equal(nfo.tmdbId, 949);
  assert.equal(nfo.imdbId, 'tt0113277');
  assert.deepEqual(nfo.cast, [{ name: 'Al Pacino', role: 'Vincent Hanna', profile: null }]);
  // An NFO that is just a link
  assert.deepEqual(parseNfo('https://www.themoviedb.org/movie/949-heat'), { tmdbId: 949 });
});
