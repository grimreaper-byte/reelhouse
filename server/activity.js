// What's being watched right now: the admin's activity monitor (Settings → Activity & logs, and the count in the web
// app's top bar), and the server log's "started" and "stopped" lines for every stream, played directly or converted.
//
// A stream is tracked from the playback decision, kept up to date by the players' progress reports, and ends when the
// player says it stopped or finished, or goes quiet: players report every 10 s while playing but not while paused,
// so a paused stream gets longer before it counts as gone.
import { logger } from './lib/log.js';
import { activityChanged } from './events.js';

const log = logger('playback');

export const QUIET_PLAYING_MS = 2 * 60 * 1000;
export const QUIET_PAUSED_MS = 15 * 60 * 1000;

const streams = new Map(); // playId → stream

/** 1:28:05 or 4:07. */
export function clock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "Firefox on Windows", "Chrome on Android"…: a browser's name for the activity list and the log. */
export function browserName(userAgent = '') {
  const ua = String(userAgent);
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /OPR\//.test(ua) ? 'Opera'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : null;
  const system = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Windows/.test(ua) ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
          : /CrOS/.test(ua) ? 'ChromeOS'
            : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser || system || 'a browser';
}

/** The client a request came from: an app's sign-in name, else the browser. */
export function clientName(req) {
  return req.device || browserName(req.headers?.['user-agent']);
}

const title = (s) => (s.grandparentTitle
  ? `"${s.grandparentTitle}" ${s.seasonNumber != null ? `S${s.seasonNumber}E${s.episodeNumber ?? '?'}` : ''} "${s.title}"`.replace('  ', ' ')
  : `"${s.title}"`);

const how = (s) => (s.mode === 'direct' ? 'direct play'
  : s.mode === 'download' ? 'from a download'
    : s.mode === 'live' ? (s.radio ? 'live radio' : `live TV${s.qualityLabel ? `; ${s.qualityLabel}` : ''}`)
    : `converting${s.reasons?.length ? `: ${s.reasons.join(', ')}` : ''}${s.videoCopy ? ' (the picture copied as it is)' : ''}`
      + `${s.qualityLabel ? `; ${s.qualityLabel}` : ''}`);

/** Who, unmistakably a user name in the log: User "admin". */
const who = (s) => `User "${s.username}"`;

const where = (s) => `${s.client}${s.ip ? ` (${s.ip})` : ''}`;
const at = (s) => (s.position != null ? ` at ${clock(s.position)}${s.duration ? ` of ${clock(s.duration)}` : ''}` : '');

const sameViewing = (a, b) => a.userId === b.userId && a.itemId === b.itemId && a.client === b.client && a.ip === b.ip;

function changed() {
  activityChanged(streams.size);
}

/**
 * A player was told how to play something (POST /api/playback). A new decision for something the same user is
 * already watching on the same client (another quality or audio track, or switching to converting) carries on as
 * the same stream rather than a new one.
 */
export function startStream(playId, data, now = Date.now()) {
  const earlier = [...streams.values()].find((s) => s.playId !== playId && sameViewing(s, data));
  if (earlier) {
    streams.delete(earlier.playId);
    const stream = { ...earlier, ...data, playId, updatedAt: now };
    streams.set(playId, stream);
    if (earlier.mode !== stream.mode || earlier.quality !== stream.quality || !!earlier.videoCopy !== !!stream.videoCopy) {
      log.info(`${who(stream)} switched ${title(stream)} on ${where(stream)} to ${how(stream)}`);
    }
    return stream;
  }
  const stream = { position: null, state: 'playing', ...data, playId, startedAt: now, updatedAt: now };
  streams.set(playId, stream);
  log.info(`${who(stream)} started ${title(stream)} on ${where(stream)} (${how(stream)})`);
  changed();
  return stream;
}

/**
 * A progress report. Unknown play ids (e.g. after a restart of Reelhouse) start a stream; "stopped" and "ended" end
 * it. Returns the stream, or null once ended.
 */
