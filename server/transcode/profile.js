// Playback decisions: can the browser play the file as-is ("direct"), or do we transcode to HLS?
import { exactRate } from './even-timestamps.js';

export const QUALITIES = [
  { id: 'original', label: 'Original', height: null, bitrate: null },
  { id: '20m-1080', label: '1080p · 20 Mbps', height: 1080, bitrate: 20000 },
  { id: '12m-1080', label: '1080p · 12 Mbps', height: 1080, bitrate: 12000 },
  { id: '8m-1080', label: '1080p · 8 Mbps', height: 1080, bitrate: 8000 },
  { id: '4m-720', label: '720p · 4 Mbps', height: 720, bitrate: 4000 },
  { id: '2m-720', label: '720p · 2 Mbps', height: 720, bitrate: 2000 },
  { id: '1500k-480', label: '480p · 1.5 Mbps', height: 480, bitrate: 1500 },
  { id: '720k-360', label: '360p · 720 kbps', height: 360, bitrate: 720 },
];

export const qualityById = (id) => QUALITIES.find((q) => q.id === id) || QUALITIES[0];

// Codec "key" as the browser capability probe reports it.
export function videoKey(video) {
  if (!video) return null;
  const codec = video.codec;
  if (codec === 'h264') {
    const p = String(video.profile || '').toLowerCase();
    if (video.bitDepth > 8 || p.includes('high 10') || p.includes('4:2:2') || p.includes('4:4:4')) return 'h264-hi';
    return 'h264';
  }
  if (codec === 'hevc') return video.bitDepth > 8 ? 'hevc10' : 'hevc';
  if (codec === 'av1') return video.bitDepth > 8 ? 'av1-10' : 'av1';
  // MPEG-4 Part 2: phones' decoders only do Simple Profile. XviD/DivX files are Advanced Simple (B-frames,
  // quarter-pixel), which Android plays as sound without a picture, so anything but Simple has its own key.
  if (codec === 'mpeg4') return String(video.profile || '').toLowerCase() === 'simple profile' ? 'mpeg4' : 'mpeg4-asp';
  return codec;
}

// Rough "vertical resolution class" so 1920x800 scope movies count as 1080p.
const resolutionClass = (video) => Math.max(video?.height || 0, Math.round(((video?.width || 0) * 9) / 16));

/**
 * Whether a preset is below the file: less bitrate and no more lines. A preset above it would only convert it
 * upwards (e.g. "720p · 4 Mbps" for a 0.7 Mbps SD file). Unknown file details don't rule a preset out.
 */
export function lowersQuality(media, quality) {
  if (!quality.bitrate) return false;
  const kbps = (media.bitrate || 0) / 1000;
  const lines = resolutionClass(media.video);
  return (!kbps || quality.bitrate < kbps) && (!lines || quality.height <= lines);
}

/** The qualities worth offering for a file: the original, and the presets below it. */
export const qualitiesFor = (media) => QUALITIES.filter((q) => !q.bitrate || lowersQuality(media, q));

export function selectAudio(media, audioIndex) {
  if (!media.audio?.length) return null;
  if (audioIndex != null) {
    const hit = media.audio.find((a) => a.index === Number(audioIndex));
    if (hit) return hit;
  }
  return media.audio.find((a) => a.isDefault) || media.audio[0];
}

/**
 * @param media   ffprobe summary
 * @param caps    { containers: [], video: [], audio: [] } as reported by the client
 * @param opts    { quality, audioIndex, burnSubtitle (stream index of an image subtitle) }
 */
