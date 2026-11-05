// Matroska track details that ffprobe doesn't report: "content encoding", mostly the header removal
// compression old mkvmerge versions (≈2009–2012) applied by default. ffmpeg (and so Chrome/Edge,
// whose MKV support is built on it) undoes it, but other browsers' MKV readers don't: Firefox plays
// the audio over a black picture. Streams listed here make the server convert instead of direct play.
import fs from 'node:fs/promises';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentEncodingType: 0x5033,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  Cluster: 0x1f43b675,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
};
const TRACK_TYPES = { 1: 'video', 2: 'audio', 17: 'subtitle', 33: 'metadata' };
const HEAD_BYTES = 2 * 1024 * 1024;

/** Variable-length integer at buf[p]: element IDs keep their marker bit, sizes don't. */
function vint(buf, p, keepMarker) {
  const first = buf[p];
  if (first === undefined || first === 0) return null;
  let n = 1;
  while (!(first & (0x80 >> (n - 1)))) n++;
  if (p + n > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> n);
  let allOnes = value === (0xff >> n);
  for (let i = 1; i < n; i++) {
    value = value * 256 + buf[p + i];
    if (buf[p + i] !== 0xff) allOnes = false;
  }
  return { value, length: n, unknown: !keepMarker && allOnes };
}

/** Child elements of buf[start, end): { id, data, dataEnd, end }. Stops at a truncated element. */
function* children(buf, start, end) {
  let p = start;
  while (p < end) {
    const id = vint(buf, p, true);
    if (!id) return;
    const size = vint(buf, p + id.length, false);
    if (!size) return;
    const data = p + id.length + size.length;
    const dataEnd = size.unknown ? end : Math.min(data + size.value, end);
    yield { id: id.value, data, dataEnd, truncated: !size.unknown && data + size.value > end };
    if (size.unknown) return;
    p = data + size.value;
  }
}

const uint = (buf, start, end) => {
  let v = 0;
  for (let i = start; i < end; i++) v = v * 256 + buf[i];
  return v;
};

