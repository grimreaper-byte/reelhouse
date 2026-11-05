// Library sync for apps that keep their own copy of the library (the Kodi add-on): a cheap list of every item
// with a checksum and the user's watch state, full details for the items that changed, and states on their own.
import { Router } from 'express';
import path from 'node:path';
import { all, get, placeholders, parseJson } from '../db.js';
import { requireUser, allowedLibraryIds, canAccessLibrary } from '../auth.js';
import { serializeItem, statesFor } from '../items.js';
import { getSetting } from '../settings.js';
import { VERSION } from '../version.js';
import { LIBRARY_ORDER } from '../libraries.js';

const router = Router();
const MAX_DETAILS = 200;
const MAX_STATES = 2000;

// Parents before children, so an app can create shows, then seasons, then episodes.
const TYPE_ORDER = "CASE type WHEN 'show' THEN 0 WHEN 'season' THEN 1 ELSE 2 END";

const stateOf = (s) => (s
  ? { watched: !!s.watched, viewCount: s.view_count || 0, position: s.position || 0, updatedAt: s.updated_at }
  : { watched: false, viewCount: 0, position: 0, updatedAt: null });

/** What a player needs to show stream flags (codec, resolution, channels, languages). */
function streamsOf(row) {
  const media = parseJson(row.media_json, null);
  if (!media) return null;
  const v = media.video;
  return {
    video: v ? {
      codec: v.codec || null,
      width: v.width || null,
      height: v.height || null,
      aspect: v.width && v.height ? Math.round((v.width / v.height) * 1e6) / 1e6 : null,
      hdr: v.hdr || null,
    } : null,
    audio: (media.audio || []).map((a) => ({ codec: a.codec || null, channels: a.channels || null, language: a.language || null })),
    subtitles: [
      ...(media.subtitles || []).map((s) => s.language || null),
      ...parseJson(row.subs_json, []).map((s) => s.language || null),
    ].map((language) => ({ language })),
  };
}

function details(row, state) {
  return {
    ...serializeItem(row, { state, full: true }),
    state: stateOf(state),
    premiered: row.air_date || null,
    checksum: String(row.updated_at),
    file: row.file_path ? { name: path.basename(row.file_path), size: row.file_size || null, container: row.container || null } : null,
    streams: row.type === 'movie' || row.type === 'episode' ? streamsOf(row) : null,
  };
}

const idList = (body, max) => {
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  return [...new Set(ids)].slice(0, max);
};

router.get('/sync/libraries', requireUser, (req, res) => {
  const ids = allowedLibraryIds(req.user);
  const libraries = ids.length
    ? all(`SELECT id, name, type, scanned_at FROM libraries WHERE id IN (${placeholders(ids)}) ORDER BY ${LIBRARY_ORDER}`, ...ids)
      .map((l) => ({ id: l.id, name: l.name, type: l.type, scannedAt: l.scanned_at }))
    : [];
  res.json({ server: { name: getSetting('serverName'), version: VERSION }, user: { id: req.user.id, username: req.user.username }, libraries });
});

// Every item in a library with a checksum (changes whenever its metadata or artwork does) and the user's state.
router.get('/sync/libraries/:id/items', requireUser, (req, res) => {
  const libraryId = Number(req.params.id);
  if (!get('SELECT 1 FROM libraries WHERE id = ?', libraryId) || !canAccessLibrary(req.user, libraryId)) {
    return res.status(404).json({ error: 'No such library' });
  }
  // A film once, as its best copy (server/versions.js), which is what Kodi plays.
  const rows = all(`SELECT id, type, parent_id, show_id, updated_at FROM items WHERE library_id = ? AND version_of IS NULL ORDER BY ${TYPE_ORDER}, id`, libraryId);
  const states = statesFor(req.user.id, rows.filter((r) => r.type === 'movie' || r.type === 'episode').map((r) => r.id));
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      parentId: r.parent_id,
      showId: r.show_id,
      checksum: String(r.updated_at),
      ...(r.type === 'movie' || r.type === 'episode' ? { state: stateOf(states.get(r.id)) } : {}),
    })),
  });
});

// Full details for up to 200 items (only ones the user can see; others are left out).
router.post('/sync/items', requireUser, (req, res) => {
  const ids = idList(req.body, MAX_DETAILS);
  const libs = allowedLibraryIds(req.user);
  if (!ids.length || !libs.length) return res.json({ items: [] });
  const rows = all(
    `SELECT * FROM items WHERE id IN (${placeholders(ids)}) AND library_id IN (${placeholders(libs)}) ORDER BY ${TYPE_ORDER}, id`,
    ...ids,
    ...libs,
  );
  const states = statesFor(req.user.id, rows.map((r) => r.id));
  res.json({ items: rows.map((r) => details(r, states.get(r.id))) });
});

// Watch states only (after a "state" live event, or to refresh play counts cheaply).
router.post('/sync/states', requireUser, (req, res) => {
  const ids = idList(req.body, MAX_STATES);
  const libs = allowedLibraryIds(req.user);
  if (!ids.length || !libs.length) return res.json({ states: [] });
  const rows = all(`SELECT id FROM items WHERE id IN (${placeholders(ids)}) AND library_id IN (${placeholders(libs)})`, ...ids, ...libs);
  const states = statesFor(req.user.id, rows.map((r) => r.id));
  res.json({ states: rows.map((r) => ({ id: r.id, state: stateOf(states.get(r.id)) })) });
});

export default router;
