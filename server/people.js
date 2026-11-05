// A person's page (a cast member picked on a movie or show): their titles on the server and, from TMDB,
// the movies they've been in that aren't on it.
import { all, placeholders } from './db.js';
import { allowedLibraryIds } from './auth.js';
import { serializeMany } from './items.js';
import { getSetting } from './settings.js';
import { sortTitle } from './scanner/parse.js';
import { tmdbConfigured, castMemberId, findPersonId, personCredits } from './metadata/tmdb.js';
import { logger } from './lib/log.js';

const log = logger('people');

// "Himself", "Self - Host", "Herself (archive footage)": appearances as themselves, not parts they played.
const SELF = /^(?:him|her|them|my|your)?self\b/i;
const OTHERS_LIMIT = 300;
const HOUR = 3600e3;

const yearOf = (date) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const tmdbUrl = (kind, ref) => (/^tmdb:\/[\w-]+\.(jpe?g|png|webp)$/i.test(ref || '') ? `/api/tmdb-image/${kind}${ref.slice(5)}` : null);

/** A small cache whose entries expire: TMDB's answers change slowly, and a page opened twice shouldn't ask twice. */
function expiringCache(max) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (hit && hit.until < Date.now()) map.delete(key);
      return hit && hit.until >= Date.now() ? hit.value : undefined;
    },
    set(key, value, ms) {
      map.delete(key);
      map.set(key, { value, until: Date.now() + ms });
      if (map.size > max) map.delete(map.keys().next().value);
    },
    clear: () => map.clear(),
  };
}

const personIds = expiringCache(1000); // name + photo → TMDB person id (0 = TMDB doesn't know them)
const filmographies = expiringCache(200); // person id + language → their credits

export function clearPeopleCache() {
  personIds.clear();
  filmographies.clear();
}

/**
 * Who they are on TMDB. A title on the server that lists them, matched on TMDB, gives their id exactly; a name
 * search is the last resort (the same photo picks the right one of several people with that name).
 */
async function tmdbPersonId(name, profileRef, castRows, from) {
  const known = (castRows.find((r) => r.id === from?.id && r.cast_tmdb) || castRows.find((r) => r.cast_tmdb))?.cast_tmdb;
  if (known) return Number(known);
  const key = `${name.toLowerCase()}\n${profileRef || ''}`;
  const cached = personIds.get(key);
  if (cached !== undefined) return cached || null;
  let id = null;
  const sources = castRows.filter((r) => r.tmdb_id).sort((a, b) => (b.id === from?.id) - (a.id === from?.id));
  for (const r of sources.slice(0, 2)) {
    id = await castMemberId(r.type, r.tmdb_id, name);
    if (id) break;
  }
  id ||= await findPersonId(name, profileRef);
  personIds.set(key, id || 0, id ? 30 * 24 * HOUR : HOUR);
  return id;
}

