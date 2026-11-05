// Item queries and serialization shared by the API routes.
import { all, get, run, tx, placeholders, parseJson } from './db.js';
import { allowedLibraryIds } from './auth.js';
import { stateItemId } from './versions.js';

const imageUrl = (row, kind) => `/api/images/${row.id}/${kind}?v=${row.updated_at}`;

export function serializeItem(row, { state, counts, full = false } = {}) {
  const out = {
    id: row.id,
    libraryId: row.library_id,
    type: row.type,
    title: row.title,
    year: row.year,
    parentId: row.parent_id,
    showId: row.show_id,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    episodeEnd: row.episode_end,
    airDate: row.air_date,
    rating: row.rating,
    contentRating: row.content_rating,
    duration: row.duration,
    addedAt: row.added_at,
    images: {
      // Always present: the server falls back to show/season art or a frame from the video.
      poster: imageUrl(row, 'poster'),
      backdrop: row.backdrop || row.show_id ? imageUrl(row, 'backdrop') : null,
      thumb: row.type === 'episode' || row.type === 'movie' ? imageUrl(row, 'thumb') : null,
    },
    state: {
      position: state?.position || 0,
      watched: !!state?.watched,
      viewCount: state?.view_count || 0,
      lastViewedAt: state?.updated_at || null,
    },
  };
  if (row.type === 'movie' || row.type === 'episode') {
    out.videoResolution = resolutionLabel(row.width, row.height);
  }
  if (row.version_of) out.versionOf = row.version_of; // another copy of a film (server/versions.js)
  if (counts) {
    out.leafCount = counts.leaf || 0;
    out.viewedLeafCount = counts.viewed || 0;
    out.state.watched = out.leafCount > 0 && out.viewedLeafCount >= out.leafCount;
    if (counts.children != null) out.childCount = counts.children;
  }
  if (full) {
    Object.assign(out, {
      originalTitle: row.original_title,
      overview: row.overview,
      tagline: row.tagline,
      genres: parseJson(row.genres, []),
      cast: parseJson(row.cast_json, []).map((c) => ({
        ...c,
        profile: c.profile?.startsWith('tmdb:') ? `/api/tmdb-image/profile${c.profile.slice(5)}` : null,
      })),
      directors: parseJson(row.directors, []),
      studio: row.studio,
      tmdbId: row.tmdb_id,
      imdbId: row.imdb_id,
      matchLocked: !!row.match_locked,
    });
  } else if (row.type !== 'movie' && row.type !== 'show') {
    out.overview = row.overview;
  }
  return out;
}

export function resolutionLabel(width, height) {
  if (!width || !height) return null;
  const h = Math.max(height, Math.round((width * 9) / 16));
  if (h >= 2000) return '4K';
  if (h >= 1400) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  if (h >= 560) return '576p';
  if (h >= 470) return '480p';
  return 'SD';
}

// ---------- user state ----------

export function statesFor(userId, ids) {
  const map = new Map();
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of all(`SELECT * FROM user_state WHERE user_id = ? AND item_id IN (${placeholders(chunk)})`, userId, ...chunk)) {
      map.set(r.item_id, r);
    }
  }
  return map;
}

/** Episode counts per show (by = 'show_id') or per season (by = 'parent_id'). */
export function leafCounts(userId, ids, by = 'show_id') {
  const map = new Map();
  if (!ids.length) return map;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = all(
      `SELECT e.${by} AS id, COUNT(*) AS leaf, SUM(CASE WHEN us.watched = 1 THEN 1 ELSE 0 END) AS viewed
         FROM items e LEFT JOIN user_state us ON us.item_id = e.id AND us.user_id = ?
        WHERE e.type = 'episode' AND e.${by} IN (${placeholders(chunk)})
        GROUP BY e.${by}`,
      userId,
      ...chunk,
    );
    for (const r of rows) map.set(r.id, r);
  }
  return map;
}

/** Serializes many rows, attaching user state (a film's copy: the film's) and episode counts. */
export function serializeMany(userId, rows, opts = {}) {
  const states = statesFor(userId, [...new Set(rows.map(stateItemId))]);
  const showIds = rows.filter((r) => r.type === 'show').map((r) => r.id);
  const seasonIds = rows.filter((r) => r.type === 'season').map((r) => r.id);
  const showCounts = leafCounts(userId, showIds, 'show_id');
  const seasonCounts = leafCounts(userId, seasonIds, 'parent_id');
  if (showIds.length) {
    for (const r of all(
      `SELECT parent_id AS id, COUNT(*) AS n FROM items WHERE type = 'season' AND parent_id IN (${placeholders(showIds)}) GROUP BY parent_id`,
      ...showIds,
    )) {
      const c = showCounts.get(r.id);
      if (c) c.children = r.n;
    }
  }
  return rows.map((r) => serializeItem(r, {
    ...opts,
    state: states.get(stateItemId(r)),
    counts: r.type === 'show' ? showCounts.get(r.id) || { leaf: 0, viewed: 0 } : r.type === 'season' ? seasonCounts.get(r.id) || { leaf: 0, viewed: 0 } : undefined,
  }));
}

