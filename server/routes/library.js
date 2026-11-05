import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, placeholders, parseJson } from '../db.js';
import { requireUser, requireAdmin, allowedLibraryIds, userForSession } from '../auth.js';
import { openEventStream, libraryChanged, stateChanged } from '../events.js';
import {
  serializeItem, serializeMany, getAccessibleItem, setWatched, adjacentEpisodes, nextUpEpisode, statesFor, playableIdsUnder,
} from '../items.js';
import { queueScan, scanStatus, watchLibraries } from '../scanner/index.js';
import { LIBRARY_ORDER, orderLibraries, libraryIcon, pickedIcon } from '../libraries.js';
import { getSetting } from '../settings.js';
import { refreshItem, setMatch, search as tmdbSearch, tmdbConfigured } from '../metadata/tmdb.js';
import { resolveItemImage, resolveTmdbImage, resolveLocalImage } from '../media/images.js';
import { ART_KINDS, listArtwork, setArtwork, localArtworkFiles } from '../artwork.js';
import { relatedFor } from '../related.js';
import { personPage } from '../people.js';
import { watchedByOthers } from '../hubs.js';
import { addLibraryPaths, mergeLibraries, sameNamedLibrary } from '../libraries.js';
import { versionsOf, versionOut, regroupVersions } from '../versions.js';

const router = Router();

// ---------- libraries ----------

function libraryOut(lib, admin) {
  const counts = get(
    `SELECT COUNT(*) AS n FROM items WHERE library_id = ? AND type = ? AND version_of IS NULL`,
    lib.id,
    lib.type === 'movie' ? 'movie' : 'show',
  );
  const out = { id: lib.id, name: lib.name, type: lib.type, icon: libraryIcon(lib), count: counts.n, scannedAt: lib.scanned_at };
  if (admin) out.paths = parseJson(lib.paths, []);
  return out;
}

/** The libraries someone may open, in their order from Settings → Libraries. */
function librariesFor(user) {
  const ids = allowedLibraryIds(user);
  return ids.length ? all(`SELECT * FROM libraries WHERE id IN (${placeholders(ids)}) ORDER BY ${LIBRARY_ORDER}`, ...ids) : [];
}

router.get('/libraries', requireUser, (req, res) => {
  res.json({ libraries: librariesFor(req.user).map((l) => libraryOut(l, req.user.isAdmin)) });
});

// Settings → Libraries' order, { ids } first to last; kept in the database. Open pages and apps hear of it, so the
// sidebar and Home follow straight away.
router.put('/libraries/order', requireAdmin, (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Give the libraries in their new order' });
  orderLibraries(ids);
  libraryChanged(null, { order: true });
  res.json({ libraries: librariesFor(req.user).map((l) => libraryOut(l, true)) });
});

function validatePaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Add at least one folder');
  return paths.map((p) => {
    const resolved = path.resolve(String(p).trim());
    let st;
    try {
      st = fs.statSync(resolved);
    } catch {
      throw new Error(`Folder not found: ${resolved}`);
    }
    if (!st.isDirectory()) throw new Error(`Not a folder: ${resolved}`);
    return resolved;
  });
}

router.post('/libraries', requireAdmin, (req, res) => {
  const { name, type, paths } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!['movie', 'show'].includes(type)) return res.status(400).json({ error: 'Type must be movie or show' });
  let clean, icon;
  try {
    icon = pickedIcon(req.body.icon, type);
    clean = validatePaths(paths);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // Same name and kind as a library that exists: these folders join it, so both show up together.
  const same = sameNamedLibrary(name, type);
  if (same) {
    addLibraryPaths(same.id, clean);
    // Its own icon stays unless another was picked (the dialog starts on the type's).
    if (icon) run('UPDATE libraries SET icon = ? WHERE id = ?', icon, same.id);
    queueScan(same.id);
    watchLibraries(getSetting('watchFolders'));
    libraryChanged(same.id, { paths: true });
    return res.json({ library: libraryOut(get('SELECT * FROM libraries WHERE id = ?', same.id), true), joined: true });
  }
  // A new library goes last; it can be moved in Settings → Libraries.
  const r = run(`INSERT INTO libraries (name, type, icon, paths, created_at, position)
                 VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM libraries))`,
  name.trim(), type, icon, JSON.stringify(clean), Date.now());
  const id = Number(r.lastInsertRowid);
  queueScan(id);
  watchLibraries(getSetting('watchFolders'));
  res.json({ library: libraryOut(get('SELECT * FROM libraries WHERE id = ?', id), true) });
});

