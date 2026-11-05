// On-demand HLS transcoding.
//
// Each playback gets a session with a pre-computed VOD playlist of fixed 6-second segments covering
// the whole file, so players can seek anywhere. Segments are produced by ffmpeg on demand: when a
// segment that isn't being produced is requested (e.g. after a seek), ffmpeg is restarted at that
// segment. Keyframes are forced on segment boundaries and timestamps are kept absolute (-copyts),
// so segments from different ffmpeg runs line up seamlessly.
//
// When only the sound (or the file's container) needs converting, the picture is copied as it is (decision.videoCopy):
// no keyframes can be forced then, so the segments follow the file's own keyframes, from its index (Matroska Cues),
// each starting at the first keyframe at least 6 s after the last. ffmpeg's segment muxer cuts at those times.
//
// Either way a finished segment's video frame times are evened out before it's served (even-timestamps.js): files that
// keep them to the millisecond (Matroska) would otherwise judder slightly in browsers.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from '../settings.js';
import { dirs } from '../lib/paths.js';
import { ffmpegBin, cachedCapabilities, noteVaapiConstantQuality, vaapiRateControlFrom } from '../media/ffmpeg.js';
import { logger } from '../lib/log.js';
import { liveConversionCount } from './live.js';
import { evenSegmentFile, exactRate } from './even-timestamps.js';

const log = logger('transcode');

export const SEGMENT_SECONDS = 6;
const AHEAD_MAX = 40; // pause ffmpeg when this many segments are ready beyond the playhead
const AHEAD_MIN = 12; // resume when fewer than this many are ready
const KEEP_BEHIND = 30; // delete segments this far behind the playhead
// Copying the picture is quick and copied 4K is large (~75 MB a segment): copy runs stay less far ahead, keep less
// behind, and drop what's far ahead after a seek back (it's quickly copied again).
const COPY_WINDOW = { aheadMax: 12, aheadMin: 6, keepBehind: 6 };
const IDLE_STOP_MS = 90 * 1000; // stop ffmpeg when nothing was requested for this long
const SESSION_TTL_MS = 30 * 60 * 1000; // forget sessions idle this long
const SEGMENT_WAIT_MS = 120 * 1000;

