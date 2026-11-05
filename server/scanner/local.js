// Local metadata: artwork files, Kodi-style .nfo files and sidecar subtitles next to the media.
import fs from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_EXTENSIONS, SUBTITLE_EXTENSIONS, parseSubtitleName } from './parse.js';

/** Caches directory listings for the duration of a scan. */
export class DirCache {
  constructor() {
    this.map = new Map();
  }
  async list(dir) {
    if (!this.map.has(dir)) {
      this.map.set(
        dir,
        fs.readdir(dir, { withFileTypes: true }).then(
          (entries) => entries,
          () => [],
        ),
      );
    }
    return this.map.get(dir);
  }
  async files(dir) {
    return (await this.list(dir)).filter((e) => e.isFile()).map((e) => e.name);
  }
}

async function findImage(cache, dir, baseNames) {
  const files = await cache.files(dir);
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  for (const base of baseNames) {
    for (const ext of IMAGE_EXTENSIONS) {
      const hit = lower.get(`${base.toLowerCase()}${ext}`);
      if (hit) return `file:${path.join(dir, hit)}`;
    }
  }
  return null;
}

/** Artwork for a movie file. `dedicatedFolder` is true when the movie sits in its own folder. */
export async function movieArtwork(cache, file, dedicatedFolder) {
  const dir = path.dirname(file);
  const base = path.parse(file).name;
  const posterNames = [`${base}-poster`, `${base}`];
  const fanartNames = [`${base}-fanart`, `${base}-backdrop`];
  if (dedicatedFolder) {
    posterNames.push('poster', 'folder', 'cover', 'movie', 'default');
    fanartNames.push('fanart', 'backdrop', 'background', 'art');
  }
  return {
    poster: await findImage(cache, dir, posterNames),
    backdrop: await findImage(cache, dir, fanartNames),
  };
}

export async function showArtwork(cache, showDir) {
  return {
    poster: await findImage(cache, showDir, ['poster', 'folder', 'cover', 'show', 'default']),
    backdrop: await findImage(cache, showDir, ['fanart', 'backdrop', 'background', 'art']),
  };
}

export async function seasonArtwork(cache, showDir, seasonDir, seasonNumber) {
  const n = String(seasonNumber).padStart(2, '0');
  const names = seasonNumber === 0
    ? ['season-specials-poster', 'season00-poster', 'season00', 'specials']
    : [`season${n}-poster`, `season${n}`, `season${seasonNumber}-poster`, `season${seasonNumber}`, `season ${seasonNumber}`];
  let poster = showDir ? await findImage(cache, showDir, names) : null;
  if (!poster && seasonDir && seasonDir !== showDir) {
    poster = await findImage(cache, seasonDir, ['poster', 'folder', 'cover']);
  }
  return { poster };
}

export async function episodeThumb(cache, file) {
  const base = path.parse(file).name;
  return findImage(cache, path.dirname(file), [`${base}-thumb`, base]);
}

/** Sidecar subtitles: "<video>.srt", "<video>.en.forced.srt", and files inside "Subs/". */
export async function sidecarSubtitles(cache, file) {
  const dir = path.dirname(file);
  const base = path.parse(file).name;
  const results = [];
  const consider = (subDir, name, matchBase) => {
    const ext = path.extname(name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(ext) || ext === '.sub' || ext === '.smi') return;
    const stem = path.parse(name).name.toLowerCase();
    if (matchBase && !(stem === base.toLowerCase() || stem.startsWith(`${base.toLowerCase()}.`))) return;
    const info = parseSubtitleName(name, base);
    results.push({ path: path.join(subDir, name), format: ext.slice(1), ...info });
  };
  for (const name of await cache.files(dir)) consider(dir, name, true);
  const subDirEntry = (await cache.list(dir)).find((e) => e.isDirectory() && /^subs?$|^subtitles$/i.test(e.name));
  if (subDirEntry) {
    const subDir = path.join(dir, subDirEntry.name);
    const files = await cache.files(subDir);
    // Subs/<video>/*.srt layout (common in release packs) or Subs/<video>.*.srt
    const nested = (await cache.list(subDir)).find((e) => e.isDirectory() && e.name.toLowerCase() === base.toLowerCase());
    if (nested) {
      const nestedDir = path.join(subDir, nested.name);
      for (const name of await cache.files(nestedDir)) consider(nestedDir, name, false);
    }
    for (const name of files) consider(subDir, name, files.length > 3);
  }
  return results;
}

// ---------- NFO ----------

const decodeEntities = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();

function tagValues(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const v = decodeEntities(m[1]);
    if (v) out.push(v);
  }
  return out;
}

const tagValue = (xml, tag) => tagValues(xml, tag)[0] || null;

// tinyMediaManager, Kodi and Jellyfin write TMDB image URLs as actor thumbs; use them as cast photos.
function actorPhoto(url) {
  const m = /^https?:\/\/image\.tmdb\.org\/t\/p\/[^/]+(\/[\w-]+\.(?:jpe?g|png|webp))$/i.exec(url || '');
  return m ? `tmdb:${m[1]}` : null;
}