router.patch('/libraries/:id', requireAdmin, (req, res) => {
  const lib = get('SELECT * FROM libraries WHERE id = ?', Number(req.params.id));
  if (!lib) return res.status(404).json({ error: 'No such library' });
  const { name, icon, paths } = req.body || {};
  let picked;
  try {
    if (icon !== undefined) picked = pickedIcon(icon, lib.type);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    run('UPDATE libraries SET name = ? WHERE id = ?', String(name).trim(), lib.id);
    libraryChanged(lib.id, { renamed: true });
  }
  if (icon !== undefined && picked !== lib.icon) {
    run('UPDATE libraries SET icon = ? WHERE id = ?', picked, lib.id);
    libraryChanged(lib.id, { icon: true });
  }
  if (paths !== undefined) {
    try {
      run('UPDATE libraries SET paths = ? WHERE id = ?', JSON.stringify(validatePaths(paths)), lib.id);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    queueScan(lib.id);
    watchLibraries(getSetting('watchFolders'));
  }
  res.json({ library: libraryOut(get('SELECT * FROM libraries WHERE id = ?', lib.id), true) });
});

// Two libraries become one ({ into }): folders and items move, watch history stays. See server/libraries.js.
router.post('/libraries/:id/merge', requireAdmin, (req, res) => {
  const sourceId = Number(req.params.id);
  let result;
  try {
    result = mergeLibraries(sourceId, Number(req.body?.into));
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  libraryChanged(sourceId, { deleted: true });
  libraryChanged(result.target.id, { paths: true });
  // A scan brings same-named shows from the two together and picks up anything new.
  queueScan(result.target.id);
  watchLibraries(getSetting('watchFolders'));
  res.json({ library: libraryOut(result.target, true), moved: result.moved });
});

router.delete('/libraries/:id', requireAdmin, (req, res) => {
  run('DELETE FROM libraries WHERE id = ?', Number(req.params.id));
  watchLibraries(getSetting('watchFolders'));
  libraryChanged(Number(req.params.id), { deleted: true });
  res.json({ ok: true });
});

router.post('/libraries/:id/scan', requireAdmin, (req, res) => {
  const lib = get('SELECT id FROM libraries WHERE id = ?', Number(req.params.id));
  if (!lib) return res.status(404).json({ error: 'No such library' });
  queueScan(lib.id, { force: !!req.body?.force });
  res.json({ status: scanStatus() });
});

router.post('/libraries/:id/refresh-metadata', requireAdmin, (req, res) => {
  const lib = get('SELECT id FROM libraries WHERE id = ?', Number(req.params.id));
  if (!lib) return res.status(404).json({ error: 'No such library' });
  if (!tmdbConfigured()) return res.status(400).json({ error: 'Add a TMDB API key in Settings → Metadata first' });
  run('UPDATE items SET metadata_at = NULL WHERE library_id = ?', lib.id);
  queueScan(lib.id);
  res.json({ status: scanStatus() });
});

router.get('/scan/status', requireUser, (req, res) => {
  const status = scanStatus();
  // What's being added (the top bar) is only for those who can open that library.
  if (status.adding && !allowedLibraryIds(req.user).includes(status.adding.libraryId)) status.adding = null;
  res.json(status);
});

// Live updates: the web app keeps this open and refreshes pages when a library changes.
router.get('/events', requireUser, (req, res) => {
  const token = req.sessionToken;
  if (!token) return res.status(401).end(); // play tokens can't subscribe
  openEventStream(req, res, () => userForSession(token));
});

// ---------- browsing ----------

const SORTS = {
  title: 'i.sort_title',
  year: 'i.year',
  added: 'i.added_at',
  rating: 'i.rating',
  released: 'i.air_date',
  duration: 'i.duration',
};

router.get('/libraries/:id/items', requireUser, (req, res) => {
  const libId = Number(req.params.id);
  if (!allowedLibraryIds(req.user).includes(libId)) return res.status(404).json({ error: 'No such library' });
  const lib = get('SELECT * FROM libraries WHERE id = ?', libId);
  const type = lib.type === 'movie' ? 'movie' : 'show';
  const sortCol = SORTS[req.query.sort] || SORTS.title;
  const dir = req.query.order === 'desc' ? 'DESC' : 'ASC';
  const where = ['i.library_id = ?', 'i.type = ?', 'i.version_of IS NULL'];
  const params = [req.user.id, libId, type];
  if (req.query.genre) {
    where.push(`EXISTS (SELECT 1 FROM json_each(i.genres) g WHERE g.value = ?)`);
    params.push(String(req.query.genre));
  }
  const filter = req.query.filter;
  if (type === 'movie') {
    if (filter === 'unwatched') where.push('COALESCE(us.watched, 0) = 0');
    if (filter === 'watched') where.push('us.watched = 1');
    if (filter === 'inprogress') where.push('us.position > 0');
  } else {
    if (filter === 'unwatched') where.push(`EXISTS (SELECT 1 FROM items e LEFT JOIN user_state es ON es.item_id = e.id AND es.user_id = ?1
      WHERE e.show_id = i.id AND e.type = 'episode' AND COALESCE(es.watched, 0) = 0)`);
    if (filter === 'watched') where.push(`NOT EXISTS (SELECT 1 FROM items e LEFT JOIN user_state es ON es.item_id = e.id AND es.user_id = ?1
      WHERE e.show_id = i.id AND e.type = 'episode' AND COALESCE(es.watched, 0) = 0)`);
    if (filter === 'inprogress') where.push(`EXISTS (SELECT 1 FROM items e JOIN user_state es ON es.item_id = e.id AND es.user_id = ?1
      WHERE e.show_id = i.id AND (es.position > 0 OR es.watched = 1))`);
  }
  const rows = all(
    `SELECT i.* FROM items i LEFT JOIN user_state us ON us.item_id = i.id AND us.user_id = ?1
      WHERE ${where.join(' AND ')}
      ORDER BY ${sortCol} IS NULL, ${sortCol} ${dir}, i.sort_title ASC`,
    ...params,
  );
  res.json({ library: libraryOut(lib, req.user.isAdmin), items: serializeMany(req.user.id, rows) });
});

router.get('/libraries/:id/genres', requireUser, (req, res) => {
  const libId = Number(req.params.id);
  if (!allowedLibraryIds(req.user).includes(libId)) return res.status(404).json({ error: 'No such library' });
  const rows = all(
    `SELECT g.value AS genre, COUNT(*) AS n FROM items i, json_each(i.genres) g
      WHERE i.library_id = ? AND i.type IN ('movie', 'show') AND i.genres IS NOT NULL AND i.version_of IS NULL
      GROUP BY g.value ORDER BY g.value`,
    libId,
  );
  res.json({ genres: rows });
});

// ---------- home hubs ----------

function continueWatching(user, libIds) {
  if (!libIds.length) return [];
  const inProgress = all(
    `SELECT i.*, us.updated_at AS _ts FROM user_state us JOIN items i ON i.id = us.item_id
      WHERE us.user_id = ? AND us.position >= 30 AND i.type IN ('movie', 'episode')
        AND i.library_id IN (${placeholders(libIds)})
      ORDER BY us.updated_at DESC LIMIT 30`,
    user.id,
    ...libIds,
  );
  // "Next up": the episode after the one most recently finished, per show.
  const recentShows = all(
    `SELECT e.show_id AS show_id, MAX(us.updated_at) AS ts FROM user_state us JOIN items e ON e.id = us.item_id
      WHERE us.user_id = ? AND e.type = 'episode' AND us.watched = 1 AND us.updated_at > ?
        AND e.library_id IN (${placeholders(libIds)})
      GROUP BY e.show_id ORDER BY ts DESC LIMIT 20`,
    user.id,
    Date.now() - 90 * 24 * 3600 * 1000,
    ...libIds,
  );
  const seenShows = new Set(inProgress.filter((r) => r.type === 'episode').map((r) => r.show_id));
  const nextUp = [];
  for (const s of recentShows) {
    if (seenShows.has(s.show_id)) continue;
    const show = get('SELECT * FROM items WHERE id = ?', s.show_id);
    if (!show) continue;
    const ep = nextUpEpisode(user.id, show);
    const st = ep && statesFor(user.id, [ep.id]).get(ep.id);
    if (ep && !st?.watched) nextUp.push({ ...ep, _ts: s.ts });
  }
  const merged = [...inProgress, ...nextUp].sort((a, b) => b._ts - a._ts).slice(0, 24);
  return withShowInfo(serializeMany(user.id, merged), merged);
}

// Adds show title / season info used by episode cards.
function withShowInfo(serialized, rows) {
  const showIds = [...new Set(rows.filter((r) => r.show_id).map((r) => r.show_id))];
  const shows = new Map(showIds.length ? all(`SELECT id, title, updated_at FROM items WHERE id IN (${placeholders(showIds)})`, ...showIds).map((s) => [s.id, s]) : []);
  return serialized.map((s) => {
    if (s.showId && shows.has(s.showId)) {
      const sh = shows.get(s.showId);
      s.show = { id: sh.id, title: sh.title, poster: `/api/images/${sh.id}/poster?v=${sh.updated_at}` };
    }
    return s;
  });
}

function recentlyAdded(user, lib) {
  if (lib.type === 'movie') {
    const rows = all(`SELECT * FROM items WHERE library_id = ? AND type = 'movie' AND version_of IS NULL ORDER BY added_at DESC LIMIT 24`, lib.id);
    return serializeMany(user.id, rows);
  }
  // Group recent episodes by season: one card per season, or the episode itself if it's alone.
  const eps = all(`SELECT * FROM items WHERE library_id = ? AND type = 'episode' ORDER BY added_at DESC LIMIT 300`, lib.id);
  const groups = new Map();
  for (const e of eps) {
    let g = groups.get(e.parent_id);
    if (!g) {
      if (groups.size >= 24) continue;
      g = { latest: e.added_at, episodes: [] };
      groups.set(e.parent_id, g);
    }
    if (g.latest - e.added_at < 14 * 24 * 3600 * 1000) g.episodes.push(e);
  }
  const rows = [];
  for (const [seasonId, g] of groups) {
    if (g.episodes.length === 1) rows.push(g.episodes[0]);
    else {
      const season = get('SELECT * FROM items WHERE id = ?', seasonId);
      if (season) rows.push({ ...season, _newCount: g.episodes.length });
    }
  }
  const out = withShowInfo(serializeMany(user.id, rows), rows);
  rows.forEach((r, i) => {
    if (r._newCount) out[i].newCount = r._newCount;
  });
  return out;
}

router.get('/hubs/home', requireUser, (req, res) => {
  const libIds = allowedLibraryIds(req.user);
  const libs = librariesFor(req.user);
  const hubs = [];
  const cw = continueWatching(req.user, libIds);
  // Posters like the other rows: an episode's is its season's or show's (server/media/images.js).
  if (cw.length) hubs.push({ id: 'continue', title: 'Continue Watching', style: 'poster', items: cw });
  for (const lib of libs) {
    const items = recentlyAdded(req.user, lib);
    if (items.length) {
      hubs.push({ id: `recent-${lib.id}`, title: `Recently Added in ${lib.name}`, libraryId: lib.id, style: 'poster', items });
    }
  }
  const others = watchedByOthers(req.user, libIds);
  if (others.length) hubs.push({ id: 'others', title: 'Watched by Others', style: 'poster', items: others });
  res.json({ hubs, libraries: libs.map((l) => libraryOut(l, false)) });
});

// ---------- item details ----------

function mediaInfo(row, isAdmin) {
  const m = parseJson(row.media_json, null);
  if (!m) return null;
  const out = {
    container: m.container,
    duration: m.duration,
    bitrate: m.bitrate,
    fileSize: row.file_size,
    video: m.video,
    audio: m.audio,
    subtitles: m.subtitles,
    external: parseJson(row.subs_json, []).map(({ path: p, ...rest }) => rest),
    chapters: m.chapters,
  };
  if (isAdmin) out.file = row.file_path;
  return out;
}

router.get('/items/:id', requireUser, (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const [item] = serializeMany(req.user.id, [row], { full: true });
  const out = { item };

  if (row.type === 'movie' || row.type === 'episode') item.media = mediaInfo(row, req.user.isAdmin);
  // A film with more than one copy (SD and HD, say): each copy, best first, which Play version… offers.
  const copies = versionsOf(row);
  if (copies.length) item.versions = copies.map((c) => ({ ...versionOut(c), media: mediaInfo(c, req.user.isAdmin) }));

  if (row.type === 'show') {
    const seasons = all(`SELECT * FROM items WHERE parent_id = ? AND type = 'season' ORDER BY season_number = 0, season_number`, row.id);
    out.children = serializeMany(req.user.id, seasons);
    const next = nextUpEpisode(req.user.id, row);
    if (next) out.onDeck = serializeMany(req.user.id, [next])[0];
  }
  if (row.type === 'season') {
    const eps = all(`SELECT * FROM items WHERE parent_id = ? AND type = 'episode' ORDER BY COALESCE(episode_number, 999999), sort_title`, row.id);
    out.children = serializeMany(req.user.id, eps);
    const show = get('SELECT * FROM items WHERE id = ?', row.show_id);
    out.show = show ? serializeItem(show, { full: true }) : null; // full: the season page shows the cast
    const siblings = all(`SELECT id, title, season_number FROM items WHERE parent_id = ? AND type = 'season' ORDER BY season_number = 0, season_number`, row.show_id);
    out.seasons = siblings.map((s) => ({ id: s.id, title: s.title, seasonNumber: s.season_number }));
    const next = nextUpEpisode(req.user.id, row);
    if (next) out.onDeck = serializeMany(req.user.id, [next])[0];
  }
  if (row.type === 'episode') {
    const show = get('SELECT * FROM items WHERE id = ?', row.show_id);
    const season = get('SELECT * FROM items WHERE id = ?', row.parent_id);
    out.show = show ? serializeItem(show, { full: true }) : null;
    out.season = season ? serializeItem(season) : null;
    const { prev, next } = adjacentEpisodes(row);
    out.prev = prev ? serializeMany(req.user.id, [prev])[0] : null;
    out.next = next ? serializeMany(req.user.id, [next])[0] : null;
  }
  res.json(out);
});

// "Related" and "More with <actor>" rows on movie and show pages.
router.get('/items/:id/related', requireUser, (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(relatedFor(req.user, row));
});

// A cast member's page: their titles here, and (from TMDB) the movies they've been in that aren't.
// ?item= is the movie or show they were picked from, which tells TMDB's people with the same name apart.
router.get('/people', requireUser, async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name || name.length > 200) return res.status(400).json({ error: 'name is required' });
  let from = req.query.item ? getAccessibleItem(req.user, req.query.item) : null;
  if (from?.show_id && from.type !== 'show') from = getAccessibleItem(req.user, from.show_id);
  res.json(await personPage(req.user, name, from));
});

