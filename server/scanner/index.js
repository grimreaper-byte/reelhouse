// Library scanner: walks library folders, probes new/changed files and keeps the items table in sync.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, parseJson } from '../db.js';
import { probe } from '../media/ffmpeg.js';
import { createLimiter } from '../lib/limit.js';
import { logger } from '../lib/log.js';
import { isPathInside } from '../lib/platform.js';
import { EventEmitter } from 'node:events';
import { libraryChanged, metadataProgress, scanProgress } from '../events.js';
import { regroupVersions, keepStateOfRemoved } from '../versions.js';
import {
  VIDEO_EXTENSIONS, UNSUPPORTED_EXTENSIONS, isIgnoredDir, isSampleFile, parseMovieName, parseShowFolder,
  parseSeasonFolder, parseEpisodeName, sortTitle, dropNewPrefix,
} from './parse.js';
import {
  DirCache, NfoIndex, movieArtwork, showArtwork, seasonArtwork, episodeThumb, sidecarSubtitles, readNfoFile, mergeCast,
} from './local.js';

const log = logger('scanner');

const status = { running: false, libraryId: null, libraryName: null, phase: null, done: 0, total: 0, queue: [] };
const queue = [];
let metadataHook = null;

export function scanStatus() {
  return { ...status, queue: queue.map((q) => q.libraryId), adding: adding && { ...adding } };
}

// ---------- "Adding …" (the web app's top bar) ----------

// Files new to a library while they're read, with the name of the latest one. Only new files count, so a routine
// scan that finds nothing new shows nothing. Pages hear it as 'scan' events, at most every quarter of a second.
const ADDING_EVERY_MS = 250;
let adding = null; // { libraryId, libraryName, total, done, file }
let addingSentAt = 0;
let addingTimer = null;
export const addingEvents = new EventEmitter(); // what pages are sent, for tests

function announceAdding(final = false) {
  clearTimeout(addingTimer);
  if (!adding) return;
  const wait = ADDING_EVERY_MS - (Date.now() - addingSentAt);
  if (!final && wait > 0) {
    addingTimer = setTimeout(() => announceAdding(), wait);
    return;
  }
  addingSentAt = Date.now();
  const data = final ? { ...adding, file: null, finished: true } : { ...adding };
  scanProgress(data);
  addingEvents.emit('progress', data);
}

// Files that couldn't be read aren't stored, so they'd count as new on every scan: path → size:mtime when that failed.
// They're still tried each time, but only show as "Adding" again once they change.
const unreadable = new Map();
const fileKey = (f) => `${f.size}:${f.mtime}`;
const isNewFile = (f, existing) => !existing.has(f.path) && unreadable.get(f.path) !== fileKey(f);

function startAdding(lib, total) {
  if (!total) return;
  adding = { libraryId: lib.id, libraryName: lib.name, total, done: 0, file: null };
  addingSentAt = 0; // the first file read is announced straight away, with its name
}

function addingFile(file) {
  if (!adding) return;
  adding.file = path.basename(file);
  announceAdding();
}

function addedFile() {
  if (!adding) return;
  adding.done = Math.min(adding.done + 1, adding.total);
  announceAdding();
}

function finishAdding() {
  if (!adding) return;
  adding.done = adding.total;
  announceAdding(true);
  adding = null;
}

/** Registers a function called with the library id after each scan (used to fetch online metadata). */
export function onScanComplete(fn) {
  metadataHook = fn;
}

export function queueScan(libraryId, { force = false } = {}) {
  if (status.running && status.libraryId === libraryId && !force) return;
  if (queue.some((q) => q.libraryId === libraryId)) return;
  queue.push({ libraryId, force });
  if (!status.running) void drain();
}

export function queueAllScans() {
  for (const lib of all('SELECT id FROM libraries')) queueScan(lib.id);
}

