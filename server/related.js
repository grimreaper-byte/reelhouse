// "Related" and "More with <actor>" rows for movie and show pages. Computed from metadata the
// server already has (genres, directors/creators, cast, studio, year), so it works offline and
// only ever suggests titles that are actually on the server.
import { all, get, placeholders, parseJson } from './db.js';
import { allowedLibraryIds } from './auth.js';
import { serializeMany } from './items.js';

const ROW_LIMIT = 20;
const MIN_SCORE = 2;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** The parts of an item that similarity looks at. */
export function features(row) {
  return {
    id: row.id,
    genres: new Set(parseJson(row.genres, []).map(norm).filter(Boolean)),
    directors: new Set(parseJson(row.directors, []).map(norm).filter(Boolean)),
    cast: parseJson(row.cast_json, []).map((c) => norm(c?.name)).filter(Boolean), // billing order
    studio: norm(row.studio),
    year: row.year || null,
    rating: row.rating || 0,
  };
}

/** How alike two titles are (0 = unrelated). */
export function similarity(a, b) {
  let score = 0;
  if (a.genres.size && b.genres.size) {
    const shared = [...a.genres].filter((g) => b.genres.has(g)).length;
    score += (6 * shared) / new Set([...a.genres, ...b.genres]).size; // Jaccard, scaled to 0–6
  }
  for (const d of a.directors) if (b.directors.has(d)) score += 4;
  let castScore = 0;
  a.cast.slice(0, 10).forEach((name, i) => {
    const j = b.cast.indexOf(name);
    if (j >= 0 && j < 10) castScore += i < 3 && j < 3 ? 3 : 1.5; // co-leads count most
  });
  score += Math.min(castScore, 6);
  if (a.studio && a.studio === b.studio) score += 1;
  if (a.year && b.year) {
    const gap = Math.abs(a.year - b.year);
    if (gap <= 3) score += 1;
    else if (gap <= 8) score += 0.5;
  }
  return score;
}

// Parsed candidates per (type, libraries), rebuilt when the library changes.
const cache = new Map();

function candidates(type, libIds) {
  const key = `${type}:${libIds.join(',')}`;
  const where = `type = ? AND library_id IN (${placeholders(libIds)}) AND version_of IS NULL`;
  const { n, t } = get(`SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM items WHERE ${where}`, type, ...libIds);
  const stamp = `${n}:${t}`;
  const hit = cache.get(key);
  if (hit?.stamp === stamp) return hit.list;
  const list = all(`SELECT id, genres, directors, cast_json, studio, year, rating FROM items WHERE ${where}`, type, ...libIds)
    .map(features);
  cache.set(key, { stamp, list });
  return list;
}

function loadInOrder(userId, ids) {
  if (!ids.length) return [];
  const rows = all(`SELECT * FROM items WHERE id IN (${placeholders(ids)})`, ...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  return serializeMany(userId, ordered);
}

/**
 * @returns {{ similar: object[], byCast: { name, profile, items }[] }}
 *   similar: titles of the same type, most alike first
 *   byCast:  for the first two billed cast members, their other movies and shows on the server
 */
export function relatedFor(user, item) {
  const result = { similar: [], byCast: [] };
  if (item.type !== 'movie' && item.type !== 'show') return result;
  const libIds = allowedLibraryIds(user);
  if (!libIds.length) return result;

  const me = features(item);
  const ranked = candidates(item.type, libIds)
    .filter((c) => c.id !== item.id)
    .map((c) => ({ c, score: similarity(me, c) }))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((x, y) => y.score - x.score || y.c.rating - x.c.rating)
    .slice(0, ROW_LIMIT);
  result.similar = loadInOrder(user.id, ranked.map((s) => s.c.id));

  for (const person of parseJson(item.cast_json, []).slice(0, 2)) {
    if (!person?.name) continue;
    const rows = all(
      `SELECT i.*, json_extract(c.value, '$.role') AS cast_role
         FROM items i, json_each(i.cast_json) c
        WHERE i.type IN ('movie', 'show') AND i.id != ? AND i.library_id IN (${placeholders(libIds)})
          AND json_extract(c.value, '$.name') = ?
        GROUP BY i.id
        ORDER BY i.type = ? DESC, i.year DESC
        LIMIT ${ROW_LIMIT}`,
      item.id,
      ...libIds,
      person.name,
      item.type,
    );
    if (!rows.length) continue;
    const items = serializeMany(user.id, rows);
    rows.forEach((r, i) => {
      items[i].role = r.cast_role || null;
    });
    result.byCast.push({
      name: person.name,
      profile: person.profile?.startsWith('tmdb:') ? `/api/tmdb-image/profile${person.profile.slice(5)}` : null,
      items,
    });
  }
  return result;
}