router.post('/items/:id/watched', requireUser, (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const count = setWatched(req.user.id, row, !!req.body?.watched);
  stateChanged(req.user.id, playableIdsUnder(row));
  res.json({ ok: true, count });
});

router.post('/items/:id/refresh', requireAdmin, async (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!tmdbConfigured()) return res.status(400).json({ error: 'Add a TMDB API key in Settings → Metadata first' });
  const matched = await refreshItem(row.id);
  regroupVersions(row.library_id); // a new match can make it a copy of another film, or not
  libraryChanged(row.library_id, { metadata: true });
  res.json({ ok: true, matched });
});

router.get('/items/:id/match', requireAdmin, async (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row || !['movie', 'show'].includes(row.type)) return res.status(404).json({ error: 'Not found' });
  if (!tmdbConfigured()) return res.status(400).json({ error: 'Add a TMDB API key in Settings → Metadata first' });
  const q = String(req.query.q || row.title);
  const year = req.query.year ? Number(req.query.year) : null;
  const results = await tmdbSearch(row.type === 'movie' ? 'movie' : 'tv', q, year);
  res.json({ results: results.map(({ raw, ...r }) => r) });
});

router.post('/items/:id/match', requireAdmin, async (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const tmdbId = Number(req.body?.tmdbId);
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return res.status(400).json({ error: 'tmdbId is required' });
  await setMatch(row.id, tmdbId);
  regroupVersions(row.library_id); // a new match can make it a copy of another film, or not
  libraryChanged(row.library_id, { metadata: true });
  res.json({ ok: true });
});

