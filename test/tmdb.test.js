// Exercises the TMDB matcher against canned API responses (no network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, run, get } from '../server/db.js';
import { updateSettings } from '../server/settings.js';
import { refreshItem, refreshLibrary, tmdbArtwork } from '../server/metadata/tmdb.js';

const RESPONSES = {
  '/3/search/movie': { results: [
    { id: 2, title: 'Heat Wave', release_date: '2009-01-01', popularity: 50 },
    { id: 949, title: 'Heat', original_title: 'Heat', release_date: '1995-12-15', popularity: 30 },
  ] },
  '/3/movie/949': {
    id: 949, imdb_id: 'tt0113277', title: 'Heat', original_title: 'Heat', release_date: '1995-12-15',
    overview: 'Obsessive master thief…', tagline: 'A Los Angeles crime saga', vote_average: 7.94,
    genres: [{ name: 'Crime' }, { name: 'Drama' }], poster_path: '/heat.jpg', backdrop_path: '/heat-bg.jpg',
    production_companies: [{ name: 'Regency' }],
    credits: { cast: [{ id: 1158, name: 'Al Pacino', character: 'Vincent Hanna', profile_path: '/al.jpg' }], crew: [{ job: 'Director', name: 'Michael Mann' }] },
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] },
  },
  '/3/search/tv': { results: [{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', popularity: 100 }] },
  '/3/tv/1396': {
    id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20', overview: 'A teacher…',
    vote_average: 8.9, genres: [{ name: 'Drama' }], poster_path: '/bb.jpg', networks: [{ name: 'AMC' }],
    credits: { cast: [] }, content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] }, external_ids: { imdb_id: 'tt0903747' },
  },
  '/3/tv/1396/season/1': {
    id: 3572, air_date: '2008-01-20', overview: 'Season one.', poster_path: '/s1.jpg',
    episodes: [
      { id: 62085, episode_number: 1, name: 'Pilot', overview: 'Walter…', air_date: '2008-01-20', still_path: '/e1.jpg', vote_average: 8.2 },
      { id: 62086, episode_number: 2, name: "Cat's in the Bag...", air_date: '2008-01-27', still_path: '/e2.jpg' },
    ],
  },
};

let realFetch;
const requested = [];

before(() => {
  openDb(':memory:');
  updateSettings({ tmdbApiKey: '0123456789abcdef0123456789abcdef' });
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    requested.push(u.pathname + u.search);
    const body = RESPONSES[u.pathname];
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'TV', 'show', '[]', ?)", t, t);
});

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
});

const insert = (fields) => {
  const t = Date.now();
  const all = { added_at: t, updated_at: t, ...fields };
  const cols = Object.keys(all);
  return Number(run(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => all[c])).lastInsertRowid);
};

test('movie match prefers the right year and fills in details', async () => {
  const id = insert({ library_id: 1, type: 'movie', title: 'Heat', sort_title: 'heat', year: 1995, file_path: 'C:/m/heat.mkv', poster: 'file:C:/m/poster.jpg' });
  assert.equal(await refreshItem(id), true);
  const row = get('SELECT * FROM items WHERE id = ?', id);
  assert.equal(row.tmdb_id, 949);
  assert.equal(row.imdb_id, 'tt0113277');
  assert.equal(row.rating, 7.9);
  assert.equal(row.content_rating, 'R');
  assert.deepEqual(JSON.parse(row.genres), ['Crime', 'Drama']);
  assert.deepEqual(JSON.parse(row.directors), ['Michael Mann']);
  assert.equal(JSON.parse(row.cast_json)[0].profile, 'tmdb:/al.jpg');
  assert.equal(JSON.parse(row.cast_json)[0].tmdbId, 1158, 'kept for the cast member page');
  assert.equal(row.poster, 'file:C:/m/poster.jpg', 'local artwork is preferred by default');
  assert.equal(row.backdrop, 'tmdb:/heat-bg.jpg');
  assert.ok(requested.some((r) => r.startsWith('/3/search/movie') && r.includes('year=1995')));
});

