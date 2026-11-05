// Copies of one film in a library (an SD and an HD file, say) shown as one film. The best copy stands for the film:
// lists, Kodi and the Play button use it. The others point at it with `version_of`, are left out of lists, and are
// offered as versions on its page. Watch state lives on the best copy, whichever copy was played.
import { all, run, tx, placeholders } from './db.js';
import { resolutionLabel } from './items.js';

/** What makes two films the same: their TMDB match, or (not matched) their title and year. Null: nothing to go on. */
export function versionKey(row) {
  if (row.tmdb_id) return `tmdb:${row.tmdb_id}`;
  if (row.year && row.sort_title) return `title:${row.sort_title}|${row.year}`;
  return null;
}

// The picture's height as a 16:9 frame, so a wide 1920×800 film counts as 1080p (as resolutionLabel does).
const lines = (r) => (r.width && r.height ? Math.max(r.height, Math.round((r.width * 9) / 16)) : 0);

/** Best first: the sharper picture, then the higher bitrate, then the bigger file; the first copy added on a tie. */
export function rankVersions(rows) {
  return [...rows].sort((a, b) => lines(b) - lines(a) || (b.bitrate || 0) - (a.bitrate || 0)
    || (b.file_size || 0) - (a.file_size || 0) || a.id - b.id);
}

/** The item whose watch state a film's copy uses: the film's best copy. */
export function stateItemId(row) {
  return row.version_of ?? row.id;
}

/**
 * Moves one item's watch state onto another, per person: watched if either was, both copies' views counted, and
 * the resume point that was set last.
 */
function moveState(fromId, toId) {
  run(
    `INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at)
       SELECT user_id, ?, position, watched, view_count, updated_at FROM user_state WHERE item_id = ?
     ON CONFLICT(user_id, item_id) DO UPDATE SET
       position = CASE WHEN excluded.updated_at > user_state.updated_at THEN excluded.position ELSE user_state.position END,
       watched = MAX(user_state.watched, excluded.watched),
       view_count = user_state.view_count + excluded.view_count,
       updated_at = MAX(user_state.updated_at, excluded.updated_at)`,
    toId,
    fromId,
  );
  run('DELETE FROM user_state WHERE item_id = ?', fromId);
}

const ART_KINDS = ['poster', 'backdrop', 'thumb'];

/**
 * Sorts a movie library's films into versions: run after a scan, after metadata is fetched, and after a match is
 * fixed. A copy that becomes the best one takes over the film's watch state and any artwork an admin picked.
 * Returns how many items changed.
 */
export function regroupVersions(libraryId) {
  const rows = all(
    `SELECT id, tmdb_id, sort_title, year, width, height, bitrate, file_size, version_of, art_json, poster, backdrop, thumb
       FROM items WHERE library_id = ? AND type = 'movie'`,
    libraryId,
  );
  const groups = new Map();
  for (const r of rows) {
    const key = versionKey(r);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const want = new Map(rows.map((r) => [r.id, null]));
  const bestOf = new Map(); // id → the best copy of its group
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [best, ...others] = rankVersions(group);
    for (const o of others) {
      want.set(o.id, best.id);
      bestOf.set(o.id, best);
    }
  }
  const changed = rows.filter((r) => (r.version_of ?? null) !== want.get(r.id));
  if (!changed.length) return 0;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const touched = new Set();
  const now = Date.now();
  tx(() => {
    for (const r of changed) {
      const best = bestOf.get(r.id);
      touched.add(r.id);
      if (r.version_of != null) touched.add(r.version_of); // its film's old best copy: one version fewer
      if (best) {
        touched.add(best.id);
        moveState(r.id, best.id);
        // An admin's artwork choices stay with the film when a better copy takes over.
        if (!best.art_json && r.art_json) {
          const picked = JSON.parse(r.art_json) || {};
          const kinds = ART_KINDS.filter((k) => picked[k]);
          if (kinds.length) {
            run(`UPDATE items SET ${kinds.map((k) => `${k} = ?`).join(', ')}, art_json = ? WHERE id = ?`,
              ...kinds.map((k) => r[k]), r.art_json, best.id);
            best.art_json = r.art_json;
          }
        }
      }
      run('UPDATE items SET version_of = ? WHERE id = ?', want.get(r.id), r.id);
    }
    // Changed films look new to whoever keeps a copy of the list (the Kodi add-on, the app's cache).
    const ids = [...touched].filter((id) => byId.has(id));
    run(`UPDATE items SET updated_at = ? WHERE id IN (${placeholders(ids)})`, now, ...ids);
  });
  return changed.length;
}

/** Before items are deleted: a film's best copy hands its watch state to the best of the copies that stay. */
export function keepStateOfRemoved(ids) {
  const gone = new Set(ids);
  for (const id of ids) {
    const heirs = all('SELECT id, width, height, bitrate, file_size FROM items WHERE version_of = ?', id).filter((r) => !gone.has(r.id));
    if (heirs.length) moveState(id, rankVersions(heirs)[0].id);
  }
}

/** A film's copies, best first, as its page lists them; one copy (or not a film): an empty list. */
export function versionsOf(row) {
  if (row.type !== 'movie') return [];
  const bestId = stateItemId(row);
  const copies = all('SELECT * FROM items WHERE id = ? OR version_of = ?', bestId, bestId);
  if (copies.length < 2) return [];
  return rankVersions(copies);
}

/** One copy as a film's page offers it. */
export function versionOut(row) {
  return {
    id: row.id,
    label: resolutionLabel(row.width, row.height) || 'Unknown',
    width: row.width,
    height: row.height,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    container: row.container,
    duration: row.duration,
    bitrate: row.bitrate,
    fileSize: row.file_size,
  };
}

/** Every movie library's films sorted into versions (on start, so an upgrade shows them straight away). */
export function regroupAllVersions() {
  let n = 0;
  for (const lib of all("SELECT id FROM libraries WHERE type = 'movie'")) n += regroupVersions(lib.id);
  return n;
}
