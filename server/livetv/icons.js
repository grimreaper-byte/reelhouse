// Channel logos from Tvheadend, kept on disk (cache/channel-icons/<channel uuid>.<png|jpeg|gif|webp|svg>, with a
// .json note of where it came from), so the guide and the player show them at once and still have them while
// Tvheadend is busy or down. Fetched in the background when the channel list loads; fetched again after a week, or
// when Tvheadend's address for a logo changes. A channel without a logo isn't asked about again for a few hours.
// SVG logos are drawn as PNGs by ffmpeg where it can (its librsvg decoder: Debian's, so the Docker image's), since the
// Android app and Kodi can't show SVG; elsewhere they're kept as SVG, which browsers show.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/paths.js';
import { ffmpegBin, runProcess } from '../media/ffmpeg.js';
import { ICON_TYPES } from './tvheadend.js';

const FRESH_MS = 7 * 24 * 3600 * 1000;
const MISSING_MS = 6 * 3600 * 1000;
const AT_ONCE = 3;
const PNG_WIDTH = 512; // an SVG logo's drawn width: sharp at the largest a logo shows (the app's radio screen)

const missing = new Map(); // channel uuid → when it last had no logo
const inFlight = new Map(); // channel uuid → promise
const undrawable = new Set(); // SVG logos ffmpeg couldn't draw ("<uuid> <source>"), kept as SVG

let svgDrawing = null;
/** Whether this ffmpeg can draw SVG pictures (asked once). */
export function canDrawSvg() {
  svgDrawing ??= runProcess(ffmpegBin(), ['-hide_banner', '-decoders'], { timeoutMs: 15000 })
    .then((r) => /\slibrsvg\s/.test(r.stdout))
    .catch(() => false);
  return svgDrawing;
}

/** Draws an SVG file as a PNG [PNG_WIDTH] wide (its shape kept, transparency too); whether it worked. */
async function drawSvg(svgFile, pngFile) {
  if (!(await canDrawSvg())) return false;
  const r = await runProcess(ffmpegBin(), [
    '-v', 'error', '-y', '-width', String(PNG_WIDTH), '-keep_ar', '1', '-i', svgFile,
    '-frames:v', '1', '-c:v', 'png', '-f', 'image2', pngFile,
  ], { timeoutMs: 20000 }).catch(() => null);
  return r?.code === 0 && (fs.statSync(pngFile, { throwIfNoEntry: false })?.size ?? 0) > 0;
}

export const iconDir = () => path.join(DATA_DIR, 'cache', 'channel-icons');

const safeUuid = (uuid) => (/^[0-9a-f]{32}$/i.test(uuid) ? uuid.toLowerCase() : null);
const sourceOf = (channel) => [channel.icon, channel.iconSource].filter(Boolean).join(' | ');

/** The logo kept for a channel: { file, type, kind, at, source } or null. */
export function cachedIcon(uuid) {
  const id = safeUuid(uuid);
  if (!id) return null;
  try {
    const note = JSON.parse(fs.readFileSync(path.join(iconDir(), `${id}.json`), 'utf8'));
    const file = path.join(iconDir(), `${id}.${note.kind}`);
    if (!ICON_TYPES[note.kind] || !fs.existsSync(file)) return null;
    return { file, type: ICON_TYPES[note.kind], kind: note.kind, at: note.at, source: note.source };
  } catch {
    return null;
  }
}

/** When the kept logo was fetched (for its address, so browsers take a new one), or null. */
export const iconVersion = (uuid) => cachedIcon(uuid)?.at ?? null;

/**
 * The logo for a channel, fetched from Tvheadend (`tvh`) when there's none kept, it's a week old, or its address
 * changed; a kept one is used when Tvheadend can't give one. Resolves to cachedIcon()'s shape or null.
 */
export function channelIcon(tvh, channel, { force = false } = {}) {
  const id = safeUuid(channel?.uuid);
  if (!id) return Promise.resolve(null);
  const kept = cachedIcon(id);
  const source = sourceOf(channel);
  if (!force && kept && kept.source === source && Date.now() - kept.at < FRESH_MS) {
    // Kept as SVG before ffmpeg drew them (or by a server whose ffmpeg can't): drawn now if it can.
    return kept.kind === 'svg' && !undrawable.has(`${id} ${source}`) ? redrawn(id, kept) : Promise.resolve(kept);
  }
  if (!source) return Promise.resolve(kept);
  if (!force && !kept && Date.now() - (missing.get(id) || 0) < MISSING_MS) return Promise.resolve(null);
  if (inFlight.has(id)) return inFlight.get(id);
  const job = (async () => {
    const got = await tvh.icon(channel.icon, channel.iconSource).catch(() => null);
    if (!got) {
      if (!kept) missing.set(id, Date.now());
      return kept;
    }
    missing.delete(id);
    return save(id, got, source);
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}

/** A kept SVG logo drawn as a PNG, when ffmpeg can (else the SVG as it is). */
function redrawn(id, kept) {
  if (inFlight.has(id)) return inFlight.get(id);
  const job = (async () => ((await canDrawSvg()) ? save(id, { kind: 'svg', body: fs.readFileSync(kept.file) }, kept.source) : kept))()
    .catch(() => kept)
    .finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}

async function save(id, { kind, body }, source) {
  const dir = iconDir();
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${id}.${kind}`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  if (kind === 'svg') {
    const png = path.join(dir, `${id}.png.${process.pid}.tmp`);
    if (await drawSvg(file, png)) {
      kind = 'png';
      file = path.join(dir, `${id}.png`);
      fs.renameSync(png, file);
    } else {
      fs.rmSync(png, { force: true });
      undrawable.add(`${id} ${source}`);
    }
  }
  // A logo that changed kind (png → svg) leaves no stale copy behind; nor does an SVG once drawn.
  for (const other of Object.keys(ICON_TYPES)) {
    if (other !== kind) fs.rmSync(path.join(dir, `${id}.${other}`), { force: true });
  }
  const at = Date.now();
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ kind, at, source }));
  return { file, type: ICON_TYPES[kind], kind, at, source };
}

/** Deletes every logo kept and forgets which channels had none (Settings → Live TV); resolves to how many there were. */
export async function clearIcons() {
  await Promise.allSettled(inFlight.values());
  missing.clear();
  undrawable.clear();
  const dir = iconDir();
  let count = 0;
  try {
    count = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
  } catch {
    // none kept yet
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  return count;
}

/** Fetches the logos not kept yet (or due again) in the background, a few at a time. */
export async function prefetchIcons(tvh, channels) {
  const queue = channels.filter((c) => {
    const kept = cachedIcon(c.uuid);
    return sourceOf(c) && !(kept && kept.source === sourceOf(c) && Date.now() - kept.at < FRESH_MS);
  });
  const worker = async () => {
    while (queue.length) await channelIcon(tvh, queue.shift()).catch(() => null);
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
}