async function filmography(personId) {
  const key = `${personId}:${getSetting('metadataLanguage') || 'en-US'}`;
  let film = filmographies.get(key);
  if (film === undefined) {
    film = await personCredits(personId);
    filmographies.set(key, film, film ? 12 * HOUR : HOUR);
  }
  return film;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole years from a YYYY-MM-DD date to another one, or to today (null when a date isn't readable). */
export function yearsBetween(from, to = null, today = new Date()) {
  const a = DATE.exec(from || '');
  const b = to ? DATE.exec(to) : [null, today.getFullYear(), today.getMonth() + 1, today.getDate()];
  if (!a || !b) return null;
  const years = b[1] - a[1] - (b[2] * 100 + +b[3] < a[2] * 100 + +a[3] ? 1 : 0);
  return years >= 0 ? years : null;
}

/** Which of their TMDB credits are on the server (in `libIds`): "kind:tmdbId" → item id. */
function onServer(credits, libIds) {
  const out = new Map();
  const inLibs = `library_id IN (${placeholders(libIds)})`;
  for (const kind of ['movie', 'show']) {
    const ids = [...new Set(credits.filter((c) => c.kind === kind).map((c) => c.tmdbId))];
    if (!ids.length) continue;
    for (const r of all(`SELECT id, tmdb_id FROM items WHERE type = ? AND ${inLibs} AND version_of IS NULL AND tmdb_id IN (${placeholders(ids)})`, kind, ...libIds, ...ids)) {
      out.set(`${kind}:${r.tmdb_id}`, r.id);
    }
  }
  // Titles that aren't matched on TMDB: by title and year.
  const unmatched = all(`SELECT id, type, sort_title, year FROM items WHERE type IN ('movie', 'show') AND ${inLibs} AND tmdb_id IS NULL AND version_of IS NULL`, ...libIds);
  if (unmatched.length) {
    const byTitle = Map.groupBy(unmatched, (r) => `${r.type}:${r.sort_title}`);
    for (const c of credits) {
      const key = `${c.kind}:${c.tmdbId}`;
      const year = yearOf(c.date);
      if (out.has(key) || !year) continue;
      const hit = byTitle.get(`${c.kind}:${sortTitle(c.title)}`)?.find((r) => !r.year || Math.abs(r.year - year) <= 1);
      if (hit) out.set(key, hit.id);
    }
  }
  return out;
}

/**
 * @param user  the signed-in user: only their libraries count as "on the server"
 * @param name  the person's name as cast lists have it
 * @param from  the movie or show row they were picked from (optional): finds them on TMDB exactly
 * @returns {{ name, profile, info, items: object[], others: { status, items: { tmdbId, title, year, role, poster }[] } }}
 *   info:   from TMDB, { biography, birthday, deathday, birthplace, age } (dates YYYY-MM-DD; age at death if they've
 *           died; any of them may be null), or null when TMDB isn't asked or doesn't know them
 *   items:  their movies and shows on the server, newest first, each with the part they played (`role`) and
 *           `directed: true` on ones they directed
 *   others: movies they've acted in that aren't on the server, newest first; status is 'ok', 'off' (no TMDB key),
 *           'unknown' (TMDB doesn't know them) or 'failed' (TMDB couldn't be asked)
 */
export async function personPage(user, name, from = null) {
  const libIds = allowedLibraryIds(user);
  const inLibs = libIds.length ? `i.library_id IN (${placeholders(libIds)})` : '0';
  const castRows = all(
    `SELECT i.*, json_extract(c.value, '$.role') AS cast_role, json_extract(c.value, '$.profile') AS cast_profile,
            json_extract(c.value, '$.tmdbId') AS cast_tmdb
       FROM items i, json_each(i.cast_json) c
      WHERE i.type IN ('movie', 'show') AND ${inLibs} AND i.version_of IS NULL AND json_extract(c.value, '$.name') = ?
      GROUP BY i.id`,
    ...libIds,
    name,
  );
  const directed = all(
    `SELECT i.* FROM items i, json_each(i.directors) d
      WHERE i.type IN ('movie', 'show') AND ${inLibs} AND i.version_of IS NULL AND d.value = ?
      GROUP BY i.id`,
    ...libIds,
    name,
  );
  const found = new Map(); // item id → { row, role, directed }
  for (const r of castRows) found.set(r.id, { row: r, role: r.cast_role || null });
  for (const r of directed) {
    if (found.has(r.id)) found.get(r.id).directed = true;
    else found.set(r.id, { row: r, role: null, directed: true });
  }
  let profileRef = (castRows.find((r) => r.id === from?.id && r.cast_profile) || castRows.find((r) => r.cast_profile))?.cast_profile || null;

  const others = { status: 'off', items: [] };
  let info = null;
  if (tmdbConfigured()) {
    try {
      const personId = await tmdbPersonId(name, profileRef, castRows, from);
      const film = personId ? await filmography(personId) : null;
      if (!film) {
        others.status = 'unknown';
      } else {
        others.status = 'ok';
        profileRef ||= film.profile;
        const { biography, birthday, deathday, birthplace } = film;
        if (biography || birthday || deathday || birthplace) {
          info = { biography, birthday, deathday, birthplace, age: yearsBetween(birthday, deathday) };
        }
        const credits = film.credits.filter((c) => !SELF.test(c.role || ''));
        const here = libIds.length ? onServer(credits, libIds) : new Map();
        // On the server but not in its cast list (which keeps the first 20 billed): add them, with their part.
        const missing = new Map();
        for (const c of credits) {
          const id = here.get(`${c.kind}:${c.tmdbId}`);
          if (id == null) continue;
          if (found.has(id)) found.get(id).role ||= c.role;
          else if (!missing.has(id)) missing.set(id, c.role);
        }
        if (missing.size) {
          for (const r of all(`SELECT * FROM items WHERE id IN (${placeholders([...missing.keys()])})`, ...missing.keys())) {
            found.set(r.id, { row: r, role: missing.get(r.id) });
          }
        }
        // The rest of their movies, one entry per movie (someone can play two parts in one).
        const byId = new Map();
        for (const c of credits) {
          if (c.kind !== 'movie' || here.has(`movie:${c.tmdbId}`)) continue;
          const seen = byId.get(c.tmdbId);
          if (seen) {
            if (c.role && !seen.roles.includes(c.role)) seen.roles.push(c.role);
          } else {
            byId.set(c.tmdbId, { ...c, roles: c.role ? [c.role] : [] });
          }
        }
        others.items = [...byId.values()]
          .sort((a, b) => (b.date || '').localeCompare(a.date || '')) // newest first; undated last
          .slice(0, OTHERS_LIMIT)
          .map((c) => ({ tmdbId: c.tmdbId, title: c.title, year: yearOf(c.date), role: c.roles.join(' / ') || null, poster: tmdbUrl('poster', c.poster) }));
      }
    } catch (err) {
      log.warn(`Couldn't get ${name}'s films from TMDB: ${err.message}`);
      others.status = 'failed';
    }
  }

  const entries = [...found.values()].sort((a, b) => (b.row.year || 0) - (a.row.year || 0)
    || String(a.row.sort_title || '').localeCompare(String(b.row.sort_title || '')));
  const items = serializeMany(user.id, entries.map((e) => e.row));
  items.forEach((it, i) => {
    it.role = entries[i].role || null;
    if (entries[i].directed) it.directed = true;
  });
  return { name, profile: tmdbUrl('profile', profileRef), info, items, others };
}
