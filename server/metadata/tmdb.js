// Online metadata from The Movie Database (free API key: https://www.themoviedb.org/settings/api).
import { all, get, run, tx } from '../db.js';
import { getSetting } from '../settings.js';
import { sortTitle } from '../scanner/parse.js';
import { withNfo } from '../scanner/local.js';
import { createLimiter } from '../lib/limit.js';
import { logger } from '../lib/log.js';

const log = logger('tmdb');
const API = 'https://api.themoviedb.org/3';

export const tmdbConfigured = () => !!getSetting('tmdbApiKey');

async function tmdb(pathname, params = {}) {
  const key = getSetting('tmdbApiKey');
  if (!key) throw new Error('TMDB API key is not configured');
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
  if (!url.searchParams.has('language')) url.searchParams.set('language', getSetting('metadataLanguage') || 'en-US');
  const headers = { accept: 'application/json' };
  // v4 "read access tokens" are JWTs; v3 keys are 32 hex chars.
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    if (res.status === 429 && attempt < 4) {
      const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 401) throw new Error('TMDB rejected the API key');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`TMDB ${res.status} for ${pathname}`);
    return res.json();
  }
}

export async function testApiKey() {
  await tmdb('/configuration');
  return true;
}

const yearOf = (date) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const country = () => (getSetting('metadataLanguage') || 'en-US').split('-')[1] || 'US';
const img = (p) => (p ? `tmdb:${p}` : null);
const isLocal = (ref) => typeof ref === 'string' && ref.startsWith('file:');

/** Artwork an admin chose by hand ({ poster, backdrop, thumb } refs); refreshes leave those alone. */
function pickedArt(row) {
  try {
    return JSON.parse(row.art_json || '{}') || {};
  } catch {
    return {};
  }
}

/** The artwork ref to store: a hand-picked one stays; otherwise local files win if preferred, then TMDB's. */
function artFor(row, kind, tmdbPath, preferLocal) {
  if (pickedArt(row)[kind]) return row[kind];
  return preferLocal && isLocal(row[kind]) ? row[kind] : img(tmdbPath) || row[kind];
}

function pickBest(results, title, year, kind) {
  if (!results?.length) return null;
  const want = sortTitle(title);
  let best = null;
  let bestScore = -Infinity;
  results.slice(0, 10).forEach((r, i) => {
    const names = kind === 'movie' ? [r.title, r.original_title] : [r.name, r.original_name];
    const ry = yearOf(kind === 'movie' ? r.release_date : r.first_air_date);
    let score = -i * 0.5; // TMDB's own relevance ordering
    if (names.some((n) => n && sortTitle(n) === want)) score += 4;
    if (year && ry) score += ry === year ? 4 : Math.abs(ry - year) === 1 ? 2 : -2;
    score += Math.min(Math.log10((r.popularity || 0) + 1), 2) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  });
  return best;
}

export async function search(kind, query, year) {
  const endpoint = kind === 'movie' ? '/search/movie' : '/search/tv';
  const params = { query, include_adult: false };
  if (year) params[kind === 'movie' ? 'year' : 'first_air_date_year'] = year;
  let data = await tmdb(endpoint, params);
  if (year && !data?.results?.length) data = await tmdb(endpoint, { query, include_adult: false });
  return (data?.results || []).map((r) => ({
    tmdbId: r.id,
    title: kind === 'movie' ? r.title : r.name,
    originalTitle: kind === 'movie' ? r.original_title : r.original_name,
    year: yearOf(kind === 'movie' ? r.release_date : r.first_air_date),
    overview: r.overview,
    // Through the server's image cache: the page's Content-Security-Policy only allows its own images.
    poster: /^\/[\w-]+\.(jpe?g|png|webp)$/i.test(r.poster_path || '') ? `/api/tmdb-image/poster${r.poster_path}?w=154` : null,
    popularity: r.popularity,
    raw: r,
  }));
}

/** A TV show's series posters on TMDB: { series number: poster path } for those that have one. */
export async function tvSeasonPosters(tmdbId) {
  const show = await tmdb(`/tv/${tmdbId}`);
  return Object.fromEntries((show?.seasons || []).filter((s) => s.poster_path).map((s) => [s.season_number, s.poster_path]));
}

/** One series' episode stills on TMDB: { episode number: still path } for those that have one. */
export async function tvEpisodeStills(tmdbId, season) {
  const data = await tmdb(`/tv/${tmdbId}/season/${season}`);
  return Object.fromEntries((data?.episodes || []).filter((e) => e.still_path).map((e) => [e.episode_number, e.still_path]));
}

