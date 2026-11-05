// The Recordings page as a library: recordings grouped into shows (by their name) and each show's series, with cover
// art — a poster from TMDB found by the show's name (asked once per show and kept in the recording_art table), else
// the guide's own picture from Tvheadend — and, for shows TMDB knows as TV shows, each series' own poster and each
// episode's still (kept in recording_art.seasons_json and recording_stills), for the web app, the Android app and
// Kodi's screens alike.
import { all, get, placeholders, run } from '../db.js';
import { search, tmdbConfigured, tvEpisodeStills, tvSeasonPosters } from '../metadata/tmdb.js';
import { sortTitle } from '../scanner/parse.js';
import { recordingTitle } from './tvheadend.js';
import { forgetGuide, liveTvOn, tvheadend } from './guide.js';
import { createLimiter } from '../lib/limit.js';
import { logger } from '../lib/log.js';

const log = logger('recordings');
const RECHECK_MS = 7 * 24 * 3600 * 1000; // before asking TMDB again about a name it didn't know
const DETAILS_RECHECK_MS = 24 * 3600 * 1000; // before asking again for a series or episode TMDB didn't have
const ART_WAIT_MS = 2500; // how long a page waits for new art (it shows the next time otherwise)
const POSTER = /^\/[\w-]+\.(jpe?g|png|webp)$/i;
// TMDB votes a match needs: obscure titles that only share the name ("News", "The Long Road") have none, while even
// little-known real shows have a few (Gardeners' World 6, Countryfile 7 in November 2026).
const MIN_VOTES = 3;
const looking = new Map(); // show key → its lookup under way
const limit = createLimiter(2);