async function drain() {
  while (queue.length) {
    const job = queue.shift();
    const lib = get('SELECT * FROM libraries WHERE id = ?', job.libraryId);
    if (!lib) continue;
    Object.assign(status, { running: true, libraryId: lib.id, libraryName: lib.name, phase: 'Finding files', done: 0, total: 0 });
    const started = Date.now();
    try {
      const stats = await scanLibrary(lib, job.force);
      run('UPDATE libraries SET scanned_at = ? WHERE id = ?', Date.now(), lib.id);
      log.info(`Scanned "${lib.name}" in ${((Date.now() - started) / 1000).toFixed(1)}s:`, stats);
      if (stats.added || stats.updated || stats.removed || stats.nfo || stats.versions) {
        libraryChanged(lib.id, { added: stats.added, updated: stats.updated + stats.nfo + (stats.versions || 0), removed: stats.removed });
      }
      if (metadataHook) {
        status.phase = 'Fetching metadata';
        await metadataHook(lib.id, metadataProgress(lib.id, (done, total) => {
          status.done = done;
          status.total = total;
        }));
        // Films matched just now can turn out to be copies of each other (an SD and an HD file).
        const versions = lib.type === 'movie' ? regroupVersions(lib.id) : 0;
        if (versions) libraryChanged(lib.id, { updated: versions });
      }
    } catch (err) {
      log.error(`Scan of "${lib.name}" failed:`, err);
      finishAdding();
    }
  }
  Object.assign(status, { running: false, libraryId: null, libraryName: null, phase: null, done: 0, total: 0 });
}

// ---------- file discovery ----------

/**
 * Lists video files under root, plus the .nfo files and their modified times. Also returns the
 * folders that couldn't be read, so files inside them aren't mistaken for deleted ones.
 */
async function walk(root) {
  const files = [];
  const nfos = [];
  const unreadable = [];
  const stack = [root];
  const visited = new Set(); // real paths of directories, so symlink loops can't recurse forever
  const statLimit = createLimiter(16); // stats in parallel: big win on network shares
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      const real = await fs.realpath(dir);
      if (visited.has(real)) continue;
      visited.add(real);
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      log.warn(`Cannot read ${dir}: ${err.code || err.message}`);
      unreadable.push(dir);
      continue;
    }
    const pending = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!isIgnoredDir(e.name)) stack.push(full);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (ext === '.nfo' && !e.name.startsWith('._')) {
        pending.push(statLimit(async () => {
          try {
            nfos.push([full, Math.floor((await fs.stat(full)).mtimeMs)]);
          } catch {
            // vanished or unreadable
          }
        }));
        continue;
      }
      const isVideo = VIDEO_EXTENSIONS.has(ext) && !UNSUPPORTED_EXTENSIONS.has(ext) && !e.name.startsWith('._');
      // Symlinks may point at folders (common on Linux setups), so stat them even without a video extension.
      if (!isVideo && !e.isSymbolicLink()) continue;
      pending.push(statLimit(async () => {
        try {
          const st = await fs.stat(full);
          if (st.isDirectory()) {
            if (!isIgnoredDir(e.name)) stack.push(full);
          } else if (isVideo && st.isFile() && !isSampleFile(e.name, st.size)) {
            files.push({ path: full, size: st.size, mtime: Math.floor(st.mtimeMs) });
          }
        } catch {
          // vanished, unreadable, or a dangling link
        }
      }));
    }
    await Promise.all(pending);
  }
  return { files, nfos, unreadable };
}