// ---------- search ----------

router.get('/search', requireUser, (req, res) => {
  const q = String(req.query.q || '').trim();
  const libIds = allowedLibraryIds(req.user);
  if (q.length < 1 || !libIds.length) return res.json({ movies: [], shows: [], episodes: [], people: [] });
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const prefix = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = all(
    `SELECT * FROM items
      WHERE library_id IN (${placeholders(libIds)}) AND type IN ('movie', 'show', 'episode') AND version_of IS NULL
        AND (title LIKE ? ESCAPE '\\' OR original_title LIKE ? ESCAPE '\\')
      ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, sort_title
      LIMIT 150`,
    ...libIds,
    like,
    like,
    prefix,
  );
  const people = all(
    `SELECT * FROM items
      WHERE library_id IN (${placeholders(libIds)}) AND type IN ('movie', 'show') AND version_of IS NULL
        AND (cast_json LIKE ? ESCAPE '\\' OR directors LIKE ? ESCAPE '\\')
      ORDER BY year DESC LIMIT 40`,
    ...libIds,
    like,
    like,
  );
  const ser = withShowInfo(serializeMany(req.user.id, rows), rows);
  res.json({
    movies: ser.filter((r) => r.type === 'movie').slice(0, 40),
    shows: ser.filter((r) => r.type === 'show').slice(0, 40),
    episodes: ser.filter((r) => r.type === 'episode').slice(0, 40),
    people: serializeMany(req.user.id, people.filter((p) => !rows.some((r) => r.id === p.id))),
  });
});