export function decide(media, caps = {}, opts = {}) {
  const reasons = [];
  // A preset that isn't below the file (picked for another one, or the remote default) means the original.
  let quality = qualityById(opts.quality);
  if (quality.bitrate && !lowersQuality(media, quality)) quality = qualityById('original');
  const video = media.video;
  const audio = selectAudio(media, opts.audioIndex);
  const defaultAudio = selectAudio(media, null);
  // A player that plays files itself (the Kodi add-on) always takes the original; nothing is converted for it.
  if (opts.direct) {
    return { mode: 'direct', reasons, quality: qualityById('original'), audio, burnSubtitle: null, audioOffsetMs: 0, subtitleOffsetMs: 0 };
  }

  if (!video) reasons.push('no video stream');
  // AVI is converted even for a client that says it reads AVI (the Android app's Media3): Media3 gives AVI chunks
  // evenly spaced timestamps, but VirtualDub-style files put ~0.5 s of sound in their first chunk, so the sound
  // played about half a second ahead of the picture. (Browsers never claim AVI; Kodi plays files itself.)
  const directContainers = (caps.containers || []).filter((c) => c !== 'avi');
  if (!directContainers.includes(media.container)) reasons.push(`${media.container || 'unknown'} container`);
  const vk = videoKey(video);
  if (video && !(caps.video || []).includes(vk)) {
    const detail = vk === 'mpeg4-asp' ? ` ${video.profile || 'unknown profile'}` : video.bitDepth > 8 ? ` ${video.bitDepth}-bit` : '';
    reasons.push(`${video.codec}${detail} video`);
  }
  if (audio && !(caps.audio || []).includes(audio.codec)) reasons.push(`${audio.codec} audio`);
  if (audio && defaultAudio && audio.index !== defaultAudio.index) reasons.push('alternate audio track');
  const encoded = mkvEncodedPlayed(media, video, audio);
  if (encoded && !caps.mkvContentEncoding && (caps.containers || []).includes(media.container)) {
    reasons.push(`MKV ${encoded.encoding === 'header-stripping' ? 'header compression' : encoded.encoding}`);
  }
  if (quality.bitrate) {
    const kbps = (media.bitrate || 0) / 1000;
    if (kbps > quality.bitrate * 1.1 || resolutionClass(video) > quality.height * 1.1) reasons.push('quality setting');
  }
  let burnSubtitle = null;
  if (opts.burnSubtitle != null) {
    const sub = media.subtitles?.find((s) => s.index === Number(opts.burnSubtitle));
    if (sub) {
      burnSubtitle = sub.index;
      reasons.push('burned-in subtitles');
    }
  }
  // Browsers can't play audio early/late relative to the picture, so an offset needs conversion.
  const audioOffsetMs = audio ? clampOffset(opts.audioOffsetMs, MAX_AUDIO_OFFSET_MS) : 0;
  if (audioOffsetMs) reasons.push('audio sync adjustment');
  const subtitleOffsetMs = burnSubtitle != null ? clampOffset(opts.subtitleOffsetMs, MAX_SUBTITLE_OFFSET_MS) : 0;
  if (opts.forceTranscode) reasons.push('transcode requested');
  // The picture travels as it is when the player can play it and only the sound or the file's container needs
  // changing, e.g. a 4K film with EAC3 sound in Firefox: copied into the segments, it costs next to nothing instead
  // of a 4K re-encode. Needs the player to say it can play copied pictures (caps.copyVideo) and a Matroska file,
  // whose keyframe index the segments are cut by (see transcode/hls.js); interlaced pictures still get deinterlaced.
  const copyable = !!video && !video.interlaced && (caps.copyVideo || []).includes(vk) && ['mkv', 'webm'].includes(media.container);
  // A player that shows each frame at its stamped time (Firefox, caps.stampedFrameTimes) judders playing a Matroska
  // file itself: frames are stamped to the millisecond, 41 or 42 ms apart at 23.976 fps (Firefox also drops some).
  // Copied, their times are evened out (transcode/even-timestamps.js), so such a file is copied rather than played as
  // it is, unless it can't be copied (no keyframe index): then it's still played as it is (directIfNoCopy).
  let directIfNoCopy = false;
  if (!reasons.length && caps.stampedFrameTimes && copyable && millisecondJudder(video.fps)) {
    reasons.push('MKV frame times');
    directIfNoCopy = true;
  }
  const videoCopy = reasons.length > 0 && reasons.every(soundOrContainer) && copyable;
  return {
    mode: reasons.length ? 'hls' : 'direct', reasons, quality, audio, burnSubtitle, audioOffsetMs, subtitleOffsetMs, videoCopy, directIfNoCopy,
  };
}

/** Frames at this rate don't fall on whole milliseconds (23.976, 24, 29.97, 30, 60 fps…; 25 and 50 fps do). */
function millisecondJudder(fps) {
  const rate = fps ? exactRate(fps) : null;
  return !!rate && (1000 * rate[1]) % rate[0] !== 0;
}

/** A reason to convert that's only about the sound or the file around the picture. */
const soundOrContainer = (reason) => reason.endsWith(' container') || reason.endsWith(' audio')
  || reason === 'alternate audio track' || reason.startsWith('MKV ');

/**
 * The first content-encoded Matroska track (e.g. header removal compression from old mkvmerge
 * versions) among the streams that would be played. Only browsers whose MKV reader is built on
 * ffmpeg (Chrome, Edge) decode those; Firefox plays the audio over a black picture.
 */
export function mkvEncodedPlayed(media, video, audio) {
  const played = (t) => (t.type === 'video' && video && (t.index == null || t.index === video.index))
    || (t.type === 'audio' && audio && (t.index == null || t.index === audio.index));
  return (media.mkvEncoded || []).find(played) || null;
}

export const MAX_AUDIO_OFFSET_MS = 10000;
export const MAX_SUBTITLE_OFFSET_MS = 600000;

/** Whole milliseconds within ±max; anything else (missing, NaN) is 0. Positive = later. */
export function clampOffset(value, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-max, Math.min(max, n));
}

export function directContentType(container, filePath) {
  if (container === 'webm') return 'video/webm';
  if (container === 'mkv') return 'video/x-matroska';
  if (container === 'mp4') return 'video/mp4';
  return /\.webm$/i.test(filePath) ? 'video/webm' : 'video/mp4';
}