test('show refresh fills seasons and episodes', async () => {
  const show = insert({ library_id: 2, type: 'show', title: 'Breaking Bad', sort_title: 'breaking bad', folder_path: 'C:/tv/bb' });
  const season = insert({ library_id: 2, type: 'season', parent_id: show, show_id: show, title: 'Season 1', sort_title: '0001', season_number: 1 });
  const ep1 = insert({ library_id: 2, type: 'episode', parent_id: season, show_id: show, title: 'Episode 1', sort_title: '00001', season_number: 1, episode_number: 1, file_path: 'C:/tv/bb/1.mkv' });
  const ep2 = insert({ library_id: 2, type: 'episode', parent_id: season, show_id: show, title: 'Episode 2', sort_title: '00002', season_number: 1, episode_number: 2, file_path: 'C:/tv/bb/2.mkv' });

  await refreshLibrary(2);
  const s = get('SELECT * FROM items WHERE id = ?', show);
  assert.equal(s.tmdb_id, 1396);
  assert.equal(s.studio, 'AMC');
  assert.equal(s.content_rating, 'TV-MA');
  assert.equal(get('SELECT poster FROM items WHERE id = ?', season).poster, 'tmdb:/s1.jpg');
  const e1 = get('SELECT * FROM items WHERE id = ?', ep1);
  assert.equal(e1.title, 'Pilot');
  assert.equal(e1.thumb, 'tmdb:/e1.jpg');
  assert.equal(e1.air_date, '2008-01-20');
  assert.equal(get('SELECT title FROM items WHERE id = ?', ep2).title, "Cat's in the Bag...");
  // Everything now has metadata, so a second pass makes no requests.
  const before = requested.length;
  await refreshLibrary(2);
  assert.equal(requested.length, before);
});

test('values from an .nfo stay on top of TMDB metadata', async () => {
  const nfo = { title: 'Heat (Extended)', tagline: 'Our own tagline', cast_json: JSON.stringify([{ name: 'Al Pacino', role: 'Lt. Hanna', profile: null }]) };
  const id = insert({
    library_id: 1, type: 'movie', title: 'Heat (Extended)', sort_title: 'heat extended', year: 1995, tmdb_id: 949,
    file_path: 'C:/m/heat-ext.mkv', nfo_json: JSON.stringify(nfo), nfo_mtime: 1,
  });
  assert.equal(await refreshItem(id), true);
  const row = get('SELECT * FROM items WHERE id = ?', id);
  assert.equal(row.title, 'Heat (Extended)');
  assert.equal(row.tagline, 'Our own tagline');
  assert.equal(row.overview, 'Obsessive master thief…', 'fields the NFO leaves out still come from TMDB');
  assert.deepEqual(JSON.parse(row.cast_json), [{ name: 'Al Pacino', role: 'Lt. Hanna', profile: 'tmdb:/al.jpg', tmdbId: 1158 }],
    'the NFO cast gets TMDB\'s photo and id for the same person');
});

test('TMDB artwork options are ranked, and a hand-picked poster survives a refresh', async () => {
  RESPONSES['/3/movie/949/images'] = {
    posters: [
      { file_path: '/de.jpg', iso_639_1: 'de', vote_average: 9, vote_count: 50, width: 1000, height: 1500 },
      { file_path: '/en-low.jpg', iso_639_1: 'en', vote_average: 4, vote_count: 3, width: 1000, height: 1500 },
      { file_path: '/en-high.jpg', iso_639_1: 'en', vote_average: 6, vote_count: 9, width: 2000, height: 3000 },
      { file_path: '/textless.jpg', iso_639_1: null, vote_average: 8, vote_count: 20, width: 1000, height: 1500 },
      { file_path: '/../evil.jpg', iso_639_1: 'en', vote_average: 10, vote_count: 99 },
    ],
    backdrops: [
      { file_path: '/bd-en.jpg', iso_639_1: 'en', vote_average: 9, vote_count: 10 },
      { file_path: '/bd-clean.jpg', iso_639_1: null, vote_average: 5, vote_count: 10 },
    ],
  };
  const id = insert({ library_id: 1, type: 'movie', title: 'Heat', sort_title: 'heat', year: 1995, tmdb_id: 949, file_path: 'C:/m/heat-art.mkv' });
  const art = await tmdbArtwork(get('SELECT * FROM items WHERE id = ?', id));
  assert.deepEqual(art.poster.map((o) => o.ref), ['tmdb:/en-high.jpg', 'tmdb:/en-low.jpg', 'tmdb:/textless.jpg', 'tmdb:/de.jpg']);
  assert.deepEqual(art.backdrop.map((o) => o.ref), ['tmdb:/bd-clean.jpg', 'tmdb:/bd-en.jpg'], 'textless backgrounds first');
  assert.equal(art.poster[0].language, 'en');

  run("UPDATE items SET poster = 'tmdb:/textless.jpg', art_json = '{\"poster\":\"tmdb:/textless.jpg\"}' WHERE id = ?", id);
  await refreshItem(id);
  const row = get('SELECT * FROM items WHERE id = ?', id);
  assert.equal(row.poster, 'tmdb:/textless.jpg', 'the hand-picked poster stays');
  assert.equal(row.backdrop, 'tmdb:/heat-bg.jpg', 'unpicked artwork still comes from TMDB');
});