/** A film's title, year, poster path and overview (what a request keeps), or null when TMDB doesn't know the id. */
export async function movieSummary(tmdbId) {
  const m = await tmdb(`/movie/${tmdbId}`);
  if (!m?.id) return null;
  return {
    tmdbId: m.id,
    title: m.title || m.original_title,
    year: yearOf(m.release_date),
    posterPath: /^\/[\w-]+\.(jpe?g|png|webp)$/i.test(m.poster_path || '') ? m.poster_path : null,
    overview: m.overview || null,
  };
}

function castOf(credits) {
  return (credits?.cast || []).slice(0, 20).map((c) => ({
    name: c.name,
    role: c.character || null,
    profile: img(c.profile_path),
    ...(c.id ? { tmdbId: c.id } : {}), // for their page's filmography
  }));
}

function setFields(id, fields) {
  const cols = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!cols.length) return;
  run(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), id);
}

async function applyMovie(item, tmdbId) {
  const m = await tmdb(`/movie/${tmdbId}`, { append_to_response: 'credits,release_dates' });
  if (!m) return false;
  const preferLocal = getSetting('preferLocalArtwork');
  const cert = m.release_dates?.results
    ?.find((r) => r.iso_3166_1 === country())
    ?.release_dates?.find((d) => d.certification)?.certification;
  // Values from the item's .nfo (if any) win over TMDB's.
  setFields(item.id, withNfo({
    tmdb_id: m.id,
    imdb_id: m.imdb_id || item.imdb_id,
    title: m.title || item.title,
    sort_title: sortTitle(m.title || item.title),
    original_title: m.original_title !== m.title ? m.original_title : null,
    year: yearOf(m.release_date) || item.year,
    overview: m.overview || item.overview,
    tagline: m.tagline || null,
    rating: m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    content_rating: cert || item.content_rating,
    genres: JSON.stringify((m.genres || []).map((g) => g.name)),
    cast_json: JSON.stringify(castOf(m.credits)),
    directors: JSON.stringify((m.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name)),
    studio: m.production_companies?.[0]?.name || null,
    air_date: m.release_date || null,
    poster: artFor(item, 'poster', m.poster_path, preferLocal),
    backdrop: artFor(item, 'backdrop', m.backdrop_path, preferLocal),
    metadata_at: Date.now(),
    updated_at: Date.now(),
  }, item.nfo_json, item.cast_json));
  return true;
}

async function applyShow(item, tmdbId) {
  const s = await tmdb(`/tv/${tmdbId}`, { append_to_response: 'credits,content_ratings,external_ids' });
  if (!s) return false;
  const preferLocal = getSetting('preferLocalArtwork');
  const rating = s.content_ratings?.results?.find((r) => r.iso_3166_1 === country())?.rating;
  setFields(item.id, withNfo({
    tmdb_id: s.id,
    imdb_id: s.external_ids?.imdb_id || item.imdb_id,
    title: s.name || item.title,
    sort_title: sortTitle(s.name || item.title),
    original_title: s.original_name !== s.name ? s.original_name : null,
    year: yearOf(s.first_air_date) || item.year,
    overview: s.overview || item.overview,
    tagline: s.tagline || null,
    rating: s.vote_average ? Math.round(s.vote_average * 10) / 10 : null,
    content_rating: rating || item.content_rating,
    genres: JSON.stringify((s.genres || []).map((g) => g.name)),
    cast_json: JSON.stringify(castOf(s.credits)),
    directors: JSON.stringify((s.created_by || []).map((c) => c.name)),
    studio: s.networks?.[0]?.name || s.production_companies?.[0]?.name || null,
    air_date: s.first_air_date || null,
    poster: artFor(item, 'poster', s.poster_path, preferLocal),
    backdrop: artFor(item, 'backdrop', s.backdrop_path, preferLocal),
    metadata_at: Date.now(),
    updated_at: Date.now(),
  }, item.nfo_json, item.cast_json));

  const seasons = all("SELECT * FROM items WHERE parent_id = ? AND type = 'season'", item.id);
  for (const season of seasons) {
    const data = await tmdb(`/tv/${s.id}/season/${season.season_number}`);
    if (!data) {
      setFields(season.id, { metadata_at: Date.now() });
      continue;
    }
    const episodes = all("SELECT * FROM items WHERE parent_id = ? AND type = 'episode'", season.id);
    tx(() => {
      setFields(season.id, {
        title: season.season_number === 0 ? data.name || 'Specials' : `Season ${season.season_number}`,
        overview: data.overview || season.overview,
        air_date: data.air_date || null,
        year: yearOf(data.air_date),
        poster: artFor(season, 'poster', data.poster_path, preferLocal),
        tmdb_id: data.id,
        metadata_at: Date.now(),
        updated_at: Date.now(),
      });
      const byNumber = new Map((data.episodes || []).map((e) => [e.episode_number, e]));
      const byDate = new Map((data.episodes || []).filter((e) => e.air_date).map((e) => [e.air_date, e]));
      for (const ep of episodes) {
        const meta = ep.episode_number != null ? byNumber.get(ep.episode_number) : byDate.get(ep.air_date);
        if (!meta) {
          setFields(ep.id, { metadata_at: Date.now() });
          continue;
        }
        let title = meta.name || ep.title;
        if (ep.episode_end && ep.episode_end > ep.episode_number) {
          const names = [];
          for (let n = ep.episode_number; n <= ep.episode_end; n++) if (byNumber.get(n)?.name) names.push(byNumber.get(n).name);
          if (names.length > 1) title = names.join(' / ');
        }
        setFields(ep.id, withNfo({
          title,
          episode_number: ep.episode_number ?? meta.episode_number,
          overview: meta.overview || ep.overview,
          air_date: meta.air_date || ep.air_date,
          year: yearOf(meta.air_date),
          rating: meta.vote_average ? Math.round(meta.vote_average * 10) / 10 : null,
          thumb: artFor(ep, 'thumb', meta.still_path, preferLocal),
          tmdb_id: meta.id,
          metadata_at: Date.now(),
          updated_at: Date.now(),
        }, ep.nfo_json, ep.cast_json));
      }
    });
  }
  return true;
}

