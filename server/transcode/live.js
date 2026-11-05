// Live TV conversions: a channel from Tvheadend (MPEG-TS, read through a ticket link) converted on the fly into a live
// HLS playlist that slides along, keeping the last five minutes so a paused player can carry on. Broadcast pictures are
// interlaced (576i, 1080i) and their sound MP2, AC3, E-AC3 or AAC, so the picture is always deinterlaced and converted
// and the sound becomes stereo AAC. A session ends soon after its player stops asking for it, which frees Tvheadend's
// tuner for others. Radio stations have no picture: their sound alone is converted.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpegBin } from '../media/ffmpeg.js';
import { logger } from '../lib/log.js';
import { endStream } from '../activity.js';
import {
  ORIGINAL_MIN_KBPS, encoderFormatFilters, encoderInputArgs, pickEncoder, removeDir, scaleFilter, transcodeRoot,
  videoEncoderArgs,
} from './hls.js';
import { qualitiesFor, qualityById } from './profile.js';

const log = logger('livetv');

// Short segments, so the picture starts within a few seconds (a live playlist's segment length can't change later).
export const LIVE_SEGMENT_SECONDS = 2;
const WINDOW_SEGMENTS = 150; // five minutes to pause in, or go back in
// A player asks every few seconds, even paused; an object so tests can shorten it.
export const liveLimits = { idleEndMs: 30 * 1000 };
const FIRST_SEGMENT_MS = 30 * 1000; // tuning, then the first two seconds of picture
const RESTART_AFTER_MS = 60 * 1000; // a stream that ran this long gets restarted when it drops

const sessions = new Map();
// Each channel's picture size, as ffmpeg found it when the channel last started (until Reelhouse restarts): the
// next start knows which qualities are below it.
const pictures = new Map(); // channel uuid → { width, height }

/**
 * The qualities worth offering for a channel: Original, and the presets below its picture, as for files. A live
 * Original is converted like a file of unknown bitrate (up to ORIGINAL_MIN_KBPS), so presets above that aren't
 * lower, whatever the channel; nor are presets with more lines than it (720p for a 576-line channel). An unknown
 * picture rules out nothing by its size. Radio has only its Original.
 */
export function liveQualities(video, { radio = false } = {}) {
  if (radio) return [qualityById('original')];
  return qualitiesFor({ bitrate: ORIGINAL_MIN_KBPS * 1000, video });
}

export const getLiveSession = (id) => sessions.get(id);
export const listLiveSessions = () => [...sessions.values()];
/** Live sessions are always conversions (see activeTranscodeCount in hls.js). */
export const liveConversionCount = () => sessions.size;

/**
 * Starts converting a channel for a player and waits for the first segment. `streamUrl()` gives a fresh ticket link
 * (it's asked again when the stream has to restart). Throws a readable error (status 503) when it can't start.
 * `channel.radio` converts the sound alone; a channel found to have no picture switches to that and calls
 * `onRadio()` (so it's listed as radio from then on).
 */
export async function startLiveSession({ channel, quality, userId, streamUrl, onRadio }) {
  // A preset that isn't below the channel (as far as is known yet) means the original, as for files.
  if (!liveQualities(pictures.get(channel.uuid), { radio: channel.radio }).some((q) => q.id === quality.id)) {
    quality = qualityById('original');
  }
  const session = new LiveSession({ channel, quality, userId, streamUrl, onRadio });
  sessions.set(session.id, session);
  try {
    await session.start();
    await session.ready();
    session.settleQuality();
    return session;
  } catch (err) {
    session.destroy();
    throw Object.assign(err, { status: err.status || 503 });
  }
}

/** What ffmpeg's complaint about the stream means for the person watching. */
export function streamProblem(stderr, { started = false } = {}) {
  const text = String(stderr || '');
  if (/\b5\d\d\b|5XX/.test(text)) return 'Tvheadend has no free tuner for this channel right now (they may all be recording or in use)';
  if (/\b403\b/.test(text)) return 'This Tvheadend account isn\'t allowed to stream';
  if (/\b401\b/.test(text)) return 'Tvheadend refused the stream link';
  if (/\b404\b/.test(text)) return 'Tvheadend doesn\'t have that channel any more';
  if (/timed out|Connection timed out/i.test(text)) {
    return started ? 'The channel stopped sending (lost signal?)' : 'Tvheadend sent nothing for this channel (no signal?)';
  }
  if (/Connection refused|unreachable|No route to host/i.test(text)) return 'Couldn\'t reach Tvheadend';
  const last = text.trim().split('\n').filter(Boolean).at(-1);
  return started ? `The channel stopped${last ? ` (${last})` : ''}` : `Couldn't play this channel${last ? ` (${last})` : ''}`;
}