export function parseNfo(xml) {
  const out = {};
  const urlTmdb = xml.match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/);
  const urlImdb = xml.match(/\b(tt\d{6,9})\b/);
  if (!/<(movie|tvshow|episodedetails)[\s>]/i.test(xml)) {
    if (urlTmdb) out.tmdbId = Number(urlTmdb[1]);
    if (urlImdb) out.imdbId = urlImdb[1];
    return out;
  }
  out.title = tagValue(xml, 'title');
  out.originalTitle = tagValue(xml, 'originaltitle');
  out.sortTitle = tagValue(xml, 'sorttitle');
  const year = Number(tagValue(xml, 'year'));
  if (year) out.year = year;
  out.overview = tagValue(xml, 'plot') || tagValue(xml, 'outline');
  out.tagline = tagValue(xml, 'tagline');
  const rating = Number(tagValue(xml, 'rating') || tagValue(xml, 'value'));
  if (rating) out.rating = rating;
  out.contentRating = tagValue(xml, 'mpaa');
  const genres = tagValues(xml, 'genre');
  if (genres.length) out.genres = genres;
  out.studio = tagValue(xml, 'studio');
  const directors = tagValues(xml, 'director');
  if (directors.length) out.directors = directors;
  out.airDate = tagValue(xml, 'aired') || tagValue(xml, 'premiered') || tagValue(xml, 'releasedate');
  const actors = [];
  const actorRe = /<actor>([\s\S]*?)<\/actor>/gi;
  let m;
  while ((m = actorRe.exec(xml)) && actors.length < 20) {
    const name = tagValue(m[1], 'name');
    if (name) actors.push({ name, role: tagValue(m[1], 'role'), profile: actorPhoto(tagValue(m[1], 'thumb')) });
  }
  if (actors.length) out.cast = actors;
  const idRe = /<uniqueid[^>]*type="(\w+)"[^>]*>([^<]+)<\/uniqueid>/gi;
  while ((m = idRe.exec(xml))) {
    if (m[1].toLowerCase() === 'tmdb' && /^\d+$/.test(m[2].trim())) out.tmdbId = Number(m[2].trim());
    if (m[1].toLowerCase() === 'imdb') out.imdbId = m[2].trim();
  }
  const tmdb = tagValue(xml, 'tmdbid');
  if (!out.tmdbId && tmdb && /^\d+$/.test(tmdb)) out.tmdbId = Number(tmdb);
  const imdb = tagValue(xml, 'imdbid') || (tagValue(xml, 'id') || '').match(/^tt\d+$/)?.[0];
  if (!out.imdbId && imdb) out.imdbId = imdb;
  for (const k of Object.keys(out)) if (out[k] == null || out[k] === '') delete out[k];
  return out;
}

/**
 * The .nfo files a library walk came across, with their modified times, so a rescan can tell
 * whether an item's NFO appeared, changed or vanished without listing every folder again.
 */
export class NfoIndex {
  constructor() {
    this.dirs = new Map(); // dir -> Map(lowercase file name -> { path, mtime })
  }
  add(file, mtime) {
    const dir = path.dirname(file);
    if (!this.dirs.has(dir)) this.dirs.set(dir, new Map());
    this.dirs.get(dir).set(path.basename(file).toLowerCase(), { path: file, mtime });
  }
  /** The first of `names` (without ".nfo", any case) that exists in `dir`. */
  find(dir, names) {
    const files = this.dirs.get(dir);
    if (!files) return null;
    for (const n of names) {
      const hit = files.get(`${n.toLowerCase()}.nfo`);
      if (hit) return hit;
    }
    return null;
  }
}

export async function readNfoFile(file) {
  try {
    return parseNfo(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Cast from an NFO, with photos (and TMDB ids) filled in from another cast list (usually TMDB's) for
 * the same people: NFO actors often come without photos, and they shouldn't make existing ones disappear.
 */
export function mergeCast(nfoCast, otherCast) {
  const others = new Map((otherCast || []).filter((c) => c?.name).map((c) => [c.name.toLowerCase(), c]));
  return nfoCast.map((c) => {
    const o = others.get(c.name.toLowerCase());
    const tmdbId = c.tmdbId || o?.tmdbId;
    return { ...c, profile: c.profile || o?.profile || null, ...(tmdbId ? { tmdbId } : {}) };
  });
}

/**
 * Applies an item's stored NFO values (nfo_json) on top of other metadata `fields`, so what the
 * user put in their .nfo wins over online metadata. IDs are left alone: the TMDB match decides those.
 */
export function withNfo(fields, nfoJson, currentCastJson) {
  let nfo = null;
  try {
    nfo = nfoJson ? JSON.parse(nfoJson) : null;
  } catch {
    nfo = null;
  }
  if (!nfo) return fields;
  const out = { ...fields };
  for (const [key, value] of Object.entries(nfo)) {
    if (key === 'tmdb_id' || key === 'imdb_id') continue;
    if (key === 'cast_json') {
      const other = JSON.parse(fields.cast_json || currentCastJson || '[]');
      out.cast_json = JSON.stringify(mergeCast(JSON.parse(value), other));
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function readNfo(cache, dir, names) {
  const files = await cache.files(dir);
  const lower = new Map(files.map((f) => [f.toLowerCase(), f]));
  for (const n of names) {
    const hit = lower.get(`${n.toLowerCase()}.nfo`);
    if (hit) {
      try {
        const xml = await fs.readFile(path.join(dir, hit), 'utf8');
        return parseNfo(xml);
      } catch {
        return null;
      }
    }
  }
  return null;
}
