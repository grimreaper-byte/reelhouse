// Image resolution + caching: local artwork (resized), TMDB images (downloaded once), and
// frame grabs from the video itself when nothing else exists.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { get } from '../db.js';
import { dirs } from '../lib/paths.js';
import { createLimiter, createOnce } from '../lib/limit.js';
import { ffmpegBin, runProcess } from './ffmpeg.js';
import { logger } from '../lib/log.js';

const log = logger('images');
const ffmpegLimit = createLimiter(2);
const once = createOnce();

const exists = (p) => fs.access(p).then(() => true, () => false);

const TMDB_SIZES = {
  poster: [92, 154, 185, 342, 500, 780],
  backdrop: [300, 780, 1280],
  thumb: [92, 185, 300],
  profile: [45, 185],
};

function tmdbSize(kind, width) {
  // Cast photos come in w45, w185 and h632 (≈421 px wide): the tall one keeps big cards sharp.
  if (kind === 'profile' && width > 185) return 'h632';
  const sizes = TMDB_SIZES[kind] || TMDB_SIZES.poster;
  if (!width) return kind === 'backdrop' ? 'w1280' : `w${sizes[sizes.length - 1]}`;
  const hit = sizes.find((s) => s >= width);
  return hit ? `w${hit}` : kind === 'backdrop' ? 'original' : `w${sizes[sizes.length - 1]}`;
}

async function fetchTmdb(kind, tmdbPath, width) {
  const size = tmdbSize(kind, width);
  const clean = tmdbPath.replace(/^\/+/, '').replace(/[^\w.\-]/g, '_');
  const dest = path.join(dirs.images, 'tmdb', size, clean);
  if (await exists(dest)) return dest;
  return once(dest, async () => {
    const res = await fetch(`https://image.tmdb.org/t/p/${size}/${clean}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`TMDB image ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(`${dest}.tmp`, buf);
    await fs.rename(`${dest}.tmp`, dest);
    return dest;
  });
}

async function resizeLocal(file, width) {
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return null;
  }
  // Small files don't need resizing.
  if (!width || st.size < 150 * 1024) return file;
  const key = crypto.createHash('sha1').update(`${file}|${st.mtimeMs}|${width}`).digest('hex');
  const dest = path.join(dirs.images, 'local', `${key}.jpg`);
  if (await exists(dest)) return dest;
  return once(dest, () => ffmpegLimit(async () => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const { code } = await runProcess(
      ffmpegBin(),
      ['-v', 'error', '-y', '-i', file, '-vf', `scale='min(${width},iw)':-2`, '-q:v', '3', '-frames:v', '1', dest],
      { timeoutMs: 30000 },
    );
    return code === 0 && (await exists(dest)) ? dest : file;
  }));
}

async function frameGrab(item, width) {
  if (!item.file_path || !fsSync.existsSync(item.file_path)) return null;
  const dest = path.join(dirs.images, 'frames', `${item.id}-${item.file_mtime || 0}.jpg`);
  if (await exists(dest)) return dest;
  return once(dest, () => ffmpegLimit(async () => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const duration = item.duration || 0;
    const at = duration ? Math.min(Math.max(duration * 0.15, 5), 600) : 5;
    const { code, stderr } = await runProcess(
      ffmpegBin(),
      ['-v', 'error', '-y', '-ss', String(at), '-i', item.file_path, '-map', '0:v:0', '-frames:v', '1',
        '-vf', `scale='min(${Math.max(width || 0, 640)},iw)':-2`, '-q:v', '4', dest],
      { timeoutMs: 60000 },
    );
    if (code !== 0) {
      log.debug(`Frame grab failed for ${item.file_path}: ${stderr}`);
      return null;
    }
    return dest;
  }));
}

function chain(item, kind) {
  const show = item.show_id ? get('SELECT poster, backdrop FROM items WHERE id = ?', item.show_id) : null;
  const season = item.type === 'episode' && item.parent_id ? get('SELECT poster FROM items WHERE id = ?', item.parent_id) : null;
  if (kind === 'poster') return [item.poster, season?.poster, show?.poster];
  if (kind === 'backdrop') return [item.backdrop, show?.backdrop];
  if (kind === 'thumb') return [item.thumb];
  return [];
}

/**
 * Returns an absolute path to an image file for the item, or null.
 * kind: poster | backdrop | thumb
 */
export async function resolveItemImage(item, kind, width) {
  for (const ref of chain(item, kind)) {
    if (!ref) continue;
    try {
      if (ref.startsWith('file:')) {
        const p = await resizeLocal(ref.slice(5), width);
        if (p) return p;
      } else if (ref.startsWith('tmdb:')) {
        return await fetchTmdb(kind === 'thumb' && item.type !== 'episode' ? 'backdrop' : kind, ref.slice(5), width);
      }
    } catch (err) {
      log.debug(`Image ${ref} failed: ${err.message}`);
    }
  }
  if (item.type === 'episode' || item.type === 'movie') {
    return kind === 'backdrop' ? null : frameGrab(item, width);
  }
  // No artwork for a show/season: use a frame from its first episode.
  if (kind === 'poster') {
    const col = item.type === 'show' ? 'show_id' : 'parent_id';
    const ep = get(
      `SELECT * FROM items WHERE type = 'episode' AND ${col} = ? ORDER BY season_number = 0, season_number, episode_number LIMIT 1`,
      item.id,
    );
    if (ep) return resolveItemImage(ep, 'thumb', width);
  }
  return null;
}

/** A local image file, resized for `width` (used for artwork previews). */
export async function resolveLocalImage(file, width) {
  return resizeLocal(file, width);
}

/** Proxies cast/profile images (tmdb paths) through the server cache. */
export async function resolveTmdbImage(kind, tmdbPath, width) {
  return fetchTmdb(kind, tmdbPath, width);
}