function parseTracks(buf, start, end) {
  const tracks = [];
  for (const entry of children(buf, start, end)) {
    if (entry.id !== ID.TrackEntry) continue;
    const t = { number: null, type: null, codec: null, encoding: null };
    for (const el of children(buf, entry.data, entry.dataEnd)) {
      if (el.id === ID.TrackNumber) t.number = uint(buf, el.data, el.dataEnd);
      else if (el.id === ID.TrackType) t.type = TRACK_TYPES[uint(buf, el.data, el.dataEnd)] || null;
      else if (el.id === ID.CodecID) t.codec = buf.toString('latin1', el.data, el.dataEnd).replace(/\0+$/, '');
      else if (el.id === ID.ContentEncodings) {
        for (const enc of children(buf, el.data, el.dataEnd)) {
          if (enc.id !== ID.ContentEncoding) continue;
          let type = 0; // 0 = compression (the default), 1 = encryption
          let algo = null;
          for (const c of children(buf, enc.data, enc.dataEnd)) {
            if (c.id === ID.ContentEncodingType) type = uint(buf, c.data, c.dataEnd);
            if (c.id === ID.ContentCompression) {
              algo = 0; // zlib unless stated
              for (const a of children(buf, c.data, c.dataEnd)) if (a.id === ID.ContentCompAlgo) algo = uint(buf, a.data, a.dataEnd);
            }
          }
          t.encoding = type === 1 ? 'encryption' : ({ 0: 'zlib', 1: 'bzlib', 2: 'lzo', 3: 'header-stripping' })[algo] || 'compression';
        }
      }
    }
    tracks.push(t);
  }
  return tracks;
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/** All tracks of a Matroska/WebM file, or null if it can't be parsed. */
export async function matroskaTracks(file) {
  const handle = await fs.open(file, 'r');
  try {
    const head = await readAt(handle, 0, HEAD_BYTES);
    let segment = null;
    for (const el of children(head, 0, head.length)) {
      if (el.id === ID.Segment) {
        segment = el;
        break;
      }
    }
    if (!segment) return null;
    let tracksAt = null;
    for (const el of children(head, segment.data, segment.dataEnd)) {
      if (el.id === ID.Tracks) {
        if (!el.truncated) return parseTracks(head, el.data, el.dataEnd);
        tracksAt = el.data - segment.data; // starts in the head but runs past it: re-read below
        break;
      }
      if (el.id === ID.SeekHead) {
        for (const seek of children(head, el.data, el.dataEnd)) {
          if (seek.id !== ID.Seek) continue;
          let target = null;
          let pos = null;
          for (const s of children(head, seek.data, seek.dataEnd)) {
            if (s.id === ID.SeekID) target = uint(head, s.data, s.dataEnd);
            if (s.id === ID.SeekPosition) pos = uint(head, s.data, s.dataEnd);
          }
          if (target === ID.Tracks && pos != null) tracksAt = pos;
        }
      }
      if (el.id === ID.Cluster) break;
    }
    if (tracksAt == null) return null;
    // Tracks lives further into the file (the SeekHead says where): read it from there.
    const buf = await readAt(handle, segment.data + tracksAt, HEAD_BYTES);
    for (const el of children(buf, 0, buf.length)) {
      if (el.id === ID.Tracks) return parseTracks(buf, el.data, el.dataEnd);
      break;
    }
    return null;
  } finally {
    await handle.close();
  }
}

const MAX_CUES_BYTES = 64 * 1024 * 1024;

/**
 * The video keyframes a Matroska file's index (Cues) lists, in seconds, sorted; null when it has no index or can't be
 * read. Reads only the file's start and its index (a few small reads, even for a 60 GB film on a network share), so
 * conversions that copy the picture can cut it where it can be cut. Cues list the keyframes muxers chose to index:
 * every video keyframe for mkvmerge, at least the start of each cluster otherwise.
 */
export async function matroskaKeyframes(file) {
  const handle = await fs.open(file, 'r');
  try {
    const head = await readAt(handle, 0, HEAD_BYTES);
    let segment = null;
    for (const el of children(head, 0, head.length)) {
      if (el.id === ID.Segment) {
        segment = el;
        break;
      }
    }
    if (!segment) return null;
    let scale = 1000000; // nanoseconds per timestamp unit
    let cuesAt = null;
    let tracks = null;
    for (const el of children(head, segment.data, segment.dataEnd)) {
      if (el.id === ID.Info && !el.truncated) {
        for (const c of children(head, el.data, el.dataEnd)) if (c.id === ID.TimestampScale) scale = uint(head, c.data, c.dataEnd) || scale;
      } else if (el.id === ID.Tracks && !el.truncated) {
        tracks = parseTracks(head, el.data, el.dataEnd);
      } else if (el.id === ID.SeekHead) {
        for (const seek of children(head, el.data, el.dataEnd)) {
          if (seek.id !== ID.Seek) continue;
          let target = null;
          let pos = null;
          for (const s of children(head, seek.data, seek.dataEnd)) {
            if (s.id === ID.SeekID) target = uint(head, s.data, s.dataEnd);
            if (s.id === ID.SeekPosition) pos = uint(head, s.data, s.dataEnd);
          }
          if (target === ID.Cues && pos != null) cuesAt = pos;
        }
      } else if (el.id === ID.Cluster) break;
    }
    if (cuesAt == null) return null;
    tracks ||= await matroskaTracks(file);
    const video = new Set((tracks || []).filter((t) => t.type === 'video').map((t) => t.number));
    // The Cues element's size first, then the element itself.
    const top = await readAt(handle, segment.data + cuesAt, 16);
    const id = vint(top, 0, true);
    const size = id && vint(top, id.length, false);
    if (!id || id.value !== ID.Cues || !size || size.unknown || size.value > MAX_CUES_BYTES) return null;
    const buf = await readAt(handle, segment.data + cuesAt + id.length + size.length, size.value);
    const times = new Set();
    for (const point of children(buf, 0, buf.length)) {
      if (point.id !== ID.CuePoint) continue;
      let time = null;
      let isVideo = video.size === 0; // no track list: trust the cue
      for (const c of children(buf, point.data, point.dataEnd)) {
        if (c.id === ID.CueTime) time = uint(buf, c.data, c.dataEnd);
        if (c.id === ID.CueTrackPositions) {
          for (const p of children(buf, c.data, c.dataEnd)) if (p.id === ID.CueTrack && video.has(uint(buf, p.data, p.dataEnd))) isVideo = true;
        }
      }
      if (time != null && isVideo) times.add((time * scale) / 1e9);
    }
    return times.size ? [...times].sort((a, b) => a - b) : null;
  } finally {
    await handle.close();
  }
}

/**
 * Streams (by ffprobe/ffmpeg stream index) whose Matroska track has a content encoding.
 * `streamTypes` maps the stream indexes ffprobe reported to 'video' | 'audio' | 'subtitle'.
 * ffmpeg numbers Matroska streams in track order, skipping tracks without a codec or of an unknown
 * type; when that can't be matched up, the stream index is null (callers then go by track type).
 */
export async function matroskaEncodedStreams(file, streamTypes) {
  const tracks = await matroskaTracks(file);
  if (!tracks) return null;
  const usable = tracks.filter((t) => t.type && t.codec);
  const mappable = usable.every((t, i) => t.type === 'metadata' || streamTypes.get(i) === undefined || streamTypes.get(i) === t.type);
  return usable
    .map((t, i) => ({ index: mappable ? i : null, type: t.type, codec: t.codec, encoding: t.encoding }))
    .filter((t) => t.encoding);
}
