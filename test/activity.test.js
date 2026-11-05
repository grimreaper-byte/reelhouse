import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  browserName, clearStreams, clock, endStream, listStreams, QUIET_PAUSED_MS, QUIET_PLAYING_MS, reportStream,
  startStream, streamCount, streamLimitMessage, streamLimitReached, sweepStreams,
} from '../server/activity.js';
import { recentLogs } from '../server/lib/log.js';

const film = (over = {}) => ({
  userId: 1, username: 'admin', itemId: 7, title: 'My Movie', grandparentTitle: null, client: 'Pixel 8',
  ip: '192.168.0.20', duration: 477, mode: 'direct', quality: 'original', qualityLabel: 'Original', reasons: [], ...over,
});
const lastLog = () => recentLogs(1).at(-1)?.msg;

beforeEach(() => clearStreams());

test('a direct stream is logged with who started it, on what, and when it stops, where', () => {
  startStream('p1', film(), 1_000);
  assert.equal(lastLog(), 'User "admin" started "My Movie" on Pixel 8 (192.168.0.20) (direct play)');
  assert.equal(streamCount(), 1);
  reportStream('p1', { ...film(), position: 214.1, state: 'playing' }, 11_000);
  reportStream('p1', { ...film(), position: 230, state: 'stopped' }, 30_000);
  assert.match(lastLog(), /^User "admin" stopped "My Movie" on Pixel 8 \(192\.168\.0\.20\) at 3:50 of 7:57 \(direct play, /);
  assert.equal(streamCount(), 0);
});

test('conversions say why, episodes name the show, and finishing is logged as such', () => {
  const episode = film({ itemId: 9, title: 'Pilot', grandparentTitle: 'Some Show', seasonNumber: 1, episodeNumber: 2, mode: 'hls', reasons: ['avi container'], client: 'Firefox on Windows' });
  startStream('h1', episode);
  assert.equal(lastLog(), 'User "admin" started "Some Show" S1E2 "Pilot" on Firefox on Windows (192.168.0.20) (converting: avi container; Original)');
  reportStream('h1', { ...episode, state: 'ended' });
  assert.match(lastLog(), /^User "admin" finished "Some Show" S1E2 "Pilot"/);
});

test('a new decision for what the same user is watching on the same client carries on as the same stream', () => {
  startStream('p1', film(), 1_000);
  const before = recentLogs(500).length;
  startStream('h2', film({ mode: 'hls', reasons: ['picture check'] }), 5_000);
  assert.equal(streamCount(), 1);
  assert.equal(listStreams()[0].playId, 'h2');
  assert.equal(listStreams()[0].startedAt, 1_000);
  assert.equal(recentLogs(500).length, before + 1);
  assert.match(lastLog(), /^User "admin" switched "My Movie" on Pixel 8 .* to converting: picture check/);
  // Someone else (or another device) is a stream of its own.
  startStream('p3', film({ userId: 2, username: 'kid' }), 6_000);
  startStream('p4', film({ client: 'Firefox on Windows' }), 6_000);
  assert.equal(streamCount(), 3);
});

test('a player that goes quiet ends its stream: soon while playing, much later while paused', () => {
  startStream('p1', film(), 0);
  startStream('p2', film({ itemId: 8, title: 'Paused film' }), 0);
  reportStream('p2', { ...film({ itemId: 8, title: 'Paused film' }), position: 60, state: 'paused' }, 0);
  sweepStreams(QUIET_PLAYING_MS + 1);
  assert.deepEqual(listStreams().map((s) => s.playId), ['p2']);
  assert.match(recentLogs(5).map((l) => l.msg).join('\n'), /User "admin" stopped "My Movie" .*the player went quiet: closed, or its connection was lost/);
  sweepStreams(QUIET_PAUSED_MS + 1);
  assert.equal(streamCount(), 0);
  assert.match(lastLog(), /User "admin" stopped "Paused film" .* at 1:00 of 7:57 .*went quiet while paused/);
});

test('a report for a stream Reelhouse doesn\'t know (e.g. after a restart) starts one; a late stop is ignored', () => {
  reportStream('x1', { ...film(), position: 100, state: 'playing' });
  assert.equal(streamCount(), 1);
  assert.match(lastLog(), /^User "admin" started "My Movie"/);
  const before = recentLogs(500).length;
  reportStream('nope', { ...film(), state: 'stopped' });
  endStream('nope', 'stopped');
  assert.equal(recentLogs(500).length, before);
});

test('clients are named in plain words', () => {
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0'), 'Firefox on Windows');
  assert.equal(browserName('Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.equal(browserName('Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A226B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0 Mobile Safari/537.36'), 'Samsung Internet on Android');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36 Edg/150.0'), 'Edge on Windows');
  assert.equal(browserName('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1'), 'Safari on iOS');
  assert.equal(browserName(''), 'a browser');
  assert.equal(clock(5293), '1:28:13');
  assert.equal(clock(247), '4:07');
});

test('a stream limit counts other devices only: not the asking one, not downloads, not other people', () => {
  const tv = { client: 'Living room TV', ip: '192.168.0.30' };
  startStream('a', film({ client: tv.client, ip: tv.ip }), 1_000);
  startStream('b', film({ client: 'Kid’s phone', mode: 'download' }), 1_000); // a download played on the phone
  startStream('c', film({ userId: 2, username: 'kid', client: 'Firefox on Windows' }), 1_000); // someone else
  assert.equal(streamLimitReached(1, 1, tv), null, 'the TV itself may start something new');
  assert.equal(streamLimitReached(1, null, { client: 'Tablet', ip: '192.168.0.40' }), null, 'no limit');
  const reached = streamLimitReached(1, 1, { client: 'Tablet', ip: '192.168.0.40' });
  assert.deepEqual(reached.inUse.map((s) => s.playId), ['a']);
  assert.equal(streamLimitReached(1, 2, { client: 'Tablet', ip: '192.168.0.40' }), null);

  const episode = film({ itemId: 9, title: 'Pilot', grandparentTitle: 'Bluey', seasonNumber: 1, episodeNumber: 2, client: 'Phone' });
  assert.equal(streamLimitMessage({ limit: 2, inUse: [listStreams().find((s) => s.playId === 'a'), episode] }),
    'Your account can play on 2 devices at a time, and they’re all in use: “My Movie” on Living room TV, “Bluey S1E2” on Phone. '
    + 'Stop one of them first (a player that was just closed frees up within a few minutes).');

  // A player that went quiet frees its device.
  sweepStreams(1_000 + QUIET_PLAYING_MS + 1);
  assert.equal(streamLimitReached(1, 1, { client: 'Tablet', ip: '192.168.0.40' }), null);
});

test('copying the picture is logged, and so is falling back to converting it', () => {
  startStream('c1', film({ title: 'Thor', mode: 'hls', reasons: ['eac3 audio'], videoCopy: true }));
  assert.match(lastLog(), /\(converting: eac3 audio \(the picture copied as it is\); Original\)$/);
  // The browser couldn't show the copied picture: the player asks again, converting it.
  startStream('c2', film({ title: 'Thor', mode: 'hls', reasons: ['eac3 audio', 'transcode requested'], videoCopy: false }));
  assert.match(lastLog(), /^User "admin" switched "Thor" on Pixel 8 .* to converting: eac3 audio, transcode requested; Original$/);
});