/** Finds (or uses the known) TMDB match for a movie/show and applies its metadata. */
export async function refreshItem(itemId, { rematch = false } = {}) {
  let item = get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) return false;
  if (item.type === 'season' || item.type === 'episode') {
    item = get('SELECT * FROM items WHERE id = ?', item.show_id);
    if (!item) return false;
  }
  const kind = item.type === 'movie' ? 'movie' : 'tv';
  let tmdbId = item.tmdb_id;
  if (!tmdbId && item.imdb_id) {
    const found = await tmdb(`/find/${item.imdb_id}`, { external_source: 'imdb_id' });
    tmdbId = (kind === 'movie' ? found?.movie_results : found?.tv_results)?.[0]?.id || null;
  }
  if ((!tmdbId || rematch) && !item.match_locked) {
    const results = await search(kind, item.title, item.year);
    const best = pickBest(results.map((r) => r.raw), item.title, item.year, kind);
    tmdbId = best?.id || null;
  }
  if (!tmdbId) {
    setFields(item.id, { metadata_at: Date.now() });
    log.info(`No TMDB match for ${item.type} "${item.title}"${item.year ? ` (${item.year})` : ''}`);
    return false;
  }
  return kind === 'movie' ? applyMovie(item, tmdbId) : applyShow(item, tmdbId);
}

/**
 * All the artwork TMDB has for an item, best first, as { poster, backdrop, thumb } option lists
 * (season posters for a season, stills for an episode). Null when the item isn't matched on TMDB.
 */
export async function tmdbArtwork(row) {
  let endpoint = null;
  if ((row.type === 'movie' || row.type === 'show') && row.tmdb_id) {
    endpoint = `/${row.type === 'movie' ? 'movie' : 'tv'}/${row.tmdb_id}/images`;
  } else if ((row.type === 'season' || row.type === 'episode') && row.season_number != null) {
    const show = get('SELECT tmdb_id FROM items WHERE id = ?', row.show_id);
    if (!show?.tmdb_id || (row.type === 'episode' && row.episode_number == null)) return null;
    endpoint = `/tv/${show.tmdb_id}/season/${row.season_number}${row.type === 'episode' ? `/episode/${row.episode_number}` : ''}/images`;
  }
  if (!endpoint) return null;
  const lang = (getSetting('metadataLanguage') || 'en-US').split('-')[0];
  // Without include_image_language TMDB only lists images in the request's language.
  const data = await tmdb(endpoint, { include_image_language: [...new Set([lang, 'en', 'null'])].join(',') });
  if (!data) return null;
  // Posters: the metadata language first, then textless; backgrounds: textless first.
  const order = (textlessFirst) => (i) => {
    const l = i.iso_639_1 || null;
    if (textlessFirst) return l == null ? 0 : l === lang ? 1 : l === 'en' ? 2 : 3;
    return l === lang ? 0 : l == null ? 1 : l === 'en' ? 2 : 3;
  };
  const options = (list, textlessFirst) => {
    const rank = order(textlessFirst);
    return (list || [])
      .filter((i) => /^\/[\w-]+\.(jpe?g|png|webp)$/i.test(i.file_path || ''))
      .sort((a, b) => rank(a) - rank(b) || (b.vote_average || 0) - (a.vote_average || 0) || (b.vote_count || 0) - (a.vote_count || 0))
      .slice(0, 60)
      .map((i) => ({
        ref: img(i.file_path), source: 'tmdb', language: i.iso_639_1 || null,
        rating: i.vote_average || null, votes: i.vote_count || 0, width: i.width || null, height: i.height || null,
      }));
  };
  return { poster: options(data.posters, false), backdrop: options(data.backdrops, true), thumb: options(data.stills, true) };
}

