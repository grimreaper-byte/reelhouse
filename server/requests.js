// Requests: films people would like on the server, picked from TMDB. One request per film (whoever asked first);
// everyone sees the list, people remove their own and admins any or all. A request goes by itself once its film is in
// a library the person who asked can open (fulfilRequests: after each scan's metadata, and whenever the list is read).
// It's off until a TMDB API key is set up (a fresh install), which finding films needs, and an admin can turn it off
// (Settings → General): either way it's hidden everywhere and the list is kept for later.
import { all, get, run } from './db.js';
import { canAccessLibrary, loadUser } from './auth.js';
import { requestsChanged } from './events.js';
import { movieSummary, search, tmdbConfigured } from './metadata/tmdb.js';
import { getSetting } from './settings.js';
import { logger } from './lib/log.js';

const log = logger('requests');

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const posterUrl = (path) => (path ? `/api/tmdb-image/poster${path}` : null);
const avatarUrl = (row) => (row.avatar_at ? `/api/users/${row.user_id}/avatar?v=${row.avatar_at}` : null);

export const requestCount = () => get('SELECT COUNT(*) AS n FROM requests').n;

/** Whether Requests is on: a TMDB API key is set up (it comes on by itself once one is), and an admin hasn't turned it off. */
export const requestsOn = () => !!getSetting('requestsEnabled') && tmdbConfigured();

/**
 * How many requests this person may have waiting at once (Settings → General), and how many they have: { max, open },
 * or null when there's no limit for them (none set, or an admin). A request stops counting once its film arrives or
 * it's removed.
 */
export function requestLimit(user) {
  const max = Number(getSetting('requestsLimit')) || 0;
  if (!max || user.isAdmin) return null;
  return { max, open: get('SELECT COUNT(*) AS n FROM requests WHERE user_id = ?', user.id).n };
}

const atLimit = (user) => {
  const limit = requestLimit(user);
  return limit && limit.open >= limit.max ? limit : null;
};
const limitMessage = ({ max }) => `You already have ${max} request${max === 1 ? '' : 's'} waiting, the most each person can have. `
  + 'You can ask for another once one of those films arrives, or if you remove one of your requests.';

/**
 * What pages and apps are told (/api/me, the "requests" event): whether Requests is on, how many films are asked for,
 * and whether films can be found to ask for (TMDB is set up). Off, it's nothing and no count, so apps that don't know
 * the switch hide it too.
 */
export const requestsAccess = () => (requestsOn()
  ? { enabled: true, count: requestCount(), available: true }
  : { enabled: false, count: 0, available: false });

/** Tells everyone's pages and apps (the sidebar's row and count, an open Requests page). */
export const announceRequests = () => requestsChanged(requestsAccess());

/** The film with this TMDB id in a library this user can open (its main copy's item id), or null. */
export function itemForFilm(user, tmdbId) {
  const rows = all("SELECT id, library_id, version_of FROM items WHERE type = 'movie' AND tmdb_id = ?", tmdbId);
  const row = rows.find((r) => canAccessLibrary(user, r.library_id));
  return row ? row.version_of || row.id : null;
}

const SELECT = `SELECT r.*, u.username, u.avatar_at FROM requests r JOIN users u ON u.id = r.user_id`;

function serialize(row, user) {
  return {
    id: row.id,
    tmdbId: row.tmdb_id,
    title: row.title,
    year: row.year,
    poster: posterUrl(row.poster),
    overview: row.overview,
    requestedAt: row.created_at,
    user: { id: row.user_id, username: row.username, avatar: avatarUrl(row) },
    // Your own, or any for an admin.
    canRemove: row.user_id === user.id || user.isAdmin,
  };
}

/** Every request, newest first, as this user sees them. */
export function listRequests(user) {
  return all(`${SELECT} ORDER BY r.created_at DESC, r.id DESC`).map((row) => serialize(row, user));
}

/**
 * Films matching a search, from TMDB, each with what's already true of it for this user: on the server (the item to
 * open) or requested (by whom). A trailing year ("Heat 1995" or "Heat (1995)") narrows it down.
 */