// ---------- access ----------

export function getAccessibleItem(user, id) {
  const row = get('SELECT * FROM items WHERE id = ?', Number(id));
  if (!row) return null;
  if (!allowedLibraryIds(user).includes(row.library_id)) return null;
  return row;
}

// ---------- watched state ----------

const UPSERT_WATCHED = `
  INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at)
  VALUES (?, ?, 0, ?, ?, ?)
  ON CONFLICT(user_id, item_id) DO UPDATE SET
    position = 0,
    watched = excluded.watched,
    view_count = CASE WHEN excluded.watched = 1 AND user_state.watched = 0 THEN user_state.view_count + 1 ELSE user_state.view_count END,
    updated_at = excluded.updated_at`;

/** The items whose watch state playing or marking [item] changes (a film's copy: the film's best copy). */
export function playableIdsUnder(item) {
  if (item.type === 'movie' || item.type === 'episode') return [stateItemId(item)];
  const col = item.type === 'show' ? 'show_id' : 'parent_id';
  return all(`SELECT id FROM items WHERE type = 'episode' AND ${col} = ?`, item.id).map((r) => r.id);
}

export function setWatched(userId, item, watched) {
  const ids = playableIdsUnder(item);
  const t = Date.now();
  tx(() => {
    for (const id of ids) run(UPSERT_WATCHED, userId, id, watched ? 1 : 0, watched ? 1 : 0, t);
  });
  return ids.length;
}

/**
 * Records playback progress; marks the item watched past 90%. Returns the new state. [madeAt]: when a report sent
 * late was made (ms); one older than the item's last change is ignored. A film's copy records it on the film.
 */
export function recordProgress(userId, item, position, duration, ended, madeAt = null) {
  const d = duration || item.duration || 0;
  const t = Date.now();
  const stateId = stateItemId(item);
  const prev = get('SELECT * FROM user_state WHERE user_id = ? AND item_id = ?', userId, stateId);
  // A late report (made offline) doesn't undo anything that happened since, like finishing it on another device.
  if (madeAt != null && prev && prev.updated_at > madeAt) return { watched: !!prev.watched, position: prev.position || 0 };
  if (ended || (d > 0 && position / d >= 0.9)) {
    // Count a view once per playthrough: only when there was progress to clear or it wasn't watched yet.
    if (!prev || prev.position > 0 || !prev.watched) {
      run(
        `INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (?, ?, 0, 1, 1, ?)
         ON CONFLICT(user_id, item_id) DO UPDATE SET position = 0, watched = 1, view_count = user_state.view_count + 1, updated_at = excluded.updated_at`,
        userId,
        stateId,
        t,
      );
    }
    return { watched: true, position: 0 };
  }
  if (position >= 30) {
    run(
      `INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (?, ?, ?, 0, 0, ?)
       ON CONFLICT(user_id, item_id) DO UPDATE SET position = excluded.position, updated_at = excluded.updated_at`,
      userId,
      stateId,
      position,
      t,
    );
    return { watched: !!prev?.watched, position };
  }
  return { watched: !!prev?.watched, position: prev?.position || 0 };
}

// ---------- episodes navigation ----------

const EPISODE_ORDER = 'season_number, COALESCE(episode_number, 999999), sort_title, id';

export function episodesOfShow(showId) {
  return all(`SELECT * FROM items WHERE type = 'episode' AND show_id = ? ORDER BY ${EPISODE_ORDER}`, showId);
}

export function adjacentEpisodes(episode) {
  const eps = episodesOfShow(episode.show_id);
  // Specials (season 0) only link to other specials.
  const list = episode.season_number === 0 ? eps.filter((e) => e.season_number === 0) : eps.filter((e) => e.season_number !== 0);
  const i = list.findIndex((e) => e.id === episode.id);
  return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null };
}

/** The episode to play when pressing Play on a show/season: in-progress, else first unwatched after the last watched. */
export function nextUpEpisode(userId, container) {
  let eps = container.type === 'show' ? episodesOfShow(container.id) : all(
    `SELECT * FROM items WHERE type = 'episode' AND parent_id = ? ORDER BY ${EPISODE_ORDER}`,
    container.id,
  );
  if (!eps.length) return null;
  const regular = eps.filter((e) => e.season_number !== 0);
  if (regular.length && container.type === 'show') eps = regular;
  const states = statesFor(userId, eps.map((e) => e.id));
  const inProgress = eps
    .filter((e) => (states.get(e.id)?.position || 0) > 0)
    .sort((a, b) => states.get(b.id).updated_at - states.get(a.id).updated_at)[0];
  if (inProgress) return inProgress;
  let lastWatchedIdx = -1;
  let lastWatchedAt = 0;
  eps.forEach((e, i) => {
    const s = states.get(e.id);
    if (s?.watched && s.updated_at >= lastWatchedAt) {
      lastWatchedAt = s.updated_at;
      lastWatchedIdx = i;
    }
  });
  const after = eps.slice(lastWatchedIdx + 1).find((e) => !states.get(e.id)?.watched);
  return after || eps.find((e) => !states.get(e.id)?.watched) || eps[0];
}
