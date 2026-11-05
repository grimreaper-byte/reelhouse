// The Recordings page as a library (server/livetv/recordings.js): recordings grouped into shows and series in the order
// the apps show them, series numbers from Tvheadend, and cover art from TMDB by exact name, asked once per show.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-recordings-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, get } = await import('../server/db.js');
const { updateSettings } = await import('../server/settings.js');
const { groupShows, postersFor, recordingArt, showKey } = await import('../server/livetv/recordings.js');
const { recordingTitle, seasonEpisode } = await import('../server/livetv/tvheadend.js');

// TMDB's answers by search: "Late Comedy" is a show (two with the name: the better known wins), "The Long Road" a film;
// "News" only finds other names, and an unknown film called just that (no votes: as TMDB has them, it isn't it).
const TMDB = {
  tv: {
    'Late Comedy': [{ id: 1, name: 'Late Comedy Hour', poster_path: '/wrong.jpg', popularity: 99, vote_count: 400 },
      { id: 2, name: 'Late Comedy', poster_path: '/old.jpg', popularity: 1, vote_count: 3 },
      { id: 3, name: 'Late Comedy', poster_path: '/late.jpg', popularity: 20, vote_count: 12 }],
    News: [{ id: 4, name: 'Newsround', poster_path: '/newsround.jpg', popularity: 50, vote_count: 30 }],
  },
  movie: {
    'The Long Road': [{ id: 5, title: 'The Long Road', poster_path: '/road.jpg', popularity: 3, vote_count: 8 }],
    News: [{ id: 6, title: 'News', poster_path: '/someone.jpg', popularity: 1, vote_count: 0 }],
  },
  // "Late Comedy" (id 3): its series' posters (series 2 has none), and series 1's episode stills.
  '/3/tv/3': { seasons: [{ season_number: 1, poster_path: '/late-s1.jpg' }, { season_number: 2, poster_path: null }] },
  '/3/tv/3/season/1': { episodes: [{ episode_number: 1, still_path: '/e1.jpg' }, { episode_number: 2, still_path: '/e2.jpg' }] },
  '/3/tv/3/season/2': { episodes: [] },
};
const asked = [];
let realFetch;

