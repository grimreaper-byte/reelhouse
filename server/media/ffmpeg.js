import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from '../settings.js';
import { logger } from '../lib/log.js';
import { gpuDiagnostics } from './gpu.js';
import { matroskaEncodedStreams } from './matroska.js';

const log = logger('ffmpeg');

export const ffmpegBin = () => getSetting('ffmpegPath') || 'ffmpeg';
export const ffprobeBin = () => getSetting('ffprobePath') || 'ffprobe';

/** Runs a binary to completion. Resolves { code, stdout, stderr } (stdout as Buffer when binary=true). */
export function runProcess(bin, args, { timeoutMs = 120000, binary = false, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    let outLen = 0;
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${path.basename(bin)} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen <= maxBuffer) out.push(d);
    });
    proc.stderr.on('data', (d) => {
      if (err.length < 20000) err += d.toString();
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`${bin} not found. Install ffmpeg or set its path in Settings.`) : e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      resolve({ code, stdout: binary ? buf : buf.toString(), stderr: err });
    });
  });
}

// ---------- probing ----------

const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'subviewer1', 'sami', 'realtext', 'stl', 'jacosub', 'mpl2', 'vplayer', 'pjs']);
const IMAGE_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'dvbsub', 'xsub']);

function containerFrom(formatName = '', file = '') {
  const ext = path.extname(file).toLowerCase();
  if (formatName.includes('mp4') || formatName.includes('mov')) return 'mp4';
  if (formatName.includes('matroska') || formatName.includes('webm')) return ext === '.webm' ? 'webm' : 'mkv';
  if (formatName.includes('mpegts')) return 'ts';
  if (formatName.includes('avi')) return 'avi';
  if (formatName.includes('asf')) return 'asf';
  if (formatName.includes('flv')) return 'flv';
  if (formatName.includes('ogg')) return 'ogg';
  if (formatName.includes('mpeg')) return 'mpeg';
  return ext.replace('.', '') || formatName.split(',')[0];
}

function bitDepthOf(stream) {
  const m = String(stream.pix_fmt || '').match(/p(\d{2})/);
  if (m) return Number(m[1]);
  if (stream.bits_per_raw_sample) return Number(stream.bits_per_raw_sample);
  return 8;
}

function fpsOf(stream) {
  const [n, d] = String(stream.avg_frame_rate || stream.r_frame_rate || '0/1').split('/').map(Number);
  return d ? Math.round((n / d) * 1000) / 1000 : null;
}

const lang = (s) => {
  const l = s.tags?.language;
  return l && l !== 'und' ? l : null;
};

export function summarizeProbe(json, file) {
  const fmt = json.format || {};
  const streams = json.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const summary = {
    duration: Number(fmt.duration) || Number(videoStream?.duration) || null,
    bitrate: Number(fmt.bit_rate) || null,
    formatName: fmt.format_name || '',
    container: containerFrom(fmt.format_name, file),
    video: null,
    audio: [],
    subtitles: [],
    chapters: (json.chapters || []).map((c) => ({
      start: Number(c.start_time),
      end: Number(c.end_time),
      title: c.tags?.title || null,
    })),
  };
  if (videoStream) {
    const transfer = videoStream.color_transfer || '';
    const dovi = (videoStream.side_data_list || []).some((d) => /dovi|dolby vision/i.test(d.side_data_type || ''));
    summary.video = {
      index: videoStream.index,
      codec: videoStream.codec_name,
      profile: videoStream.profile || null,
      level: videoStream.level ?? null,
      width: videoStream.width,
      height: videoStream.height,
      pixFmt: videoStream.pix_fmt || null,
      bitDepth: bitDepthOf(videoStream),
      fps: fpsOf(videoStream),
      interlaced: ['tt', 'bb', 'tb', 'bt'].includes(videoStream.field_order),
      colorTransfer: transfer || null,
      colorPrimaries: videoStream.color_primaries || null,
      hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67' ? (transfer === 'smpte2084' ? 'HDR10' : 'HLG') : dovi ? 'DV' : null,
      bitrate: Number(videoStream.bit_rate) || null,
    };
  }
  for (const s of streams) {
    if (s.codec_type === 'audio') {
      summary.audio.push({
        index: s.index,
        codec: s.codec_name,
        profile: s.profile || null,
        channels: s.channels || 2,
        layout: s.channel_layout || null,
        language: lang(s),
        title: s.tags?.title || null,
        isDefault: !!s.disposition?.default,
        bitrate: Number(s.bit_rate) || null,
      });
    } else if (s.codec_type === 'subtitle') {
      const text = TEXT_SUB_CODECS.has(s.codec_name);
      summary.subtitles.push({
        index: s.index,
        codec: s.codec_name,
        language: lang(s),
        title: s.tags?.title || null,
        isDefault: !!s.disposition?.default,
        forced: !!s.disposition?.forced,
        text,
        image: IMAGE_SUB_CODECS.has(s.codec_name),
      });
    }
  }
  return summary;
}

export async function probe(file) {
  const { code, stdout, stderr } = await runProcess(
    ffprobeBin(),
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_chapters', file],
    { timeoutMs: 90000 },
  );
  if (code !== 0) throw new Error(`ffprobe failed: ${stderr.trim().split('\n').pop() || `exit ${code}`}`);
  const json = JSON.parse(stdout);
  const summary = summarizeProbe(json, file);
  if (summary.container === 'mkv' || summary.container === 'webm') {
    summary.mkvEncoded = await mkvEncodedFor(file, (json.streams || []).map((s) => [s.index, s.codec_type]));
  }
  return summary;
}