// ---------- images ----------

const IMAGE_KINDS = new Set(['poster', 'backdrop', 'thumb']);

router.get('/images/:id/:kind', requireUser, async (req, res) => {
  if (!IMAGE_KINDS.has(req.params.kind)) return res.status(404).end();
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row) return res.status(404).end();
  const width = Math.min(Math.max(Number(req.query.w) || 0, 0), 3840) || null;
  const file = await resolveItemImage(row, req.params.kind, width);
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.sendFile(file, { cacheControl: false, dotfiles: 'allow' });
});

router.get('/tmdb-image/:kind/:file', requireUser, async (req, res) => {
  if (!/^[\w-]+\.(jpg|png|webp|svg)$/.test(req.params.file)) return res.status(400).end();
  const kind = ['profile', 'poster', 'backdrop', 'thumb'].includes(req.params.kind) ? req.params.kind : 'poster';
  try {
    const file = await resolveTmdbImage(kind, `/${req.params.file}`, Number(req.query.w) || 185);
    res.setHeader('Cache-Control', 'private, max-age=2592000');
    res.sendFile(file, { cacheControl: false, dotfiles: 'allow' });
  } catch {
    res.status(404).end();
  }
});

// ---------- artwork picker (admins) ----------

// Previews go through the server: TMDB images via its cache, local files only if they belong to the item.
const artPreview = (row, kind, ref) => (ref.startsWith('tmdb:')
  ? `/api/tmdb-image/${kind}${ref.slice(5)}`
  : `/api/items/${row.id}/artwork/file?path=${encodeURIComponent(ref.slice(5))}`);