const sessions = new Map();
// Items whose copied-picture conversion failed: they're converted in full from then on (until Reelhouse restarts).
const copyFailed = new Set();
export const copyFailedFor = (itemId) => copyFailed.has(itemId);
// A run stops after this many copied segments and the next one carries on (keeps the cut list within Windows' command
// line limit for long films). An object so tests can lower it.
export const copyLimits = { segmentsPerRun: 1200 };
// A copy run starting mid-film asks for this long after its keyframe (see buildCopyArgs).
const COPY_SEEK_PAST = 0.15;
// Copied segments can't be shorter than this, and one longer than COPY_MAX_SECONDS or (by the file's bitrate) bigger
// than COPY_MAX_BYTES means converting the picture instead: too long to wait for after a seek, or too big for a
// browser's buffer in one piece (Firefox refuses a single piece over ~150 MB; peaks run above the average bitrate).
const COPY_MIN_SECONDS = 1;
const COPY_MAX_SECONDS = 20;
const COPY_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Where copied-picture segments start (seconds): the first keyframe, then whichever of the file's keyframes (sorted,
 * seconds) makes each segment closest to SEGMENT_SECONDS. Films often have keyframes 10 s apart, so the first one past
 * 6 s alone would give 16 s segments. Not at a keyframe with another right after it (a run starting there could land on
 * the other one), nor in the last second. Null when the keyframes are too far apart (see COPY_MAX_SECONDS).
 * The first keyframe is usually at 0; in some films the picture starts a little after the sound (by up to half a
 * second), and then the stream starts with the picture: every run, the first too, then starts at a keyframe, so they
 * all line up and every ffmpeg version cuts them alike (some count the cut times from the picture's first frame). The
 * sound before it is left out, and the player is told where its time 0 is in the film (timelineStart).
 */
export function copySegmentStarts(keyframes, duration, bitrate = 0) {
  const starts = [keyframes[0] > 0 && keyframes[0] < 1 ? keyframes[0] : 0];
  keyframes.forEach((k, i) => {
    const next = keyframes[i + 1] ?? Infinity;
    if (duration - k < 1 || next - k <= COPY_SEEK_PAST + 0.05) return;
    const since = k - starts.at(-1);
    const short = SEGMENT_SECONDS - since; // how far short of 6 s cutting here leaves the segment
    const over = next - starts.at(-1) - SEGMENT_SECONDS; // how far over 6 s it gets if the next keyframe is waited for
    if (short <= 1e-6 || (since >= COPY_MIN_SECONDS && over > 0 && short < over)) starts.push(k);
  });
  let longest = 0;
  starts.forEach((s, i) => { longest = Math.max(longest, (starts[i + 1] ?? duration) - s); });
  if (longest > COPY_MAX_SECONDS || (longest * (bitrate || 0)) / 8 > COPY_MAX_BYTES) return null;
  return starts;
}

export function transcodeRoot() {
  // A user-chosen folder may hold other files, and this folder is emptied on startup — so always
  // work inside a dedicated subfolder of it.
  const custom = getSetting('transcodeDir');
  return custom ? path.join(custom, 'reelhouse-transcode') : dirs.transcode;
}

export function getSession(id) {
  return sessions.get(id) || null;
}

export function listSessions() {
  return [...sessions.values()];
}

export function activeTranscodeCount() {
  // Copying the picture costs next to nothing: those don't count against the limit. Live TV always converts.
  return [...sessions.values()].filter((s) => !s.copy && (s.proc || Date.now() - s.lastActive < 60000)).length
    + liveConversionCount();
}

export function createSession({ item, media, decision, userId }) {
  // A user re-starting the same item (quality/audio change) replaces the previous session.
  for (const s of sessions.values()) {
    if (s.userId === userId && s.item.id === item.id) s.destroy();
  }
  const max = Number(getSetting('maxTranscodes')) || 0;
  if (max > 0 && !decision.videoCopy && activeTranscodeCount() >= max) {
    const err = new Error(`The server is already converting ${max} video(s). Try again later or pick a direct-playable quality.`);
    err.status = 503;
    throw err;
  }
  const session = new HlsSession({ item, media, decision, userId });
  sessions.set(session.id, session);
  return session;
}

class HlsSession {
  constructor({ item, media, decision, userId }) {
    this.id = crypto.randomBytes(16).toString('hex');
    this.item = item;
    this.media = media;
    this.decision = decision;
    this.userId = userId;
    this.dir = path.join(transcodeRoot(), this.id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.duration = media.duration || item.duration || 0;
    // Copied pictures: segments start at the file's keyframes (decision.segmentStarts), else every SEGMENT_SECONDS.
    this.copy = !!decision.videoCopy && Array.isArray(decision.segmentStarts) && decision.segmentStarts.length > 0;
    this.starts = this.copy ? decision.segmentStarts : null;
    this.window = this.copy ? COPY_WINDOW : { aheadMax: AHEAD_MAX, aheadMin: AHEAD_MIN, keepBehind: KEEP_BEHIND };
    // Copy runs write straight to their own files (<run>-<n>.ts), never over another run's: finished ones are kept here.
    this.run = 0;
    this.procEnd = 0;
    this.files = new Map();
    this.segmentCount = this.copy ? this.starts.length : Math.max(1, Math.ceil(this.duration / SEGMENT_SECONDS - 0.001));
    this.proc = null;
    this.procStart = -1;
    this.procError = null;
    this.produced = new Set();
    this.lastRequested = 0;
    this.lastActive = Date.now();
    this.createdAt = Date.now();
    this.destroyed = false;
    this.encoder = null; // set by buildArgs
    this.forceSoftware = false;
    // The film's frame rate as a fraction, for evening out frame times (null: a rate that isn't a common one).
    this.rate = media.video?.fps ? exactRate(media.video.fps) : null;
    this.evening = new Map(); // segment file → its evening out (done once)
  }

  touch() {
    this.lastActive = Date.now();
  }

  /** When segment n starts, in seconds of the film. */
  segmentStart(n) {
    return this.copy ? this.starts[n] : n * SEGMENT_SECONDS;
  }

  segmentLength(n) {
    const end = n + 1 < this.segmentCount ? this.segmentStart(n + 1) : this.duration;
    return Math.max(end - this.segmentStart(n), 0.1);
  }

  playlist() {
    let longest = SEGMENT_SECONDS;
    for (let i = 0; i < this.segmentCount; i++) longest = Math.max(longest, this.segmentLength(i));
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      // (Lengths are differences of keyframe times: 7.000000000000004 is 7.)
      `#EXT-X-TARGETDURATION:${Math.ceil(longest - 0.001)}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
    ];
    for (let i = 0; i < this.segmentCount; i++) lines.push(`#EXTINF:${this.segmentLength(i).toFixed(6)},`, `${i}.ts`);
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
  }

  segmentPath(n) {
    if (this.copy) return this.files.get(n) || this.runPath(this.run, n);
    return path.join(this.dir, `${n}.ts`);
  }

  runPath(run, n) {
    return path.join(this.dir, `${run}-${n}.ts`);
  }

  /** Copy runs: segment n of a run is finished once the run has begun n + 1 (or ended by itself, see start()). */
  noteFinished(run, n) {
    const file = this.runPath(run, n);
    const old = this.files.get(n);
    if (old && old !== file) fs.rm(old, { force: true }, () => {});
    this.files.set(n, file);
    this.produced.add(n);
  }

  /** A copy run has ended: keep what it finished (all it wrote, when it ended by itself) and remove the rest. */
  endRun(run, from, end, byItself) {
    if (byItself) for (let i = from; i < end && fs.existsSync(this.runPath(run, i)); i++) this.noteFinished(run, i);
    fs.readdir(this.dir, (err, names) => {
      if (err) return;
      const kept = new Set(this.files.values());
      for (const name of names) {
        const file = path.join(this.dir, name);
        if (name.startsWith(`${run}-`) && !kept.has(file)) fs.rm(file, { force: true }, () => {});
      }
    });
  }

  has(n) {
    if (this.produced.has(n)) return true;
    if (this.copy) {
      const ours = this.proc && n >= this.procStart && n < this.procEnd;
      if (ours && fs.existsSync(this.runPath(this.run, n)) && fs.existsSync(this.runPath(this.run, n + 1))) {
        this.noteFinished(this.run, n);
        return true;
      }
      return false;
    }
    // Converted segments appear under their name only once complete (hls temp_file).
    if (fs.existsSync(this.segmentPath(n))) {
      this.produced.add(n);
      return true;
    }
    return false;
  }

  // Highest segment index ready contiguously from n (n - 1 when n itself isn't ready).
  readyThrough(n) {
    let i = n;
    while (i < this.segmentCount && this.has(i)) i++;
    return i - 1;
  }

  async getSegment(n) {
    if (this.destroyed) throw Object.assign(new Error('Session ended'), { status: 404 });
    if (!Number.isInteger(n) || n < 0 || n >= this.segmentCount) throw Object.assign(new Error('No such segment'), { status: 404 });
    this.touch();
    this.lastRequested = n;
    this.cleanupBehind();

    if (this.has(n)) {
      // Keep the encoder ahead of the player.
      if (!this.proc) {
        const ready = this.readyThrough(n);
        if (ready - n < this.window.aheadMin && ready + 1 < this.segmentCount) this.start(ready + 1);
      }
      return this.evened(this.segmentPath(n));
    }

    // Will the running encoder reach n soon? Otherwise restart it at n (a seek).
    const frontier = this.proc ? this.readyThrough(this.procStart) : -1;
    if (!this.proc || n < this.procStart || n > frontier + 3) this.start(n);
    return this.evened(await this.waitFor(n));
  }

  /** A finished segment file, its video frame times evened out first (once). Served as it is if that fails. */
  async evened(file) {
    if (!this.rate) return file;
    let job = this.evening.get(file);
    if (!job) {
      job = evenSegmentFile(file, this.rate)
        .then((changed) => {
          if (changed && !this.evenedAny) log.debug(`Evening out the frame times of "${this.item.title}" (its file keeps them to the millisecond)`);
          this.evenedAny ||= changed > 0;
        })
        .catch((err) => log.warn(`Couldn't even out the frame times of a segment of "${this.item.title}": ${err.message}`));
      this.evening.set(file, job);
    }
    await job;
    return file;
  }

  waitFor(n) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let restarted = false;
      const tick = () => {
        if (this.destroyed) return reject(Object.assign(new Error('Session ended'), { status: 404 }));
        if (this.has(n)) return resolve(this.segmentPath(n));
        if (!this.proc) {
          if (this.procError) return reject(new Error(this.procError));
          // Encoder stopped without producing n. Try once more from n; if that also ends
          // cleanly, n lies past the real end of the media.
          if (restarted) return reject(Object.assign(new Error('Segment is past the end of the media'), { status: 404 }));
          restarted = true;
          this.start(n);
        }
        if (Date.now() - started > SEGMENT_WAIT_MS) return reject(new Error('Timed out waiting for the transcoder'));
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  start(n) {
    this.stopProc();
    if (this.destroyed) return;
    // Copying failed for this file (here or in another session): only a new session, converting the picture, plays it.
    if (this.copy && copyFailed.has(this.item.id)) {
      this.procError ||= "Couldn't copy the picture; starting playback again converts it";
      return;
    }
    this.run++;
    const run = this.run;
    const args = buildArgs(this, n);
    const end = this.procEnd;
    log.debug(`ffmpeg ${args.join(' ')}`);
    const proc = spawn(ffmpegBin(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    proc.on('error', (err) => {
      if (this.proc === proc) {
        this.proc = null;
        this.procError = err.code === 'ENOENT' ? 'ffmpeg not found' : err.message;
      }
    });
    proc.on('exit', (code) => {
      // A copy run that ended by itself (the film's end, or its share of segments) finished all it was to write.
      if (this.copy && !this.destroyed) this.endRun(run, n, end, code === 0 && !proc.stoppedByUs);
      if (this.proc !== proc) return;
      this.proc = null;
      if (proc.stoppedByUs || code === 0) return;
      const msg = stderr.trim().split('\n').slice(-3).join(' | ') || `ffmpeg exited with code ${code}`;
      if (this.copy) {
        // Something about the file that copying can't handle: convert it in full from the next start of playback.
        copyFailed.add(this.item.id);
        this.procError = `Couldn't copy the picture: ${msg}`;
        log.warn(`Copying the picture of "${this.item.title}" failed at segment ${n} (${msg}); it will be converted in full from now on`);
        return;
      }
      // A VAAPI driver that turned out not to do bitrate control (missed at start-up, or changed since): stay on the
      // GPU at constant quality rather than dropping to the CPU.
      if (this.encoder === 'h264_vaapi' && cachedCapabilities()?.vaapiRateControl !== 'CQP' && vaapiRateControlFrom(stderr) === 'CQP') {
        log.warn(`VAAPI can't do bitrate control here; converting "${this.item.title}" at constant quality (CQP) instead`);
        noteVaapiConstantQuality();
        const next = this.readyThrough(n) + 1;
        if (next < this.segmentCount) this.start(next);
        return;
      }
      // GPU encoders can fail at runtime (driver trouble, NVIDIA's limit on simultaneous
      // sessions). Retry this session on the CPU instead of stopping playback.
      if (this.encoder !== 'libx264' && !this.forceSoftware) {
        log.warn(`${this.encoder} failed for "${this.item.title}" (${msg}); switching this stream to software encoding`);
        this.forceSoftware = true;
        const next = this.readyThrough(n) + 1;
        if (next < this.segmentCount) this.start(next);
        return;
      }
      this.procError = `Transcoder error: ${msg}`;
      log.error(`ffmpeg failed for "${this.item.title}" at segment ${n}: ${msg}`);
    });
    this.proc = proc;
    this.procStart = n;
    this.procError = null;
  }

  stopProc() {
    const proc = this.proc;
    if (!proc) return;
    proc.stoppedByUs = true;
    this.proc = null;
    if (this.copy) {
      // Keep what the run finished; the segment it was writing is removed once it has stopped (endRun).
      for (let i = this.procStart; i < this.procEnd && fs.existsSync(this.runPath(this.run, i + 1)); i++) {
        this.noteFinished(this.run, i);
      }
    }
    // A half-written "<n>.ts.tmp" may remain; it's ignored and overwritten by the next run.
    try {
      proc.kill('SIGKILL');
    } catch {
      // already gone
    }
  }

  cleanupBehind() {
    const cutoff = this.lastRequested - this.window.keepBehind;
    const far = this.copy ? this.lastRequested + 2 * this.window.aheadMax : Infinity;
    if (cutoff <= 0 && far === Infinity) return;
    for (const n of [...this.produced]) {
      if (n < cutoff || n > far) {
        this.produced.delete(n);
        this.evening.delete(this.segmentPath(n));
        fs.rm(this.segmentPath(n), { force: true }, () => {});
        this.files.delete(n);
      }
    }
  }

  // Called periodically: throttle ffmpeg when far ahead or when the player has gone idle.
  maintain() {
    if (this.destroyed) return;
    const idle = Date.now() - this.lastActive;
    if (idle > SESSION_TTL_MS) {
      this.destroy();
      return;
    }
    if (!this.proc) return;
    if (idle > IDLE_STOP_MS) {
      log.debug(`Pausing idle transcode ${this.id}`);
      this.stopProc();
      return;
    }
    const ready = this.readyThrough(Math.max(this.lastRequested, this.procStart));
    if (ready - this.lastRequested > this.window.aheadMax) this.stopProc();
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
      itemId: this.item.id,
      userId: this.userId,
      running: !!this.proc,
      encoder: this.encoder,
      videoCopy: this.copy,
      reasons: this.decision.reasons,
      quality: this.decision.quality.id,
      lastActive: this.lastActive,
      error: this.procError,
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

export function removeDir(dir, attempt = 0) {
  fs.rm(dir, { recursive: true, force: true }, (err) => {
    // Windows may still hold a handle for a moment after ffmpeg exits.
    if (err && attempt < 5) setTimeout(() => removeDir(dir, attempt + 1), 1000);
  });
}

// ---------- ffmpeg command line ----------

/**
 * The constant quality (QP, lower = better) for a VAAPI driver that can't do bitrate control: roughly what each
 * preset's bitrate gives at its size. Lower presets also scale down, which shrinks them further.
 */
export function vaapiQp(quality) {
  const kbps = quality.bitrate;
  if (!kbps) return 20;
  if (kbps >= 12000) return 21;
  if (kbps >= 8000) return 22;
  if (kbps >= 4000) return 24;
  if (kbps >= 2000) return 26;
  if (kbps >= 1500) return 28;
  return 30;
}

/** The video encoder's arguments. Exported for tests. */
/** The least an original-quality conversion may use: all it gets when the source's bitrate isn't known (live TV). */
export const ORIGINAL_MIN_KBPS = 10000;

export function videoEncoderArgs(encoder, quality, media, caps = cachedCapabilities()) {
  const sourceKbps = (media.bitrate || 0) / 1000;
  const maxrate = quality.bitrate || Math.round(Math.min(Math.max(sourceKbps * 1.2, ORIGINAL_MIN_KBPS), 60000));
  const target = Math.round(maxrate * 0.85);
  const bufsize = maxrate * 2;
  const rate = ['-maxrate', `${maxrate}k`, '-bufsize', `${bufsize}k`];
  switch (encoder) {
    case 'h264_nvenc':
      // No B-frames: with them, ffmpeg 5.x (Debian 12, so the Docker image) shifts NVENC's timestamps by about
      // two minutes under -copyts and leaves the first segment without audio. Chrome copes; Firefox fails with
      // bufferAppendError. The small loss in compression is worth streams that play everywhere.
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', quality.bitrate ? '25' : '21',
        '-b:v', `${target}k`, ...rate, '-profile:v', 'high', '-bf', '0', '-forced-idr', '1'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', `${target}k`, ...rate, '-profile:v', 'high',
        '-forced_idr', '1'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', `${target}k`, ...rate,
        '-profile:v', 'high', '-forced_idr', '1'];
    case 'h264_vaapi':
      // VAAPI turns forced keyframes into IDR frames on its own. Some drivers only do constant quality (e.g. Intel
      // without its HuC firmware): then there's no bitrate cap, so each quality gets a QP instead.
      if (caps?.vaapiRateControl === 'CQP') {
        return ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', String(vaapiQp(quality)), '-profile:v', 'high'];
      }
      return ['-c:v', 'h264_vaapi', '-rc_mode', 'VBR', '-b:v', `${target}k`, ...rate, '-profile:v', 'high'];
    default:
      return ['-c:v', 'libx264', '-preset', getSetting('x264Preset') || 'veryfast', '-crf', quality.bitrate ? '23' : '20',
        ...rate, '-profile:v', 'high'];
  }
}

export function pickEncoder(session) {
  if (session.forceSoftware) return 'libx264';
  const wanted = getSetting('encoder') || 'libx264';
  return cachedCapabilities()?.encoders?.[wanted] === false ? 'libx264' : wanted;
}

/** Arguments before the input that an encoder needs (VAAPI opens its device). */
export const encoderInputArgs = (encoder) => (encoder === 'h264_vaapi'
  ? ['-vaapi_device', getSetting('vaapiDevice') || '/dev/dri/renderD128'] : []);

/** The scale filter for a quality: at most its lines (and 16:9 width), else even dimensions as they are. */
export function scaleFilter(quality) {
  if (!quality.height) return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const w = Math.round((quality.height * 16) / 9);
  return `scale=w='min(iw,${w})':h='min(ih,${quality.height})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

/** The filters ending a video chain for an encoder: its pixel format, uploaded to the GPU for VAAPI. */
export const encoderFormatFilters = (encoder) => (encoder === 'h264_vaapi' ? ['format=nv12', 'hwupload']
  : [`format=${encoder === 'h264_qsv' || encoder === 'h264_amf' ? 'nv12' : 'yuv420p'}`]);

/** ffmpeg arguments for a session starting at a segment. Exported for tests. */
export function buildArgs(session, startSegment) {
  if (session.copy) return buildCopyArgs(session, startSegment);
  const { media, item, decision } = session;
  const { quality, audio, burnSubtitle } = decision;
  const caps = cachedCapabilities();
  const encoder = pickEncoder(session);
  session.encoder = encoder;
  const start = startSegment * SEGMENT_SECONDS;
  const video = media.video;
  const genpts = ['avi', 'mpeg', 'asf', 'flv'].includes(media.container) ? ['-fflags', '+genpts'] : [];

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...encoderInputArgs(encoder)];
  args.push(...genpts);
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', item.file_path);

  // Audio sync: read the audio from a second copy of the input whose timestamps are moved by the
  // offset (positive = later). ffmpeg's accurate seek would trim *shifted* timestamps against the
  // unshifted seek point, so seek loosely (landing at or before start - offset) and cut the shifted
  // audio exactly at the segment start with atrim instead.
  const audioOffset = (decision.audioOffsetMs || 0) / 1000;
  const audioInput = audio && audioOffset ? 1 : 0;
  if (audioInput) {
    const audioStart = Math.max(0, start - audioOffset);
    args.push(...genpts);
    if (audioStart > 0) args.push('-noaccurate_seek', '-ss', audioStart.toFixed(3));
    args.push('-itsoffset', audioOffset.toFixed(3), '-i', item.file_path);
  }

  // Interlaced sources (DVDs, TV recordings) look combed on progressive screens.
  const deinterlace = video.interlaced ? 'yadif=0:-1:1' : null;
  const vf = [scaleFilter(quality)];
  const canTonemap = caps?.filters?.zscale && caps?.filters?.tonemap;
  if (video.hdr && video.hdr !== 'DV' && getSetting('tonemapHdr') && canTonemap) {
    vf.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
    );
  }
  vf.push(...encoderFormatFilters(encoder));

  const source = deinterlace ? `[0:${video.index}]${deinterlace}[base];[base]` : `[0:${video.index}]`;
  let graph;
  if (burnSubtitle != null) {
    // Burned-in subtitle sync: shift the subtitle frames before overlaying them.
    const subOffset = (decision.subtitleOffsetMs || 0) / 1000;
    const subs = subOffset ? `[0:${burnSubtitle}]setpts=PTS${subOffset > 0 ? '+' : '-'}${Math.abs(subOffset).toFixed(3)}/TB[subs];` : '';
    graph = `${subs}${source}${subOffset ? '[subs]' : `[0:${burnSubtitle}]`}overlay=eof_action=pass[sub];[sub]${vf.join(',')}[vout]`;
  } else {
    graph = `${source}${vf.join(',')}[vout]`;
  }
  if (audioInput) graph += `;[1:${audio.index}]atrim=start=${start.toFixed(3)}[aout]`;
  args.push('-filter_complex', graph, '-map', '[vout]');
  if (audio) args.push('-map', audioInput ? '[aout]' : `0:${audio.index}`);

  args.push(...videoEncoderArgs(encoder, quality, media));
  args.push('-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`);
  if (audio) {
    const abr = quality.bitrate && quality.bitrate <= 2000 ? '128k' : '192k';
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', abr);
  }
  args.push(
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-copyts', '-start_at_zero', '-avoid_negative_ts', 'disabled',
    '-max_muxing_queue_size', '2048',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_segment_type', 'mpegts',
    '-hls_list_size', '0',
    '-hls_flags', 'temp_file',
    '-start_number', String(startSegment),
    '-hls_segment_filename', path.join(session.dir, '%d.ts'),
    path.join(session.dir, 'ffmpeg.m3u8'),
  );
  return args;
}

/**
 * ffmpeg arguments for copying the picture from a segment on (decision.videoCopy): the picture as it is, the sound
 * converted to stereo AAC. Every run's timestamps start at 0 (so the cut times count from the run, which every ffmpeg
 * version agrees on) and the MPEG-TS muxer puts them back on the film's timeline, so runs line up with each other.
 * Starting just after the segment's keyframe lands on it: ffmpeg seeks back to the keyframe before the time asked for,
 * and with B-frames looks ~0.13 s further back still. The sound is trimmed to start with that keyframe rather than
 * with the sound frame before it, so every run's timestamps move by the same amount as the first run's (by the
 * picture's B-frame delay or the AAC encoder's), whatever the sound frames' lengths. Cuts are asked for just before
 * each keyframe; the muxer cuts at the first keyframe at or after the time.
 * A run past the first segment starts a segment early, with a lead-in that's never served (the session counts a run's
 * segments from startSegment, and endRun removes the rest): many films (x265's default "open GOP") have frames after a
 * keyframe in the file that show before it, and ffmpeg can't time those when the keyframe is where it starts. It
 * squeezes them all into a tick or two, a hitch in the picture that also leaves the segment's frame times unevened.
 */
export function buildCopyArgs(session, startSegment) {
  const { media, item, decision } = session;
  const { audio } = decision;
  session.encoder = 'copy';
  const from = Math.max(0, startSegment - 1);
  const start = session.segmentStart(from);
  const last = Math.min(session.segmentCount, startSegment + copyLimits.segmentsPerRun);
  session.procEnd = last;
  const cuts = [];
  for (let i = from + 1; i <= Math.min(last, session.segmentCount - 1); i++) {
    cuts.push((session.segmentStart(i) - start - 0.05).toFixed(3));
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (start > 0) args.push('-noaccurate_seek', '-ss', (start + COPY_SEEK_PAST).toFixed(3));
  args.push('-i', item.file_path, '-map', `0:${media.video.index}`);
  if (audio) args.push('-map', `0:${audio.index}`);
  args.push('-c:v', 'copy');
  if (audio) {
    // Timestamps here count from the time asked for, so the keyframe is at -COPY_SEEK_PAST.
    if (start > 0) args.push('-af', `atrim=start=${-COPY_SEEK_PAST}`);
    const abr = decision.quality.bitrate && decision.quality.bitrate <= 2000 ? '128k' : '192k';
    args.push('-c:a', 'aac', '-ac', '2', '-b:a', abr);
  }
  // A run with only a share of the segments goes a little past its last cut (ffmpeg versions measure -t from
  // slightly different points); the piece after the cut is thrown away, and the next run starts at the cut.
  if (last < session.segmentCount) args.push('-t', (session.segmentStart(last) - start + 2).toFixed(3));
  args.push(
    '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-avoid_negative_ts', 'make_zero', '-max_muxing_queue_size', '2048',
    '-f', 'segment', '-segment_format', 'mpegts', '-segment_format_options', `output_ts_offset=${start.toFixed(3)}`,
  );
  // Always a list: without one the muxer would cut every 2 s (a single cut past the end means none).
  args.push('-segment_times', cuts.length ? cuts.join(',') : String(Math.ceil(session.duration - start) + 3600));
  args.push('-segment_start_number', String(from), path.join(session.dir, `${session.run}-%d.ts`));
  return args;
}

// ---------- lifecycle ----------

let timer = null;

export function startTranscodeManager() {
  // Leftovers from a previous run.
  const root = transcodeRoot();
  fs.mkdirSync(root, { recursive: true });
  for (const entry of safeReaddir(root)) removeDir(path.join(root, entry));
  timer = setInterval(() => {
    for (const s of sessions.values()) s.maintain();
  }, 2000);
  timer.unref();
}

export function stopAllSessions() {
  clearInterval(timer);
  for (const s of [...sessions.values()]) s.destroy();
}