function rootAvailable(root) {
  try {
    return fsSync.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

// ---------- shared helpers ----------

const now = () => Date.now();

function mediaColumns(info) {
  const firstAudio = info.audio.find((a) => a.isDefault) || info.audio[0];
  return {
    duration: info.duration,
    bitrate: info.bitrate,
    container: info.container,
    video_codec: info.video?.codec || null,
    width: info.video?.width || null,
    height: info.video?.height || null,
    audio_codec: firstAudio?.codec || null,
    media_json: JSON.stringify(info),
  };
}

function insertItem(fields) {
  const cols = Object.keys(fields);
  const res = run(
    `INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...cols.map((c) => fields[c]),
  );
  return Number(res.lastInsertRowid);
}

function updateItem(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  run(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), id);
}

function nfoFields(nfo) {
  if (!nfo) return {};
  const f = {};
  if (nfo.title) {
    f.title = nfo.title;
    f.sort_title = sortTitle(nfo.sortTitle || nfo.title);
  }
  if (nfo.originalTitle) f.original_title = nfo.originalTitle;
  if (nfo.year) f.year = nfo.year;
  if (nfo.overview) f.overview = nfo.overview;
  if (nfo.tagline) f.tagline = nfo.tagline;
  if (nfo.rating) f.rating = nfo.rating;
  if (nfo.contentRating) f.content_rating = nfo.contentRating;
  if (nfo.genres) f.genres = JSON.stringify(nfo.genres);
  if (nfo.cast) f.cast_json = JSON.stringify(nfo.cast);
  if (nfo.directors) f.directors = JSON.stringify(nfo.directors);
  if (nfo.studio) f.studio = nfo.studio;
  if (nfo.airDate) f.air_date = nfo.airDate;
  if (nfo.tmdbId) f.tmdb_id = nfo.tmdbId;
  if (nfo.imdbId) f.imdb_id = nfo.imdbId;
  return f;
}

// What a rescan needs to know about an existing item to update its NFO metadata.
const ROW_COLUMNS = 'id, nfo_mtime, match_locked, tmdb_id, imdb_id, cast_json';

/** An item's .nfo as it is now: its modified time and the column values it sets (both null if there's none). */
async function currentNfo(nfoIndex, dir, names) {
  const hit = dir ? nfoIndex.find(dir, names) : null;
  if (!hit) return { mtime: null, fields: null };
  const nfo = await readNfoFile(hit.path);
  return { mtime: hit.mtime, fields: nfo ? nfoFields(nfo) : {} };
}

/** Columns for a new item: the NFO's values plus the record of them. */
const nfoColumns = (nfo) => ({
  ...(nfo.fields || {}),
  nfo_json: nfo.fields ? JSON.stringify(nfo.fields) : null,
  nfo_mtime: nfo.mtime,
});

/**
 * Brings an existing item up to date with its .nfo if that appeared, changed or vanished since the
 * last scan (compared by modified time, so unchanged NFOs aren't even read). The NFO's values win
 * over online metadata; cast photos already known for the same people are kept. Returns true if
 * the item changed.
 */
async function refreshNfo(row, nfoIndex, dir, names) {
  const nfo = await currentNfo(nfoIndex, dir, names);
  if (nfo.mtime === (row.nfo_mtime ?? null)) return false;
  const update = { nfo_json: nfo.fields ? JSON.stringify(nfo.fields) : null, nfo_mtime: nfo.mtime, updated_at: now() };
  if (nfo.fields) {
    const { tmdb_id: tmdbId, imdb_id: imdbId, cast_json: castJson, ...rest } = nfo.fields;
    Object.assign(update, rest);
    if (castJson) update.cast_json = JSON.stringify(mergeCast(JSON.parse(castJson), parseJson(row.cast_json, [])));
    // Different ids in the NFO mean a different match: fetch online metadata again (unless an admin
    // fixed the match by hand). The NFO's own values still win afterwards.
    if (!row.match_locked && ((tmdbId && tmdbId !== row.tmdb_id) || (imdbId && imdbId !== row.imdb_id))) {
      Object.assign(update, { tmdb_id: tmdbId ?? row.tmdb_id, imdb_id: imdbId ?? row.imdb_id, metadata_at: null });
    }
  } else {
    // The NFO was deleted: fetch online metadata again so it replaces the NFO's values.
    update.metadata_at = null;
  }
  updateItem(row.id, update);
  row.nfo_mtime = nfo.mtime;
  return true;
}

async function probeSafe(file) {
  try {
    return await probe(file);
  } catch (err) {
    log.warn(`Could not probe ${file}: ${err.message}`);
    return null;
  }
}

function setProgress(done, total) {
  status.done = done;
  status.total = total;
}

// ---------- scanning ----------

async function scanLibrary(lib, force) {
  const roots = parseJson(lib.paths, []).map((p) => path.resolve(p));
  const existing = new Map(
    all(`SELECT ${ROW_COLUMNS}, file_path, file_size, file_mtime FROM items WHERE library_id = ? AND file_path IS NOT NULL`, lib.id)
      .map((r) => [r.file_path, r]),
  );
  const nfoIndex = new NfoIndex();

  // Folders whose contents we can't trust this time: missing roots (unplugged drive, offline
  // NAS), roots that are suddenly empty (an unmounted share on Linux is just an empty folder),
  // and subfolders that failed to read. Items inside them are kept rather than deleted.
  const offline = [];
  const found = [];
  for (const root of roots) {
    if (!rootAvailable(root)) {
      log.warn(`Library "${lib.name}": folder not available, skipping: ${root}`);
      offline.push(root);
      continue;
    }
    const { files, nfos, unreadable } = await walk(root);
    offline.push(...unreadable);
    for (const [file, mtime] of nfos) nfoIndex.add(file, mtime);
    const known = [...existing.values()].some((r) => isPathInside(r.file_path, root));
    if (!files.length && known) {
      log.warn(`Library "${lib.name}": ${root} is empty but used to contain media — is the drive/share mounted? Keeping existing items.`);
      offline.push(root);
      continue;
    }
    for (const f of files) found.push({ ...f, root });
  }
  status.phase = 'Reading media info';
  setProgress(0, found.length);

  startAdding(lib, found.filter((f) => isNewFile(f, existing)).length);
  const stats = lib.type === 'movie'
    ? await scanMovies(lib, found, existing, force, nfoIndex)
    : await scanShows(lib, found, existing, force, nfoIndex);
  finishAdding();

  const seen = new Set(found.map((f) => f.path));
  const toRemove = new Map();
  for (const r of existing.values()) {
    if (seen.has(r.file_path)) continue;
    const underRoot = roots.some((root) => isPathInside(r.file_path, root));
    const untrusted = offline.some((dir) => isPathInside(r.file_path, dir));
    // Gone from a readable folder, or its folder was removed from the library.
    if (!underRoot || !untrusted) toRemove.set(r.id, r);
  }
  if (toRemove.size) {
    tx(() => {
      if (lib.type === 'movie') keepStateOfRemoved([...toRemove.keys()]); // a film's other copy keeps where you were
      for (const id of toRemove.keys()) run('DELETE FROM items WHERE id = ?', id);
      if (lib.type === 'show') pruneEmptyContainers(lib.id);
    });
  }
  stats.removed = toRemove.size;
  if (lib.type === 'movie') stats.versions = regroupVersions(lib.id);
  return stats;
}

export function pruneEmptyContainers(libraryId) {
  run(
    `DELETE FROM items WHERE library_id = ? AND type = 'season'
       AND NOT EXISTS (SELECT 1 FROM items e WHERE e.parent_id = items.id)`,
    libraryId,
  );
  run(
    `DELETE FROM items WHERE library_id = ? AND type = 'show'
       AND NOT EXISTS (SELECT 1 FROM items s WHERE s.parent_id = items.id)`,
    libraryId,
  );
}

// ----- movies -----

async function scanMovies(lib, found, existing, force, nfoIndex) {
  const cache = new DirCache();
  const limit = createLimiter(3);
  let done = 0;
  const stats = { added: 0, updated: 0, unchanged: 0, failed: 0, nfo: 0 };

  await Promise.all(found.map((f) => limit(async () => {
    const isNew = isNewFile(f, existing);
    if (isNew) addingFile(f.path);
    let failed = false;
    try {
      const prev = existing.get(f.path);
      const dir = path.dirname(f.path);
      const dedicatedFolder = path.resolve(dir) !== path.resolve(f.root);
      const base = path.parse(f.path).name;
      const nfoNames = dedicatedFolder ? [base, 'movie'] : [base];
      if (prev && !force && prev.file_size === f.size && prev.file_mtime === f.mtime) {
        // The video hasn't changed, but its .nfo may have.
        if (await refreshNfo(prev, nfoIndex, dir, nfoNames)) stats.nfo++;
        else stats.unchanged++;
        return;
      }
      const info = await probeSafe(f.path);
      if (!info) {
        stats.failed++;
        failed = true;
        return;
      }
      const fromFile = parseMovieName(path.parse(f.path).name);
      const fromFolder = dedicatedFolder ? parseMovieName(path.basename(dir)) : null;
      const siblings = dedicatedFolder ? (await cache.files(dir)).filter((n) => VIDEO_EXTENSIONS.has(path.extname(n).toLowerCase())) : [];
      // Prefer the folder name when the movie lives alone in a folder that carries the year
      // (e.g. "Heat (1995)/heat.1080p.mkv"), or when the filename has no usable title.
      let parsed = fromFile;
      if (fromFolder && siblings.length <= 2 && (fromFolder.year || !fromFile.title)) {
        parsed = { ...fromFile, ...fromFolder, title: fromFolder.title || fromFile.title, year: fromFolder.year || fromFile.year };
      }
      const art = await movieArtwork(cache, f.path, dedicatedFolder && siblings.length <= 2);
      const subs = await sidecarSubtitles(cache, f.path);
      const t = now();
      const fields = {
        file_size: f.size,
        file_mtime: f.mtime,
        ...mediaColumns(info),
        subs_json: JSON.stringify(subs),
        folder_path: dir,
        updated_at: t,
      };
      if (prev) {
        updateItem(prev.id, fields);
        await refreshNfo(prev, nfoIndex, dir, nfoNames);
        stats.updated++;
      } else {
        const nfo = await currentNfo(nfoIndex, dir, nfoNames);
        insertItem({
          library_id: lib.id,
          type: 'movie',
          title: parsed.title || base,
          sort_title: sortTitle(parsed.title || base),
          year: parsed.year || null,
          tmdb_id: parsed.tmdbId || null,
          imdb_id: parsed.imdbId || null,
          poster: art.poster,
          backdrop: art.backdrop,
          file_path: f.path,
          added_at: Math.min(t, f.mtime || t),
          ...fields,
          ...nfoColumns(nfo),
        });
        stats.added++;
      }
    } catch (err) {
      stats.failed++;
      failed = true;
      log.warn(`Failed to scan ${f.path}:`, err.message);
    } finally {
      if (failed && !existing.has(f.path)) unreadable.set(f.path, fileKey(f));
      else unreadable.delete(f.path);
      if (isNew) addedFile();
      setProgress(++done, found.length);
    }
  })));
  return stats;
}

// ----- TV shows -----

function showKeyFor(f) {
  const rel = path.relative(f.root, f.path);
  const parts = rel.split(path.sep);
  if (parts.length >= 2) {
    // root/Show/.../file
    const showDir = path.join(f.root, parts[0]);
    return { key: showDir, showDir, folderName: parts[0], depthParts: parts.slice(1, -1) };
  }
  // File directly in the library root: group by the show name in the filename.
  const ep = parseEpisodeName(parts[0]);
  const name = ep.showTitle || dropNewPrefix(path.parse(parts[0]).name);
  return { key: `${f.root}${path.sep}::${sortTitle(name)}`, showDir: null, folderName: name, depthParts: [] };
}

async function scanShows(lib, found, existing, force, nfoIndex) {
  const cache = new DirCache();
  const stats = { added: 0, updated: 0, unchanged: 0, failed: 0, shows: 0, nfo: 0 };
  stats.renamed = tx(() => renameShows(lib.id));

  // Index existing shows/seasons for this library.
  const shows = new Map(
    all(`SELECT ${ROW_COLUMNS}, folder_path FROM items WHERE library_id = ? AND type = 'show'`, lib.id).map((r) => [r.folder_path, r]),
  );
  const seasons = new Map(
    all("SELECT id, show_id, season_number FROM items WHERE library_id = ? AND type = 'season'", lib.id)
      .map((r) => [`${r.show_id}:${r.season_number}`, r.id]),
  );

  // One show per folder name in a library: the same show's folder on two drives (seasons 1–3 on one, 4–5 on the
  // other) is one show, kept as the first one found (a recording's "New_ …" folder joins the plain one).
  const byName = new Map();
  for (const row of [...shows.values()].sort(plainFolderFirst)) {
    if (!byName.has(showName(row.folder_path))) byName.set(showName(row.folder_path), row);
  }

  async function ensureShow(info) {
    if (shows.has(info.key)) return shows.get(info.key).id;
    const same = byName.get(showName(info.key));
    if (same) {
      shows.set(info.key, same);
      return same.id;
    }
    const parsed = parseShowFolder(info.folderName);
    const nfo = await currentNfo(nfoIndex, info.showDir, ['tvshow']);
    const art = info.showDir ? await showArtwork(cache, info.showDir) : {};
    const t = now();
    const id = insertItem({
      library_id: lib.id,
      type: 'show',
      title: parsed.title || info.folderName,
      sort_title: sortTitle(parsed.title || info.folderName),
      year: parsed.year || null,
      tmdb_id: parsed.tmdbId || null,
      imdb_id: parsed.imdbId || null,
      folder_path: info.key,
      poster: art.poster || null,
      backdrop: art.backdrop || null,
      added_at: t,
      updated_at: t,
      ...nfoColumns(nfo),
    });
    const row = { id, nfo_mtime: nfo.mtime, folder_path: info.key };
    shows.set(info.key, row);
    byName.set(showName(info.key), row);
    stats.shows++;
    return id;
  }

  async function ensureSeason(showId, showDir, seasonDir, number) {
    const key = `${showId}:${number}`;
    if (seasons.has(key)) return seasons.get(key);
    const art = await seasonArtwork(cache, showDir, seasonDir, number);
    const t = now();
    const id = insertItem({
      library_id: lib.id,
      type: 'season',
      parent_id: showId,
      show_id: showId,
      title: number === 0 ? 'Specials' : `Season ${number}`,
      sort_title: String(number).padStart(4, '0'),
      season_number: number,
      folder_path: seasonDir,
      poster: art.poster,
      added_at: t,
      updated_at: t,
    });
    seasons.set(key, id);
    return id;
  }

  // Probe in parallel, but create show/season rows serially to avoid duplicates.
  const limit = createLimiter(3);
  let done = 0;
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  await Promise.all(found.map((f) => limit(async () => {
    const isNew = isNewFile(f, existing);
    if (isNew) addingFile(f.path);
    let failed = false;
    try {
      const prev = existing.get(f.path);
      const epNfoNames = [path.parse(f.path).name];
      if (prev && !force && prev.file_size === f.size && prev.file_mtime === f.mtime) {
        // The video hasn't changed, but its .nfo may have.
        if (await refreshNfo(prev, nfoIndex, path.dirname(f.path), epNfoNames)) stats.nfo++;
        else stats.unchanged++;
        return;
      }
      const info = await probeSafe(f.path);
      if (!info) {
        stats.failed++;
        failed = true;
        return;
      }
      await serial(async () => {
        const showInfo = showKeyFor(f);
        const ep = parseEpisodeName(path.basename(f.path));
        // Season: from SxxExx, else from the nearest "Season N" folder, else 1.
        let seasonNumber = ep.season;
        let seasonDir = path.dirname(f.path);
        if (seasonNumber == null) {
          for (let i = showInfo.depthParts.length - 1; i >= 0; i--) {
            const s = parseSeasonFolder(showInfo.depthParts[i]);
            if (s != null) {
              seasonNumber = s;
              break;
            }
          }
        }
        if (seasonNumber == null && ep.airDate) seasonNumber = Number(ep.airDate.slice(0, 4));
        if (seasonNumber == null) seasonNumber = 1;

        const showId = await ensureShow(showInfo);
        const seasonId = await ensureSeason(showId, showInfo.showDir, seasonDir, seasonNumber);
        const base = path.parse(f.path).name;
        const thumb = await episodeThumb(cache, f.path);
        const subs = await sidecarSubtitles(cache, f.path);
        const t = now();
        const title = ep.episodeTitle || (ep.episode != null ? `Episode ${ep.episode}` : ep.airDate || base);
        const fields = {
          parent_id: seasonId,
          show_id: showId,
          season_number: seasonNumber,
          episode_number: ep.episode,
          episode_end: ep.episodeEnd,
          file_size: f.size,
          file_mtime: f.mtime,
          ...mediaColumns(info),
          subs_json: JSON.stringify(subs),
          updated_at: t,
        };
        if (prev) {
          updateItem(prev.id, fields);
          await refreshNfo(prev, nfoIndex, path.dirname(f.path), epNfoNames);
          stats.updated++;
        } else {
          const nfo = await currentNfo(nfoIndex, path.dirname(f.path), epNfoNames);
          insertItem({
            library_id: lib.id,
            type: 'episode',
            title,
            sort_title: ep.episode != null ? String(ep.episode).padStart(5, '0') : sortTitle(title),
            air_date: ep.airDate,
            thumb,
            file_path: f.path,
            added_at: Math.min(t, f.mtime || t),
            ...fields,
            ...nfoColumns(nfo),
          });
          stats.added++;
        }
      });
    } catch (err) {
      stats.failed++;
      failed = true;
      log.warn(`Failed to scan ${f.path}:`, err.message);
    } finally {
      if (failed && !existing.has(f.path)) unreadable.set(f.path, fileKey(f));
      else unreadable.delete(f.path);
      if (isNew) addedFile();
      setProgress(++done, found.length);
    }
  })));
  // Failures were already counted and logged per file; don't let the last one abort the scan.
  await chain.catch(() => {});

  // Shows whose episodes didn't change still get their tvshow.nfo checked.
  const showDirs = new Map();
  for (const f of found) {
    const info = showKeyFor(f);
    if (info.showDir) showDirs.set(info.key, info.showDir);
  }
  for (const [key, dir] of showDirs) {
    const row = shows.get(key);
    // A show is described by its own folder's tvshow.nfo, not by a same-named folder on another drive.
    if (row && row.folder_path === key && (await refreshNfo(row, nfoIndex, dir, ['tvshow']))) stats.nfo++;
  }

  // Shows split before same-named folders counted as one (or across libraries merged into this one) come together;
  // episodes that moved to another season leave empty containers behind.
  tx(() => {
    stats.merged = mergeSameNamedShows(lib.id);
    pruneEmptyContainers(lib.id);
  });
  return stats;
}

/**
 * A show's name for matching folders across a library's folders: "Bluey" on two drives is one show, and so are a
 * recording's "New_ Mock The Week" and "Mock The Week".
 */
export function showName(folderPathOrKey) {
  const key = String(folderPathOrKey || '');
  // Shows from files lying directly in a library folder are keyed "<root>/::<sort title>".
  const marker = key.lastIndexOf('::');
  if (marker >= 0) return key.slice(marker + 2);
  return sortTitle(dropNewPrefix(path.basename(key)));
}

/** Whether a show's folder is a recording's "New_ …" one. */
function newEpisodeFolder(folderPath) {
  const name = path.basename(String(folderPath || ''));
  return dropNewPrefix(name) !== name;
}

/** Shows in the order the first of a name is kept in: a plain-named folder before a "New_ …" one, then oldest first. */
const plainFolderFirst = (a, b) => newEpisodeFolder(a.folder_path) - newEpisodeFolder(b.folder_path) || a.id - b.id;

/**
 * Brings shows with the same folder name in a library together: the later ones' seasons join the first show (a
 * season number it already has gets their episodes; a plain-named folder's show is first before a "New_ …" one's).
 * Episodes keep their ids, so watch history stays. Returns how many shows were merged; the emptied ones are pruned
 * after.
 */
export function mergeSameNamedShows(libraryId) {
  const first = new Map();
  let merged = 0;
  const shows = all("SELECT id, title, folder_path FROM items WHERE library_id = ? AND type = 'show'", libraryId);
  for (const show of shows.sort(plainFolderFirst)) {
    const name = showName(show.folder_path);
    const keep = first.get(name);
    if (!keep) {
      first.set(name, show);
      continue;
    }
    for (const season of all("SELECT id, season_number FROM items WHERE parent_id = ? AND type = 'season'", show.id)) {
      const target = get("SELECT id FROM items WHERE parent_id = ? AND type = 'season' AND season_number IS ?", keep.id, season.season_number);
      if (target) {
        run('UPDATE items SET parent_id = ?, show_id = ? WHERE parent_id = ?', target.id, keep.id, season.id);
      } else {
        run('UPDATE items SET parent_id = ?, show_id = ? WHERE id = ?', keep.id, keep.id, season.id);
        run('UPDATE items SET show_id = ? WHERE parent_id = ?', keep.id, season.id);
      }
    }
    log.info(`Merged show "${show.title}" (${show.folder_path}) into "${keep.title}" (${keep.folder_path}): same folder name`);
    merged++;
  }
  return merged;
}

/**
 * Brings a library's shows up to the naming rules before a scan, for shows named before a recording's "New_ " was
 * left off (dropNewPrefix). A show from files lying in a library folder is filed under its files' show name again
 * (its key), so the merge after the scan brings it together with the same-named one. A show titled from such a name
 * ("New Mock The Week") takes the plain one and TMDB is asked again — not one TMDB matched (its title is TMDB's), an
 * admin matched by hand or its tvshow.nfo names. Returns how many shows changed.
 */
export function renameShows(libraryId) {
  let changed = 0;
  const shows = all("SELECT id, title, folder_path, tmdb_id, match_locked, nfo_json FROM items WHERE library_id = ? AND type = 'show'", libraryId);
  for (const show of shows) {
    const key = String(show.folder_path || '');
    const marker = key.lastIndexOf('::');
    const update = {};
    let name;
    if (marker >= 0) {
      // Keyed "<root>/::<sort title>" by the show name in its files' names: what that name is now.
      const ep = get('SELECT file_path FROM items WHERE show_id = ? AND file_path IS NOT NULL LIMIT 1', show.id);
      if (!ep) continue;
      const info = showKeyFor({ root: key.slice(0, marker - path.sep.length), path: ep.file_path });
      if (info.key === key) continue;
      update.folder_path = info.key;
      name = info.folderName;
    } else {
      if (!newEpisodeFolder(key)) continue;
      name = path.basename(key);
    }
    const { title } = parseShowFolder(name);
    if (title && title !== show.title && !show.tmdb_id && !show.match_locked && !parseJson(show.nfo_json, {})?.title) {
      Object.assign(update, { title, sort_title: sortTitle(title), metadata_at: null });
      log.info(`Renamed show "${show.title}" to "${title}" (${key})`);
    }
    if (!Object.keys(update).length) continue;
    updateItem(show.id, { ...update, updated_at: now() });
    changed++;
  }
  return changed;
}

// ---------- folder watching ----------

const watchers = new Map();
const watchTimers = new Map();

export function watchLibraries(enabled) {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  if (!enabled) return;
  for (const lib of all('SELECT id, paths FROM libraries')) {
    for (const root of parseJson(lib.paths, [])) {
      try {
        const w = fsSync.watch(root, { recursive: true }, (event, filename) => {
          if (!filename) return;
          const ext = path.extname(String(filename)).toLowerCase();
          if (ext && !VIDEO_EXTENSIONS.has(ext) && !['.nfo', '.jpg', '.png', '.srt'].includes(ext)) return;
          // Debounce: copying a large file fires many events.
          clearTimeout(watchTimers.get(lib.id));
          watchTimers.set(lib.id, setTimeout(() => queueScan(lib.id), 30000));
        });
        w.on('error', () => w.close());
        watchers.set(`${lib.id}:${root}`, w);
      } catch (err) {
        log.warn(`Cannot watch ${root}: ${err.message}`);
      }
    }
  }
}