export async function searchFilms(user, query) {
  if (!tmdbConfigured()) throw fail(503, 'Requests need a TMDB API key (Settings → Metadata)');
  const m = /^(.*?)\s*\(?((?:19|20)\d\d)\)?$/.exec(query.trim());
  const results = await search('movie', m && m[1] ? m[1] : query.trim(), m && m[1] ? Number(m[2]) : undefined);
  const requested = new Map(all(`${SELECT}`).map((row) => [row.tmdb_id, row]));
  return results.slice(0, 12).map((r) => {
    const path = /^\/[\w-]+\.(jpe?g|png|webp)$/i.test(r.raw.poster_path || '') ? r.raw.poster_path : null;
    const req = requested.get(r.tmdbId);
    return {
      tmdbId: r.tmdbId,
      title: r.title,
      year: r.year,
      poster: posterUrl(path),
      overview: r.overview || null,
      onServer: itemForFilm(user, r.tmdbId),
      request: req ? { id: req.id, username: req.username, mine: req.user_id === user.id } : null,
    };
  });
}

/** Asks for a film. Refused when it's already on the server for this user or someone already asked for it. */
export async function addRequest(user, tmdbId) {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) throw fail(400, 'Which film? (a TMDB id)');
  if (!tmdbConfigured()) throw fail(503, 'Requests need a TMDB API key (Settings → Metadata)');
  const asked = get(`${SELECT} WHERE r.tmdb_id = ?`, tmdbId);
  if (asked) throw fail(409, asked.user_id === user.id ? 'You’ve already asked for it' : `${asked.username} has already asked for it`);
  const itemId = itemForFilm(user, tmdbId);
  if (itemId) throw fail(409, 'It’s already on the server', { itemId });
  let limit = atLimit(user);
  if (limit) throw fail(403, limitMessage(limit), { limit: true });
  const film = await movieSummary(tmdbId);
  if (!film) throw fail(404, 'TMDB doesn’t know that film');
  // Counted again now: another request of theirs may have been made while TMDB was answering.
  limit = atLimit(user);
  if (limit) throw fail(403, limitMessage(limit), { limit: true });
  try {
    run('INSERT INTO requests (tmdb_id, title, year, poster, overview, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      film.tmdbId, film.title, film.year, film.posterPath, film.overview, user.id, Date.now());
  } catch (err) {
    // Someone else asked for it while TMDB was answering.
    if (/UNIQUE/.test(err.message)) throw fail(409, 'Someone has just asked for it');
    throw err;
  }
  log.info(`User "${user.username}" asked for "${film.title}"${film.year ? ` (${film.year})` : ''}`);
  announceRequests();
  return serialize(get(`${SELECT} WHERE r.tmdb_id = ?`, film.tmdbId), user);
}

/** Removes a request: your own, or any for an admin. */
export function removeRequest(user, id) {
  const row = get(`${SELECT} WHERE r.id = ?`, Number(id));
  if (!row) throw fail(404, 'No such request');
  if (row.user_id !== user.id && !user.isAdmin) throw fail(403, 'Only the person who asked, or an admin, can remove it');
  run('DELETE FROM requests WHERE id = ?', row.id);
  const whose = row.user_id === user.id ? 'their' : `${row.username}'s`;
  log.info(`User "${user.username}" removed ${whose} request for "${row.title}"`);
  announceRequests();
}

/** Removes every request (admins). How many there were. */
export function removeAllRequests(user) {
  const n = Number(run('DELETE FROM requests').changes);
  if (n) {
    log.info(`User "${user.username}" removed all ${n} request${n === 1 ? '' : 's'}`);
    announceRequests();
  }
  return n;
}

/** Removes the requests whose film is now in a library the person who asked can open. How many went. */
export function fulfilRequests() {
  const rows = all(`SELECT r.id, r.title, r.user_id, u.username, i.library_id, l.name AS library
                      FROM requests r
                      JOIN users u ON u.id = r.user_id
                      JOIN items i ON i.tmdb_id = r.tmdb_id AND i.type = 'movie'
                      JOIN libraries l ON l.id = i.library_id`);
  const users = new Map();
  const done = new Set();
  for (const r of rows) {
    if (done.has(r.id)) continue;
    if (!users.has(r.user_id)) users.set(r.user_id, loadUser(r.user_id));
    if (!canAccessLibrary(users.get(r.user_id), r.library_id)) continue;
    run('DELETE FROM requests WHERE id = ?', r.id);
    done.add(r.id);
    log.info(`"${r.title}", asked for by ${r.username}, is now in ${r.library}: the request is done`);
  }
  if (done.size) announceRequests();
  return done.size;
}