router.get('/items/:id/artwork', requireAdmin, async (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row || !ART_KINDS[row.type]) return res.status(404).json({ error: 'Not found' });
  const list = await listArtwork(row);
  for (const kind of list.kinds) for (const o of list.options[kind]) o.preview = artPreview(row, kind, o.ref);
  res.json(list);
});

router.get('/items/:id/artwork/file', requireAdmin, async (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row) return res.status(404).end();
  const file = String(req.query.path || '');
  if (!(await localArtworkFiles(row)).includes(file)) return res.status(404).end();
  const width = Math.min(Math.max(Number(req.query.w) || 0, 0), 1920) || null;
  const out = await resolveLocalImage(file, width);
  if (!out) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.sendFile(out, { cacheControl: false, dotfiles: 'allow' });
});

router.post('/items/:id/artwork', requireAdmin, async (req, res) => {
  const row = getAccessibleItem(req.user, req.params.id);
  if (!row || !ART_KINDS[row.type]) return res.status(404).json({ error: 'Not found' });
  const { kind, ref } = req.body || {};
  await setArtwork(row, String(kind), ref ?? null);
  libraryChanged(row.library_id, { metadata: true });
  const updated = get('SELECT * FROM items WHERE id = ?', row.id);
  res.json({ item: serializeItem(updated), picked: Object.keys(parseJson(updated.art_json, {}) || {}) });
});

export default router;
