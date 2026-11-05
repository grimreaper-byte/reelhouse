// Choosing artwork by hand: lists what's available for an item (TMDB's alternatives and image files next to
// the media) and records an admin's pick, which scans and metadata refreshes then leave alone.
import fs from 'node:fs/promises';
import path from 'node:path';
import { get, run, parseJson } from './db.js';
import { IMAGE_EXTENSIONS } from './scanner/parse.js';
import { DirCache, movieArtwork, showArtwork, seasonArtwork, episodeThumb } from './scanner/local.js';
import { tmdbArtwork, tmdbConfigured, refreshItem } from './metadata/tmdb.js';
import { logger } from './lib/log.js';

const log = logger('artwork');

/** Which artwork each kind of item has: posters and backgrounds, season posters, episode thumbnails. */
export const ART_KINDS = { movie: ['poster', 'backdrop'], show: ['poster', 'backdrop'], season: ['poster'], episode: ['thumb'] };

const TMDB_REF = /^tmdb:\/[\w-]+\.(jpe?g|png|webp)$/i;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const libraryRoots = (row) => parseJson(get('SELECT paths FROM libraries WHERE id = ?', row.library_id)?.paths, [])
  .map((p) => path.resolve(p));

// Shows found directly in a library root (no folder of their own) have a synthetic "<root>/::<name>" key.
const realFolder = (p) => (p && !p.includes('::') ? p : null);

/** The folders that hold this item's artwork, each with a filter for which image names belong to it. */
function artworkFolders(row) {
  const startsWith = (file) => {
    const base = path.parse(file).name.toLowerCase();
    return (name) => name.toLowerCase().startsWith(base);
  };
  if (row.type === 'movie' && row.file_path) {
    const dir = path.dirname(row.file_path);
    // In a folder of its own every image is the movie's; in a shared folder only "<movie name>…" ones are.
    const shared = libraryRoots(row).some((root) => path.resolve(dir) === root);
    return [[dir, shared ? startsWith(row.file_path) : () => true]];
  }
  if (row.type === 'show') return realFolder(row.folder_path) ? [[row.folder_path, () => true]] : [];
  if (row.type === 'season') {
    const showDir = realFolder(get('SELECT folder_path FROM items WHERE id = ?', row.show_id)?.folder_path);
    const out = [];
    if (showDir) out.push([showDir, (n) => /^(season|specials)/i.test(n)]);
    // The season folder also holds episode thumbnails; only poster-like names count.
    if (row.folder_path && row.folder_path !== showDir) out.push([row.folder_path, (n) => /^(poster|folder|cover|season)/i.test(n)]);
    return out;
  }
  if (row.type === 'episode' && row.file_path) return [[path.dirname(row.file_path), startsWith(row.file_path)]];
  return [];
}

/** Image files next to the media that could be this item's artwork (absolute paths). */
export async function localArtworkFiles(row) {
  const files = [];
  for (const [dir, belongs] of artworkFolders(row)) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && IMAGE_EXTENSIONS.includes(path.extname(e.name).toLowerCase()) && belongs(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}

/** What the item's artwork would be without a hand-picked choice, from local files (TMDB fills in later). */
async function automaticLocalArt(row, kind) {
  const cache = new DirCache();
  if (row.type === 'movie' && row.file_path) {
    const dedicated = !libraryRoots(row).some((root) => path.resolve(path.dirname(row.file_path)) === root);
    return (await movieArtwork(cache, row.file_path, dedicated))[kind] || null;
  }
  if (row.type === 'show') return realFolder(row.folder_path) ? (await showArtwork(cache, row.folder_path))[kind] || null : null;
  if (row.type === 'season') {
    const showDir = realFolder(get('SELECT folder_path FROM items WHERE id = ?', row.show_id)?.folder_path);
    return (await seasonArtwork(cache, showDir, row.folder_path, row.season_number)).poster || null;
  }
  if (row.type === 'episode' && row.file_path) return episodeThumb(cache, row.file_path);
  return null;
}

/**
 * Everything an admin can choose from: { kinds, current, picked, options: { [kind]: [{ ref, source, ... }] }, tmdb }.
 * Local files come first, then TMDB's images (best first).
 */
export async function listArtwork(row) {
  const kinds = ART_KINDS[row.type] || [];
  const picked = parseJson(row.art_json, {}) || {};
  const options = Object.fromEntries(kinds.map((k) => [k, []]));
  for (const file of await localArtworkFiles(row)) {
    for (const k of kinds) options[k].push({ ref: `file:${file}`, source: 'local', name: path.basename(file) });
  }
  const tmdb = { configured: tmdbConfigured(), matched: false, error: null };
  if (tmdb.configured) {
    try {
      const found = await tmdbArtwork(row);
      if (found) {
        tmdb.matched = true;
        for (const k of kinds) options[k].push(...found[k]);
      }
    } catch (err) {
      tmdb.error = err.message;
      log.warn(`Could not list TMDB artwork for "${row.title}": ${err.message}`);
    }
  }
  return {
    kinds,
    current: Object.fromEntries(kinds.map((k) => [k, row[k] || null])),
    picked: Object.fromEntries(kinds.map((k) => [k, !!picked[k]])),
    options,
    tmdb,
  };
}

/**
 * Uses `ref` (a "tmdb:/…" image or one of the item's local files) as its `kind` artwork from now on,
 * or with ref = null goes back to choosing automatically.
 */
export async function setArtwork(row, kind, ref) {
  if (!(ART_KINDS[row.type] || []).includes(kind)) throw httpError(400, 'That artwork can’t be changed for this item');
  const picked = { ...(parseJson(row.art_json, {}) || {}) };
  if (ref == null) {
    delete picked[kind];
    run(`UPDATE items SET ${kind} = ?, art_json = ?, updated_at = ? WHERE id = ?`,
      await automaticLocalArt(row, kind), Object.keys(picked).length ? JSON.stringify(picked) : null, Date.now(), row.id);
    // TMDB's own choice replaces a missing local file (refreshing a season or episode refreshes its show).
    if (tmdbConfigured()) await refreshItem(row.id).catch((err) => log.warn(`Refresh after artwork reset failed: ${err.message}`));
    return;
  }
  if (typeof ref !== 'string') throw httpError(400, 'Choose an image');
  if (ref.startsWith('tmdb:')) {
    if (!TMDB_REF.test(ref)) throw httpError(400, 'Not a TMDB image');
  } else if (ref.startsWith('file:')) {
    // Only image files that belong to this item: never an arbitrary path on the server.
    if (!(await localArtworkFiles(row)).includes(ref.slice(5))) throw httpError(400, 'That file isn’t next to this item’s media');
  } else {
    throw httpError(400, 'Choose an image');
  }
  picked[kind] = ref;
  run(`UPDATE items SET ${kind} = ?, art_json = ?, updated_at = ? WHERE id = ?`, ref, JSON.stringify(picked), Date.now(), row.id);
}