/**
 * Matroska streams with a content encoding (see matroska.js): [] when there are none, null when the
 * file couldn't be checked. `streams` is [[index, codecType], ...].
 */
export async function mkvEncodedFor(file, streams) {
  try {
    return await matroskaEncodedStreams(file, new Map(streams));
  } catch (err) {
    log.warn(`Could not read Matroska tracks of ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

// ---------- capabilities ----------

export const HW_ENCODERS = [
  { id: 'libx264', label: 'Software (libx264) — works everywhere, uses CPU' },
  { id: 'h264_nvenc', label: 'NVIDIA NVENC' },
  { id: 'h264_qsv', label: 'Intel Quick Sync' },
  { id: 'h264_amf', label: 'AMD AMF (Windows)' },
  { id: 'h264_vaapi', label: 'VAAPI — Intel/AMD on Linux' },
];

let caps = null;

export async function detectCapabilities(force = false) {
  if (caps && !force) return caps;
  const result = { ffmpeg: null, ffprobe: null, filters: {}, encoders: {}, encoderErrors: {}, gpu: null, error: null };
  try {
    const v = await runProcess(ffmpegBin(), ['-hide_banner', '-version'], { timeoutMs: 15000 });
    result.ffmpeg = v.stdout.split('\n')[0].trim();
    const p = await runProcess(ffprobeBin(), ['-hide_banner', '-version'], { timeoutMs: 15000 });
    result.ffprobe = p.stdout.split('\n')[0].trim();
    const f = await runProcess(ffmpegBin(), ['-hide_banner', '-filters'], { timeoutMs: 15000 });
    for (const name of ['zscale', 'tonemap', 'tonemap_opencl', 'overlay', 'subtitles']) {
      result.filters[name] = new RegExp(`\\s${name}\\s`).test(f.stdout);
    }
    for (const enc of HW_ENCODERS) {
      const { ok, error } = await testEncoder(enc.id);
      result.encoders[enc.id] = ok;
      if (error) result.encoderErrors[enc.id] = error;
    }
    // The plain test lets the driver choose its rate control; conversions ask for VBR, which some drivers can't do.
    if (result.encoders.h264_vaapi) {
      const { ok, error } = await testEncoder('h264_vaapi', ['-rc_mode', 'VBR', '-b:v', '2000k', '-maxrate', '2000k', '-bufsize', '4000k']);
      result.vaapiRateControl = ok ? 'VBR' : vaapiRateControlFrom(error) || 'VBR';
      if (!ok) log.info(`VAAPI can't do bitrate control here (${error}); converting at constant quality (CQP)`);
    }
  } catch (err) {
    result.error = err.message;
    log.error('ffmpeg capability detection failed:', err.message);
  }
  try {
    result.gpu = await gpuDiagnostics(result);
  } catch (err) {
    log.warn('GPU diagnostics failed:', err.message);
  }
  caps = result;
  return caps;
}

export function cachedCapabilities() {
  return caps;
}

/**
 * The rate control to use for VAAPI, from ffmpeg's complaint about VBR: some drivers only do constant quality, e.g.
 * "Driver does not support VBR RC mode (supported modes: CQP)" (Intel without its HuC firmware loaded). Null when
 * the error says nothing about it.
 */
export function vaapiRateControlFrom(error) {
  const m = /does not support \w+ RC mode \(supported modes: ([^)]*)\)/i.exec(error || '');
  if (!m) return null;
  const modes = m[1].split(/[\s,|]+/).filter(Boolean).map((s) => s.toUpperCase());
  return modes.includes('VBR') ? 'VBR' : modes.includes('CQP') ? 'CQP' : null;
}

/** A conversion found out at run time that VAAPI can only do constant quality: use that from now on. */
export function noteVaapiConstantQuality() {
  if (caps) caps.vaapiRateControl = 'CQP';
}

// The most useful line of ffmpeg's error output (the last ones are usually generic).
function summarizeError(stderr) {
  const lines = stderr.split('\n').map((l) => l.replace(/^\[[^\]]+\]\s*/, '').trim()).filter(Boolean);
  const useful = lines.find((l) => !/^(Error (while|initializing|opening)|Conversion failed|Could not open encoder)/i.test(l));
  return (useful || lines[0] || '').slice(0, 200) || null;
}

/** Encodes half a second of black video with the encoder (and [extra] options). Resolves { ok, error }. */
async function testEncoder(id, extra = []) {
  let pre = [];
  let vf = id === 'h264_qsv' || id === 'h264_amf' ? 'format=nv12' : 'format=yuv420p';
  if (id === 'h264_vaapi') {
    const device = getSetting('vaapiDevice') || '/dev/dri/renderD128';
    if (process.platform !== 'linux') return { ok: false, error: null };
    if (!fs.existsSync(device)) return { ok: false, error: `${device} not found` };
    pre = ['-vaapi_device', device];
    vf = 'format=nv12,hwupload';
  }
  try {
    const { code, stderr } = await runProcess(
      ffmpegBin(),
      ['-hide_banner', '-loglevel', 'error', ...pre, '-f', 'lavfi', '-i', 'color=black:s=640x360:r=24:d=0.5',
        '-vf', vf, '-c:v', id, ...extra, '-f', 'null', '-'],
      { timeoutMs: 30000 },
    );
    return code === 0 ? { ok: true, error: null } : { ok: false, error: summarizeError(stderr) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
