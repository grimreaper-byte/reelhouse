// Even frame times in MPEG-TS segments. Matroska keeps timestamps in whole milliseconds, so a 23.976 fps film's frames
// are 41 or 42 ms apart instead of 41.708; copied or converted (both keep the file's timestamps), the segments carry
// that on. Browsers show each frame at its stamped time, so on a 60 Hz screen about 40 frames a minute stay up one
// refresh too long or too short: a slight judder. (Players such as VLC and Android's smooth the times out.) A finished
// segment's video frame times are put back on the film's even grid here, in place: only the PES headers' PTS and DTS
// change. A segment whose frames don't all sit within a fraction of a millisecond of such a grid (a variable frame
// rate, or a rate other than the one given) is left as it is.
import fs from 'node:fs/promises';

const PACKET = 188;
const CLOCK = 90000; // MPEG-TS timestamps count 90 kHz ticks
const TOLERANCE = 60; // ticks (0.67 ms): millisecond rounding is off by 45 at most

// Frame rates as exact fractions: 23.976 is 24000/1001.
const RATES = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48000, 1001], [48, 1], [50, 1], [60000, 1001], [60, 1]];

/** A frame rate (as probed: 23.976) as an exact fraction [num, den], or null for one that isn't a common rate. */
export function exactRate(fps) {
  return RATES.find(([n, d]) => Math.abs(n / d - fps) < 0.002) || null;
}

/** The 33-bit timestamp in 5 PES header bytes at [at]. */
function readTs(buf, at) {
  return ((buf[at] >> 1) & 0x07) * 2 ** 30 + buf[at + 1] * 2 ** 22 + (buf[at + 2] >> 1) * 2 ** 15 + buf[at + 3] * 2 ** 7 + (buf[at + 4] >> 1);
}

/** Writes a timestamp back, keeping the field's 4-bit prefix and marker bits. */
function writeTs(buf, at, ts) {
  buf[at] = (buf[at] & 0xf0) | ((Math.floor(ts / 2 ** 30) & 0x07) << 1) | 1;
  buf[at + 1] = Math.floor(ts / 2 ** 22) & 0xff;
  buf[at + 2] = ((Math.floor(ts / 2 ** 15) & 0x7f) << 1) | 1;
  buf[at + 3] = Math.floor(ts / 2 ** 7) & 0xff;
  buf[at + 4] = ((ts & 0x7f) << 1) | 1;
}

/** Where each video PES header's PTS (and DTS) are: [{ pts, ptsAt, dts?, dtsAt? }]. */
function videoHeaders(buf) {
  const found = [];
  for (let p = 0; p + PACKET <= buf.length; p += PACKET) {
    if (buf[p] !== 0x47 || !(buf[p + 1] & 0x40)) continue; // not the start of a PES
    const control = (buf[p + 3] >> 4) & 0x03;
    if (!(control & 0x01)) continue; // no payload
    const start = p + 4 + (control & 0x02 ? 1 + buf[p + 4] : 0);
    const h = start;
    if (h + 19 > p + PACKET || buf[h] !== 0 || buf[h + 1] !== 0 || buf[h + 2] !== 1) continue;
    if ((buf[h + 3] & 0xf0) !== 0xe0) continue; // video streams are 0xE0–0xEF
    const flags = buf[h + 7] >> 6;
    if (flags < 2) continue;
    const entry = { pts: readTs(buf, h + 9), ptsAt: h + 9 };
    if (flags === 3) Object.assign(entry, { dts: readTs(buf, h + 14), dtsAt: h + 14 });
    found.push(entry);
  }
  return found;
}

/**
 * Puts a segment's video frame times on an even grid for [rate] ([num, den], see exactRate), in [buf]. Returns the
 * byte ranges changed ([start, end) pairs), none when the times were already even or don't fit one grid.
 */
export function evenVideoTimestamps(buf, rate) {
  const [num, den] = rate;
  const period = (CLOCK * den) / num; // 3753.75 ticks at 23.976 fps
  const headers = videoHeaders(buf);
  if (headers.length < 3) return [];
  // Where the grid lies: the average of the frames' places within a frame period (as an angle, so a place just
  // below the period and one just above zero count as near each other).
  let x = 0;
  let y = 0;
  for (const { pts } of headers) {
    const angle = (2 * Math.PI * (pts % period)) / period;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  const phase = (((Math.atan2(y, x) / (2 * Math.PI)) * period) % period + period) % period;
  const snap = (ts) => Math.round(phase + Math.round((ts - phase) / period) * period);

  // The frames' display times have to fit the grid. Decode times only have to keep their order and stay at or before
  // their frame's display time: ffmpeg makes up the first frames' own, not always on the grid.
  const changes = [];
  let off = 0;
  let lastDts = -Infinity;
  for (const h of headers) {
    const pts = snap(h.pts);
    const dts = h.dts == null ? null : snap(h.dts);
    if (Math.abs(pts - h.pts) > TOLERANCE) return []; // not one even grid
    off = Math.max(off, Math.abs(pts - h.pts), dts == null ? 0 : Math.abs(dts - h.dts));
    const decode = dts ?? pts;
    if ((dts != null && dts > pts) || decode <= lastDts) return [];
    lastDts = decode;
    changes.push([h, pts, dts]);
  }
  if (off <= 1) return []; // already even
  const ranges = [];
  for (const [h, pts, dts] of changes) {
    if (pts !== h.pts) {
      writeTs(buf, h.ptsAt, pts);
      ranges.push([h.ptsAt, h.ptsAt + 5]);
    }
    if (dts != null && dts !== h.dts) {
      writeTs(buf, h.dtsAt, dts);
      ranges.push([h.dtsAt, h.dtsAt + 5]);
    }
  }
  return ranges;
}

/** Evens out a segment file's video frame times in place (see evenVideoTimestamps); how many timestamps changed. */
export async function evenSegmentFile(file, rate) {
  const buf = await fs.readFile(file);
  const ranges = evenVideoTimestamps(buf, rate);
  if (!ranges.length) return 0;
  const handle = await fs.open(file, 'r+');
  try {
    for (const [start, end] of ranges) await handle.write(buf, start, end - start, start);
  } finally {
    await handle.close();
  }
  return ranges.length;
}