/** The name shows are grouped by: lowercase, without punctuation ("Film: The Long Road" → "film the long road"). */
export const showKey = (title) => String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A poster for a show's name: a TV show on TMDB called exactly that (the best known, when there are several), else a
 * film (a guide's "Film: " in front left off). Only exact names that people have voted on count: a wrong picture is
 * worse than none.
 */
async function findPoster(title) {
  const plain = title.replace(/^(film|movie)\s*:\s*/i, '');
  const kinds = plain !== title ? ['movie', 'tv'] : ['tv', 'movie'];
  const want = sortTitle(plain);
  for (const kind of kinds) {
    const exact = (await search(kind, plain))
      .filter((r) => POSTER.test(r.raw.poster_path || '') && (r.raw.vote_count || 0) >= MIN_VOTES
        && [r.title, r.originalTitle].some((n) => n && sortTitle(n) === want))
      .sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    if (exact.length) return { poster: exact[0].raw.poster_path, tmdbId: exact[0].tmdbId, kind };
  }
  return null;
}

/** Looks a show up on TMDB (one lookup per name at a time) and keeps what was found, or that nothing was. */
function lookUp(key, title) {
  if (!looking.has(key)) {
    const lookup = limit(() => findPoster(title))
      .then((found) => {
        run('INSERT OR REPLACE INTO recording_art (title_key, poster, tmdb_id, kind, checked_at) VALUES (?, ?, ?, ?, ?)',
          key, found?.poster ?? null, found?.tmdbId ?? null, found?.kind ?? null, Date.now());
      }, (err) => log.warn(`No cover art for "${title}" from TMDB this time: ${err.message}`))
      .finally(() => looking.delete(key));
    looking.set(key, lookup);
  }
  return looking.get(key);
}

const keptPosters = (keys) => new Map(keys.length
  ? all(`SELECT * FROM recording_art WHERE title_key IN (${placeholders(keys)})`, ...keys).map((r) => [r.title_key, r])
  : []);

const parseMap = (json) => {
  try {
    return JSON.parse(json || 'null') || {};
  } catch {
    return {};
  }
};

/** One lookup at a time per `key`; what it found is kept by `keep`, a failure only logged. */
function once(key, find, keep, what) {
  if (!looking.has(key)) {
    const lookup = limit(find)
      .then(keep, (err) => log.warn(`No ${what} from TMDB this time: ${err.message}`))
      .finally(() => looking.delete(key));
    looking.set(key, lookup);
  }
  return looking.get(key);
}

const lookUpSeasons = (row) => once(`seasons:${row.title_key}`, () => tvSeasonPosters(row.tmdb_id), (posters) => {
  run('UPDATE recording_art SET seasons_json = ?, seasons_at = ? WHERE title_key = ?', JSON.stringify(posters), Date.now(), row.title_key);
}, `series covers for "${row.title_key}"`);

const lookUpStills = (row, season) => once(`stills:${row.title_key}:${season}`, () => tvEpisodeStills(row.tmdb_id, season), (stills) => {
  run('INSERT OR REPLACE INTO recording_stills (title_key, season, stills_json, checked_at) VALUES (?, ?, ?, ?)',
    row.title_key, season, JSON.stringify(stills), Date.now());
}, `episode pictures for "${row.title_key}" series ${season}`);

/** Waits for `promises`, but no longer than `ms`. */
async function within(promises, ms) {
  if (!promises.length) return;
  let timer;
  await Promise.race([Promise.all(promises), new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

/**
 * Everything TMDB has for the Recordings page's recordings: { posters: Map show key → poster path, seasons: Map show
 * key → { series: poster path }, stills: Map "key|series" → { episode: still path } }. What isn't kept yet is looked
 * up now, when TMDB is set up (first the shows, then their series, then the episodes); the answer waits up to `waitMs`
 * in all, and the rest shows the next time.
 */
export async function recordingArt(recordings, { waitMs = ART_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs;
  const left = () => Math.max(0, deadline - Date.now());
  const posters = await postersFor([...new Set(recordings.map((r) => r.title))], { waitMs });
  const keys = [...new Set(recordings.map((r) => showKey(r.title)))];
  // The series and episodes each TV show has recordings of.
  const wanted = new Map();
  for (const r of recordings) {
    if (r.season == null) continue;
    const key = showKey(r.title);
    if (!wanted.has(key)) wanted.set(key, new Map());
    const episodes = wanted.get(key);
    if (!episodes.has(r.season)) episodes.set(r.season, new Set());
    if (r.episode != null) episodes.get(r.season).add(r.episode);
  }
  let rows = keptPosters(keys);
  const tv = () => [...rows.values()].filter((row) => row.kind === 'tv' && row.tmdb_id && wanted.has(row.title_key));
  if (tmdbConfigured()) {
    const stale = (at) => !at || Date.now() - at > DETAILS_RECHECK_MS;
    await within(tv().filter((row) => row.seasons_json == null
      || ([...wanted.get(row.title_key).keys()].some((n) => !(n in parseMap(row.seasons_json))) && stale(row.seasons_at)))
      .map(lookUpSeasons), left());
    rows = keptPosters(keys);
    const jobs = [];
    for (const row of tv()) {
      for (const [season, episodes] of wanted.get(row.title_key)) {
        const kept = get('SELECT stills_json, checked_at FROM recording_stills WHERE title_key = ? AND season = ?', row.title_key, season);
        if (!kept || ([...episodes].some((e) => !(e in parseMap(kept.stills_json))) && stale(kept.checked_at))) jobs.push(lookUpStills(row, season));
      }
    }
    await within(jobs, left());
  }
  const seasons = new Map(tv().map((row) => [row.title_key, parseMap(row.seasons_json)]));
  const stills = new Map();
  if (keys.length) {
    for (const row of all(`SELECT * FROM recording_stills WHERE title_key IN (${placeholders(keys)})`, ...keys)) {
      stills.set(`${row.title_key}|${row.season}`, parseMap(row.stills_json));
    }
  }
  return { posters, seasons, stills };
}

/**
 * TMDB poster paths for shows' names, Map show key → "/abc.jpg". Names not asked about yet (or not found for a week)
 * are looked up now, when TMDB is set up; the answer waits up to `waitMs` for them.
 */
export async function postersFor(titles, { waitMs = ART_WAIT_MS } = {}) {
  const names = new Map(titles.map((t) => [showKey(t), t]));
  let kept = keptPosters([...names.keys()]);
  if (tmdbConfigured()) {
    const missing = [...names].filter(([key]) => {
      const row = kept.get(key);
      return !row || (!row.poster && Date.now() - row.checked_at > RECHECK_MS);
    });
    if (missing.length) {
      let timer;
      await Promise.race([
        Promise.all(missing.map(([key, title]) => lookUp(key, title))),
        new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
      ]);
      clearTimeout(timer);
      kept = keptPosters([...names.keys()]);
    }
  }
  return new Map([...kept].filter(([, row]) => row.poster).map(([key, row]) => [key, row.poster]));
}

/**
 * Ends someone's series recordings as their account goes: nobody would see them through, and they'd record for ever. If
 * Tvheadend can't be reached they stay, for an admin to find under Everyone's.
 */
export async function endSeriesOf(userId) {
  const theirs = all('SELECT autorec_uuid FROM recording_series WHERE user_id = ?', userId).map((r) => r.autorec_uuid);
  if (!theirs.length || !liveTvOn()) return;
  try {
    const tvh = tvheadend();
    const there = new Set((await tvh.seriesRecordings()).map((r) => r.uuid));
    for (const uuid of theirs) if (there.has(uuid)) await tvh.removeSeries(uuid);
    forgetGuide();
  } catch (err) {
    log.warn(`Couldn't end the series recordings of a deleted account: ${err.message}`);
  }
}

/** Looks up a show's art ahead (when something is scheduled), so the page has it at once. */
export function prefetchPoster(title) {
  if (!tmdbConfigured() || !title) return;
  void postersFor([recordingTitle(title)], { waitMs: 0 }).catch(() => {});
}

// Within a series, by episode (then time); recordings with no series, newest first.
const inSeries = (a, b) => (a.episode ?? Infinity) - (b.episode ?? Infinity) || a.start - b.start;
const newestFirst = (a, b) => b.start - a.start;

const countsOf = (recs) => {
  const counts = { recording: 0, scheduled: 0, recorded: 0, failed: 0 };
  for (const r of recs) if (r.state in counts) counts[r.state] += 1;
  return counts;
};
const tmdbImage = (kind, path) => (path && POSTER.test(path) ? `/api/tmdb-image/${kind}${path}` : null);

/**
 * Series recordings (`rules`, as Tvheadend.seriesRecordings gives them, with `channel` and `owner` filled in) as the
 * Manage Recordings pages list them: [{ uuid, key, title, poster, channel, owner, mine, canChange, counts, next }]. Each
 * shows its show's cover (`shows`, from groupShows, else TMDB's), how many of the `recordings` listed it made are in each
 * state, and when the next one records (null when the guide has none yet). Soonest first; then those with none, by name.
 */
export function seriesList(rules, recordings, shows, art = {}) {
  return rules.map((rule) => {
    const key = showKey(rule.title);
    const made = recordings.filter((r) => r.series === rule.uuid);
    const { serieslink, ...shown } = rule;
    return {
      ...shown,
      key,
      poster: shows.find((s) => s.key === key)?.poster || tmdbImage('poster', art.posters?.get(key)) || null,
      counts: countsOf(made),
      next: made.filter((r) => r.state === 'scheduled').reduce((t, r) => (t == null || r.start < t ? r.start : t), null),
    };
  }).sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity) || a.title.localeCompare(b.title));
}

/**
 * Recordings (as the Recordings page lists them) grouped into shows: [{ key, title, poster, channel, counts,
 * recordingNow, latest, nextScheduled, seasons: [{ season, poster, counts, recordings }] }]. A show's title and channel are its newest
 * recording's; its `poster` is TMDB's (`art.posters`, show key → path), else the guide's picture of its newest
 * recording that has one (through `imageUrl(recording)`), else null. A series' poster is TMDB's for that series
 * (`art.seasons`), else the show's; each recording gets a `still`: TMDB's for its episode (`art.stills`), else its own
 * guide picture, else null. Series in order, recordings with no series number last. Shows recording now first, then by
 * their newest recording, newest first; shows with only scheduled ones last, soonest first.
 */
export function groupShows(recordings, art = {}, imageUrl = () => null) {
  const { posters = new Map(), seasons: seasonPosters = new Map(), stills = new Map() } = art;
  const byKey = new Map();
  for (const r of recordings) {
    const key = showKey(r.title);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const shows = [...byKey].map(([key, recs]) => {
    const started = recs.filter((r) => r.state !== 'scheduled');
    const newest = started.length ? started.reduce((a, r) => (r.start > a.start ? r : a))
      : recs.reduce((a, r) => (r.start < a.start ? r : a));
    const counts = countsOf(recs);
    const pictured = [...recs].sort(newestFirst).find((r) => r.image);
    const poster = tmdbImage('poster', posters.get(key)) || (pictured ? imageUrl(pictured) : null);
    for (const r of recs) {
      const still = r.season != null && r.episode != null ? stills.get(`${key}|${r.season}`)?.[r.episode] : null;
      r.still = tmdbImage('thumb', still) || (r.image ? imageUrl(r) : null);
    }
    const seasons = [...new Set(recs.map((r) => r.season ?? null))]
      .sort((a, b) => (a ?? Infinity) - (b ?? Infinity))
      .map((season) => {
        const inIt = recs.filter((r) => (r.season ?? null) === season).sort(season == null ? newestFirst : inSeries);
        return {
          season,
          poster: (season != null && tmdbImage('poster', seasonPosters.get(key)?.[season])) || poster,
          counts: countsOf(inIt),
          recordings: inIt,
        };
      });
    return {
      key,
      title: newest.title,
      poster,
      channel: newest.channel ?? null,
      counts,
      recordingNow: counts.recording > 0,
      started: started.length > 0,
      latest: newest.start,
      // When its next scheduled episode records (the apps' Scheduled row is soonest first), or null.
      nextScheduled: recs.filter((r) => r.state === 'scheduled').reduce((t, r) => (t == null || r.start < t ? r.start : t), null),
      seasons,
    };
  });
  return shows
    .sort((a, b) => b.recordingNow - a.recordingNow || b.started - a.started || (a.started ? b.latest - a.latest : a.latest - b.latest))
    .map(({ started, ...show }) => show);
}