class LiveSession {
  constructor({ channel, quality, userId, streamUrl, onRadio }) {
    this.id = crypto.randomBytes(16).toString('hex');
    this.channel = channel;
    this.radio = !!channel.radio;
    this.onRadio = onRadio;
    this.quality = quality;
    this.video = null; // the channel's picture size, once ffmpeg has described the stream
    this.userId = userId;
    this.streamUrl = streamUrl;
    this.dir = path.join(transcodeRoot(), `live-${this.id}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.proc = null;
    this.procError = null;
    this.encoder = null;
    this.forceSoftware = false;
    this.runs = 0;
    this.runStartedAt = 0;
    this.lastActive = Date.now();
    this.createdAt = Date.now();
    this.destroyed = false;
  }

  get playlistPath() {
    return path.join(this.dir, 'live.m3u8');
  }

  touch() {
    this.lastActive = Date.now();
  }

  /** The next segment number: after the newest one so far, so a restarted run carries on the playlist. */
  nextNumber() {
    let max = -1;
    for (const name of safeReaddir(this.dir)) {
      const m = /^(\d+)\.ts$/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return max + 1;
  }

  async start() {
    if (this.destroyed) return;
    const url = await this.streamUrl();
    if (this.destroyed) return;
    const append = this.runs > 0 && fs.existsSync(this.playlistPath);
    const args = liveArgs(this, url, { append, startNumber: this.nextNumber() });
    this.runs++;
    this.runStartedAt = Date.now();
    this.procError = null;
    // The ticket in the link is short-lived, but still kept out of the log.
    log.debug(`ffmpeg ${args.join(' ').replace(/ticket=\w+/g, 'ticket=…')}`);
    const proc = spawn(ffmpegBin(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    // ffmpeg tags each line with its level: its description of the incoming stream (info, before "Output #0") gives
    // the picture size; its errors are kept to say what went wrong.
    let stderr = '';
    let partial = '';
    let pastInput = false;
    const onLine = (text) => {
      const m = /^((?:\[[^\]]* @ [^\]]*\] )?)\[(\w+)\] (.*)$/.exec(text);
      if (!m) {
        if (text.trim()) stderr = `${stderr}${text}\n`.slice(-4000);
        return;
      }
      const [, context, level, message] = m;
      if (level === 'info') {
        if (/^Output #0/.test(message)) pastInput = true;
        else if (!pastInput && !this.video) this.notePicture(message);
      } else if (level === 'error' || level === 'fatal' || level === 'panic') {
        stderr = `${stderr}${context}${message}\n`.slice(-4000);
      }
    };
    proc.stderr.on('data', (d) => {
      const lines = (partial + d.toString()).split(/\r?\n/);
      partial = lines.pop();
      lines.forEach(onLine);
    });
    proc.on('error', (err) => {
      if (this.proc === proc) {
        this.proc = null;
        this.procError = err.code === 'ENOENT' ? 'ffmpeg not found' : err.message;
      }
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc || proc.stoppedByUs || this.destroyed) return;
      this.proc = null;
      if (partial) onLine(partial);
      partial = '';
      const produced = fs.existsSync(this.playlistPath);
      // No picture in the stream: a radio station Tvheadend didn't say was one. Its sound alone, from now on.
      if (!produced && !this.radio && /Stream map '0:v:0' matches no streams|matches no streams/i.test(stderr)) {
        log.info(`"${this.channel.name}" has no picture: playing it as radio`);
        this.radio = true;
        this.onRadio?.();
        this.start().catch((err) => { this.procError = err.message; });
        return;
      }
      // A GPU encoder that fails straight away: the CPU instead, as conversions of files do.
      if (!produced && !this.radio && this.encoder !== 'libx264' && !this.forceSoftware && !/Server returned|timed out|refused/i.test(stderr)) {
        log.warn(`${this.encoder} failed for live TV "${this.channel.name}" (${stderr.trim().split('\n').at(-1) || `code ${code}`}); trying the CPU`);
        this.forceSoftware = true;
        this.start().catch((err) => { this.procError = err.message; });
        return;
      }
      // A stream that ran for a while and dropped (Tvheadend restarted, the signal went): pick it up again once.
      if (produced && Date.now() - this.runStartedAt > RESTART_AFTER_MS) {
        log.info(`Live TV "${this.channel.name}" stopped (${streamProblem(stderr, { started: true })}); starting it again`);
        this.start().catch((err) => { this.procError = err.message; });
        return;
      }
      this.procError = streamProblem(stderr, { started: produced });
      log.warn(`Live TV "${this.channel.name}": ${this.procError}`);
    });
    this.proc = proc;
  }

  /** From ffmpeg's description of the incoming stream: the first picture's size, kept for the channel too. */
  notePicture(message) {
    const m = /^\s*Stream #0:\d+\S*: Video: .*?, (\d{2,5})x(\d{2,5})\b/.exec(message);
    if (!m) return;
    this.video = { width: Number(m[1]), height: Number(m[2]) };
    pictures.set(this.channel.uuid, this.video);
  }

  /** The qualities to offer for this channel, now its picture is known. */
  qualities() {
    return liveQualities(this.video, { radio: this.radio });
  }

  /**
   * Once started: a preset that turned out to be above the channel (its picture wasn't known before) counts as the
   * original from now on. The conversion running already keeps the channel's own size (presets never scale up),
   * and a restart after a dropped stream uses the original's settings.
   */
  settleQuality() {
    if (!this.qualities().some((q) => q.id === this.quality.id)) this.quality = qualityById('original');
  }

  /** Resolves once the playlist has its first segment; rejects with the reason when the stream can't start. */
  ready() {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.destroyed) return reject(new Error('Stopped'));
        if (this.hasSegment()) return resolve();
        if (!this.proc && this.procError) return reject(new Error(this.procError));
        if (Date.now() - started > FIRST_SEGMENT_MS) return reject(new Error('Tvheadend took too long to start this channel'));
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  hasSegment() {
    try {
      return /\n\d+\.ts/.test(fs.readFileSync(this.playlistPath, 'utf8'));
    } catch {
      return false;
    }
  }

  /** ffmpeg's playlist as it stands (the last five minutes), or null before there is one. */
  playlist() {
    try {
      return fs.readFileSync(this.playlistPath, 'utf8');
    } catch {
      return null;
    }
  }

  segmentPath(name) {
    if (!/^\d+\.ts$/.test(name)) return null;
    const file = path.join(this.dir, name);
    return fs.existsSync(file) ? file : null;
  }

  maintain() {
    if (Date.now() - this.lastActive > liveLimits.idleEndMs) {
      log.debug(`Live TV "${this.channel.name}" ended: its player went quiet`);
      this.destroy();
      // Activity & logs says so now, not minutes later.
      endStream(this.id, 'quiet');
    }
  }

  stopProc() {
    const proc = this.proc;
    if (!proc) return;
    proc.stoppedByUs = true;
    this.proc = null;
    try {
      proc.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopProc();
    sessions.delete(this.id);
    removeDir(this.dir);
  }

  info() {
    return {
      id: this.id,
      live: true,
      channel: this.channel.name,
      userId: this.userId,
      running: !!this.proc,
      radio: this.radio,
      encoder: this.encoder,
      quality: this.quality.id,
      lastActive: this.lastActive,
      createdAt: this.createdAt,
    };
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** ffmpeg arguments for a live session. Exported for tests. */
export function liveArgs(session, url, { append = false, startNumber = 0 } = {}) {
  const { quality, radio } = session;
  const encoder = radio ? null : pickEncoder(session);
  session.encoder = encoder;
  const abr = quality.bitrate && quality.bitrate <= 2000 ? '128k' : '192k';
  const flags = ['delete_segments', 'temp_file', 'independent_segments'];
  if (append) flags.push('append_list', 'discont_start');
  // Radio: the sound alone. Television: yadif deinterlaces only the frames marked interlaced, so progressive
  // channels pass through untouched; a broadcast's bitrate isn't known up front, so "Original" is capped like a
  // file of unknown bitrate (10 Mbps).
  const picture = radio ? ['-map', '0:a:0', '-vn'] : [
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', ['yadif=0:-1:1', scaleFilter(quality), ...encoderFormatFilters(encoder)].join(','),
    ...videoEncoderArgs(encoder, quality, { bitrate: 0 }),
    '-force_key_frames', `expr:gte(t,n_forced*${LIVE_SEGMENT_SECONDS})`,
  ];
  return [
    '-hide_banner', '-loglevel', 'level+info', '-nostats', '-nostdin', '-y', ...(encoder ? encoderInputArgs(encoder) : []),
    '-fflags', '+genpts+discardcorrupt', '-analyzeduration', '2000000', '-probesize', '4000000',
    // Gives up on a stream that stops sending (lost signal) instead of waiting for ever.
    '-rw_timeout', '15000000',
    '-i', url,
    ...picture,
    '-c:a', 'aac', '-ac', '2', '-b:a', abr,
    '-sn', '-dn', '-map_metadata', '-1', '-max_muxing_queue_size', '4096',
    '-f', 'hls',
    '-hls_time', String(LIVE_SEGMENT_SECONDS),
    '-hls_list_size', String(WINDOW_SEGMENTS),
    '-hls_delete_threshold', '2',
    '-hls_segment_type', 'mpegts',
    '-hls_flags', flags.join('+'),
    '-start_number', String(startNumber),
    '-hls_segment_filename', path.join(session.dir, '%d.ts'),
    path.join(session.dir, 'live.m3u8'),
  ];
}

// ---------- lifecycle ----------

let timer = null;

export function startLiveManager() {
  timer = setInterval(() => {
    for (const s of [...sessions.values()]) s.maintain();
  }, 2000);
  timer.unref();
}

export function stopAllLiveSessions() {
  clearInterval(timer);
  for (const s of [...sessions.values()]) s.destroy();
}