before(() => {
  openDb(':memory:');
  updateSettings({ tmdbApiKey: '0123456789abcdef0123456789abcdef' });
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(url);
    if (u.hostname !== 'api.themoviedb.org') return realFetch(url, opts);
    const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (u.pathname.startsWith('/3/search/')) {
      const kind = u.pathname.endsWith('/tv') ? 'tv' : 'movie';
      asked.push(`${kind}:${u.searchParams.get('query')}`);
      return json({ results: TMDB[kind][u.searchParams.get('query')] || [] });
    }
    asked.push(u.pathname);
    return TMDB[u.pathname] ? json(TMDB[u.pathname]) : new Response('{}', { status: 404 });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const rec = (uuid, title, state, start, more = {}) => ({ uuid, title, state, start, stop: start + 1800, season: null, episode: null, image: null, ...more });

test('series and episode numbers: as Tvheadend writes them, else from the file name', () => {
  assert.deepEqual(seasonEpisode('Season 2.Episode 14', ''), { season: 2, episode: 14 });
  assert.deepEqual(seasonEpisode('Episode 3', ''), { season: null, episode: 3 });
  assert.deepEqual(seasonEpisode('', '/recordings/Late Comedy/Late Comedy - S01E04 - Part 4.ts'), { season: 1, episode: 4 });
  assert.deepEqual(seasonEpisode(null, '/recordings/News/News-2026-11-01.ts'), { season: null, episode: null });
});

test('a new episode\'s "New: " (UK guides) is left off, so new episodes and repeats are one show', () => {
  assert.equal(recordingTitle('New: Married at First Sight UK'), 'Married at First Sight UK');
  assert.equal(recordingTitle("NEW:I'm a Celebrity... Get Me Out of Here!"), "I'm a Celebrity... Get Me Out of Here!");
  assert.equal(recordingTitle('9/11: 102 Minutes That Changed America'), '9/11: 102 Minutes That Changed America');
  assert.equal(recordingTitle('Newsnight'), 'Newsnight');
  assert.equal(recordingTitle('News: Special'), 'News: Special');
  assert.equal(recordingTitle(''), 'Untitled');
  const t = 1_800_000_000;
  const shows = groupShows([rec('a', recordingTitle('New: Mock The Week'), 'recorded', t), rec('b', 'Mock The Week', 'recorded', t - 600000)]);
  assert.deepEqual(shows.map((s) => [s.title, s.counts.recorded]), [['Mock The Week', 2]]);
});

test('shows: grouped by name, series in order, recording now first, then the newest; only-scheduled shows last', () => {
  const t = 1_800_000_000;
  const list = [
    rec('a', 'Late Comedy', 'recorded', t - 7200, { season: 1, episode: 2 }),
    rec('b', 'late comedy', 'scheduled', t + 3600, { season: 1, episode: 3 }),
    rec('c', 'Late Comedy', 'recorded', t - 90000, { season: 1, episode: 1 }),
    rec('d', 'Late Comedy', 'failed', t - 200000, { season: 2, episode: 1 }),
    rec('e', 'Late Comedy', 'recorded', t - 300000),
    rec('f', 'News', 'recording', t - 600, { image: 'imagecache/9' }),
    rec('g', 'Quiz Night', 'recorded', t - 3600),
    rec('h', 'Film: The Long Road', 'scheduled', t + 9000),
    rec('i', 'Nature Watch', 'scheduled', t + 1800),
  ];
  const shows = groupShows(list, { posters: new Map([['late comedy', '/late.jpg']]) }, (r) => `/img/${r.uuid}`);
  assert.deepEqual(shows.map((s) => s.title), ['News', 'Quiz Night', 'Late Comedy', 'Nature Watch', 'Film: The Long Road']);
  const late = shows[2];
  assert.equal(late.key, showKey('Late Comedy'));
  assert.deepEqual(late.seasons.map((s) => [s.season, s.recordings.map((r) => r.uuid)]), [[1, ['c', 'a', 'b']], [2, ['d']], [null, ['e']]]);
  assert.deepEqual(late.counts, { recording: 0, scheduled: 1, recorded: 3, failed: 1 });
  assert.equal(late.poster, '/api/tmdb-image/poster/late.jpg');
  assert.equal(late.latest, t - 7200);
  assert.deepEqual([late.nextScheduled, shows[0].nextScheduled, shows[3].nextScheduled], [t + 3600, null, t + 1800]);
  // No TMDB poster: the guide's picture; nothing: none.
  assert.deepEqual([shows[0].poster, shows[0].recordingNow, shows[1].poster], ['/img/f', true, null]);
  assert.equal(showKey('Film: The Long Road'), 'film the long road');
});

test('cover art: exact names people voted on, a film without its "Film: ", asked once per show and kept', async () => {
  let posters = await postersFor(['Late Comedy', 'News', 'Film: The Long Road']);
  assert.deepEqual(Object.fromEntries(posters), { 'late comedy': '/late.jpg', 'film the long road': '/road.jpg' });
  assert.deepEqual(asked.sort(), ['movie:News', 'movie:The Long Road', 'tv:Late Comedy', 'tv:News'].sort());
  // Kept: TMDB isn't asked again, also for the name it didn't know (until a week has passed).
  asked.length = 0;
  posters = await postersFor(['Late Comedy', 'News', 'Film: The Long Road']);
  assert.equal(posters.size, 2);
  assert.deepEqual(asked, []);
  assert.equal(get("SELECT poster FROM recording_art WHERE title_key = 'news'").poster, null);
  // Without a TMDB key, only what's kept.
  updateSettings({ tmdbApiKey: '' });
  assert.deepEqual([...(await postersFor(['Quiz Night', 'Late Comedy'])).keys()], ['late comedy']);
  assert.deepEqual(asked, []);
});

test('series covers and episode pictures: TMDB\'s for a TV show it knows, else the show\'s poster or the guide\'s picture', async () => {
  updateSettings({ tmdbApiKey: '0123456789abcdef0123456789abcdef' });
  const t = 1_800_000_000;
  const list = [
    rec('a', 'Late Comedy', 'recorded', t - 7200, { season: 1, episode: 2 }),
    rec('b', 'Late Comedy', 'scheduled', t + 3600, { season: 1, episode: 3, image: 'imagecache/7' }),
    rec('c', 'Late Comedy', 'recorded', t - 200000, { season: 2, episode: 1 }),
    rec('d', 'Late Comedy', 'recorded', t - 300000),
    rec('e', 'Film: The Long Road', 'recorded', t - 600, { season: 1, episode: 1 }),
  ];
  asked.length = 0;
  const art = await recordingArt(list);
  // The show (already kept) isn't searched again; its series are asked for once, then series 1 and 2's episodes.
  assert.deepEqual(asked, ['/3/tv/3', '/3/tv/3/season/1', '/3/tv/3/season/2']);
  const [film, late] = groupShows(list, art, (r) => `/img/${r.uuid}`);
  assert.deepEqual(late.seasons.map((s) => [s.season, s.poster, s.counts.recorded, s.counts.scheduled]), [
    [1, '/api/tmdb-image/poster/late-s1.jpg', 1, 1],
    [2, '/api/tmdb-image/poster/late.jpg', 1, 0], // no poster for series 2: the show's
    [null, '/api/tmdb-image/poster/late.jpg', 1, 0],
  ]);
  assert.deepEqual(late.seasons.flatMap((s) => s.recordings.map((r) => [r.uuid, r.still])), [
    ['a', '/api/tmdb-image/thumb/e2.jpg'],
    ['b', '/img/b'], // TMDB has no still for episode 3: the guide's picture
    ['c', null],
    ['d', null],
  ]);
  // A film: no series to ask about; its "series 1" has the film's poster.
  assert.deepEqual([film.seasons[0].poster, film.seasons[0].recordings[0].still], ['/api/tmdb-image/poster/road.jpg', null]);
  // Kept: nothing is asked again.
  asked.length = 0;
  await recordingArt(list);
  assert.deepEqual(asked, []);
});