// ---------- people ----------

const sameName = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** TMDB's id for someone in a movie's or show's cast, by name (null when they aren't listed). */
export async function castMemberId(kind, tmdbId, name) {
  const base = `/${kind === 'movie' ? 'movie' : 'tv'}/${tmdbId}`;
  const credits = await tmdb(`${base}/credits`);
  let hit = credits?.cast?.find((c) => sameName(c.name, name));
  // A show's credits are its latest season's; someone who has left is in the whole run's.
  if (!hit && kind !== 'movie') hit = (await tmdb(`${base}/aggregate_credits`))?.cast?.find((c) => sameName(c.name, name));
  return hit?.id || null;
}

/** TMDB's id for a person found by name: the one with the same photo, else the best-known actor of that name. */
export async function findPersonId(name, profileRef) {
  const data = await tmdb('/search/person', { query: name, include_adult: false });
  const results = data?.results || [];
  const named = results.filter((p) => sameName(p.name, name));
  const pool = named.length ? named : results;
  return (profileRef && pool.find((p) => img(p.profile_path) === profileRef))?.id
    ?? pool.find((p) => p.known_for_department === 'Acting')?.id
    ?? pool[0]?.id
    ?? null;
}

/**
 * Who a person is and what they've acted in: { name, profile, biography, birthday, deathday, birthplace,
 * credits: [{ kind, tmdbId, title, date, role, poster }] } (kind is 'movie' or 'show'; profile and poster are
 * tmdb: refs; dates YYYY-MM-DD). Null when TMDB doesn't know the id.
 */
export async function personCredits(personId) {
  const p = await tmdb(`/person/${personId}`, { append_to_response: 'combined_credits' });
  if (!p) return null;
  let biography = p.biography?.trim() || null;
  // Many people only have an English biography: better that than none.
  if (!biography && !/^en\b/.test(getSetting('metadataLanguage') || 'en-US')) {
    biography = (await tmdb(`/person/${personId}`, { language: 'en-US' }))?.biography?.trim() || null;
  }
  return {
    name: p.name,
    profile: img(p.profile_path),
    biography,
    birthday: p.birthday || null,
    deathday: p.deathday || null,
    birthplace: p.place_of_birth?.trim() || null,
    credits: (p.combined_credits?.cast || [])
      .filter((c) => !c.adult && (c.media_type === 'movie' || c.media_type === 'tv'))
      .map((c) => ({
        kind: c.media_type === 'movie' ? 'movie' : 'show',
        tmdbId: c.id,
        title: c.title || c.name || '',
        date: c.release_date || c.first_air_date || null,
        role: c.character || null,
        poster: img(c.poster_path),
      })),
  };
}

/** Sets an explicit match chosen by an admin and refreshes the item. */
export async function setMatch(itemId, tmdbId) {
  const item = get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item || !['movie', 'show'].includes(item.type)) throw new Error('Only movies and shows can be matched');
  setFields(item.id, { tmdb_id: tmdbId, match_locked: 1 });
  return refreshItem(item.id);
}

/** Fetches metadata for everything in a library that hasn't been fetched yet. */
export async function refreshLibrary(libraryId, onProgress = () => {}) {
  if (!tmdbConfigured()) return;
  const targets = all(
    `SELECT id FROM items i WHERE library_id = ? AND (
       (type = 'movie' AND metadata_at IS NULL) OR
       (type = 'show' AND (metadata_at IS NULL OR EXISTS (
          SELECT 1 FROM items c WHERE c.show_id = i.id AND c.metadata_at IS NULL))))`,
    libraryId,
  );
  const limit = createLimiter(4);
  let done = 0;
  onProgress(0, targets.length);
  await Promise.all(targets.map((t) => limit(async () => {
    try {
      await refreshItem(t.id);
    } catch (err) {
      log.warn(`Metadata refresh failed for item ${t.id}: ${err.message}`);
      if (/API key/.test(err.message)) throw err;
    } finally {
      onProgress(++done, targets.length);
    }
  }))).catch((err) => log.error(err.message));
}