export function reportStream(playId, data, now = Date.now()) {
  const known = streams.get(playId);
  if (data.state === 'stopped' || data.state === 'ended') {
    if (!known) return null;
    endStream(playId, data.state === 'ended' ? 'finished' : 'stopped', { ...data });
    return null;
  }
  if (!known) return startStream(playId, data, now);
  const stream = { ...known, ...data, playId, updatedAt: now };
  streams.set(playId, stream);
  return stream;
}

/** Ends a stream and logs it: [reason] is 'stopped', 'finished' or 'quiet' (no word from the player). */
export function endStream(playId, reason, update = {}) {
  const known = streams.get(playId);
  if (!known) return;
  const stream = { ...known, ...update };
  streams.delete(playId);
  const watched = clock(((update.now ?? Date.now()) - stream.startedAt) / 1000);
  if (reason === 'finished') {
    log.info(`${who(stream)} finished ${title(stream)} on ${where(stream)} (${how(stream)}, ${watched} since starting)`);
  } else if (reason === 'quiet') {
    log.info(`${who(stream)} stopped ${title(stream)} on ${where(stream)}${at(stream)} (${how(stream)}; the player `
      + `went quiet${stream.state === 'paused' ? ' while paused' : ''}: closed, or its connection was lost)`);
  } else {
    log.info(`${who(stream)} stopped ${title(stream)} on ${where(stream)}${at(stream)} (${how(stream)}, ${watched} since starting)`);
  }
  changed();
}

/** Ends streams whose player has gone quiet. */
export function sweepStreams(now = Date.now()) {
  for (const s of [...streams.values()]) {
    const limit = s.state === 'paused' ? QUIET_PAUSED_MS : QUIET_PLAYING_MS;
    if (now - s.updatedAt > limit) endStream(s.playId, 'quiet', { now });
  }
}

setInterval(() => sweepStreams(), 30000).unref();

// ---------- how many devices someone may play on at once ----------

const deviceOf = (s) => `${s.client}\n${s.ip}`;
const shortTitle = (s) => (s.grandparentTitle
  ? `${s.grandparentTitle}${s.seasonNumber != null ? ` S${s.seasonNumber}E${s.episodeNumber ?? '?'}` : ''}`
  : s.title);

/**
 * Whether a user with a stream limit may start playing on `device` ({ client, ip }): null when they may, else
 * { limit, inUse } with the newest stream on each other device. The device asking never counts against itself (a
 * new quality, or the next episode, replaces what it plays), and a download played on the phone doesn't count:
 * nothing streams from Reelhouse.
 */
export function streamLimitReached(userId, limit, device) {
  if (!limit) return null;
  const others = new Map();
  for (const s of [...streams.values()].sort((a, b) => b.updatedAt - a.updatedAt)) { // the newest on each device
    if (s.userId !== userId || s.mode === 'download' || deviceOf(s) === deviceOf(device)) continue;
    if (!others.has(deviceOf(s))) others.set(deviceOf(s), s);
  }
  return others.size >= limit ? { limit, inUse: [...others.values()] } : null;
}

/** What the person trying to play is told when their limit is reached. */
export function streamLimitMessage({ limit, inUse }) {
  const playing = inUse.map((s) => `“${shortTitle(s)}” on ${s.client}`);
  return limit === 1
    ? `Your account can play on one device at a time, and “${shortTitle(inUse[0])}” is playing on ${inUse[0].client}. `
      + 'Stop it there first (a player that was just closed frees up within a few minutes).'
    : `Your account can play on ${limit} devices at a time, and they’re all in use: ${playing.join(', ')}. `
      + 'Stop one of them first (a player that was just closed frees up within a few minutes).';
}

/** Logs a refused start, for the admin's Activity & logs. */
export function logStreamLimit(data, { limit }) {
  log.info(`${who(data)} couldn't start ${title(data)} on ${where(data)}: already playing on ${limit} `
    + `device${limit === 1 ? '' : 's'}, the most the account allows`);
}

/**
 * What's being watched, in the order it started (Settings → Activity's Now playing): a progress report doesn't move a
 * stream up the list, so two or more don't keep swapping places as their players report in turn.
 */
export const listStreams = () => [...streams.values()].sort((a, b) => a.startedAt - b.startedAt);
export const streamCount = () => streams.size;

/** For tests. */
export function clearStreams() {
  streams.clear();
}
