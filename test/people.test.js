// A cast member's page: their titles on the server, and their other movies from TMDB (canned answers, no network).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, run } from '../server/db.js';
import { updateSettings } from '../server/settings.js';
import { personPage, clearPeopleCache, yearsBetween } from '../server/people.js';
import { mergeCast } from '../server/scanner/local.js';

const t = Date.now();
let nextId = 1;

function add(fields) {
  const row = { id: nextId++, library_id: 1, type: 'movie', sort_title: fields.title.toLowerCase(), added_at: t, updated_at: t, ...fields };
  if (row.directors) row.directors = JSON.stringify(row.directors);
  if (row.cast) {
    row.cast_json = JSON.stringify(row.cast);
    delete row.cast;
  }
  const cols = Object.keys(row);
  run(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c]));
  return row.id;
}

const ELSA = { name: 'Idina Menzel', role: 'Elsa (voice)', profile: 'tmdb:/idina.jpg' };

const RESPONSES = {
  '/3/movie/109445/credits': { cast: [{ id: 19394, name: 'Idina Menzel', character: 'Elsa (voice)' }] },
  '/3/person/19394': (u) => (u.searchParams.has('append_to_response') ? IDINA : { id: 19394, biography: 'An English biography.' }),
  '/3/search/person': { results: [
    { id: 11, name: 'Chris Evans', known_for_department: 'Acting', profile_path: '/captain.jpg' },
    { id: 12, name: 'Chris Evans', known_for_department: 'Acting', profile_path: '/presenter.jpg' },
  ] },
  '/3/person/12': { id: 12, name: 'Chris Evans', profile_path: '/presenter.jpg', biography: '', combined_credits: { cast: [
    { media_type: 'movie', id: 42, title: 'A Presenter Film', release_date: '2004-01-01', character: 'Host Character' },
  ] } },
};

const IDINA = {
  id: 19394, name: 'Idina Menzel', profile_path: '/idina-new.jpg',
  biography: 'Idina Kim Menzel is an American actress and singer.', birthday: '1971-05-30', deathday: null,
  place_of_birth: ' Queens, New York, USA ',
  combined_credits: { cast: [
    { media_type: 'movie', id: 109445, title: 'Frozen', release_date: '2013-11-20', character: 'Elsa (voice)', poster_path: '/frozen.jpg' },
    { media_type: 'movie', id: 330457, title: 'Frozen II', release_date: '2019-11-20', character: 'Elsa (voice)', poster_path: '/frozen2.jpg' },
    { media_type: 'movie', id: 1074, title: 'Rent', release_date: '2005-11-23', character: 'Maureen Johnson', poster_path: '/rent.jpg' },
    { media_type: 'movie', id: 4523, title: 'Enchanted', release_date: '2007-11-20', character: 'Nancy Tremaine', poster_path: '/enchanted.jpg' },
    { media_type: 'movie', id: 777, title: 'Two Parts', release_date: '2010-01-01', character: 'Ann', poster_path: null },
    { media_type: 'movie', id: 777, title: 'Two Parts', release_date: '2010-01-01', character: 'Ann’s sister' },
    { media_type: 'movie', id: 888, title: 'Untitled Project', release_date: '', character: 'Lead' },
    { media_type: 'movie', id: 999, title: 'Making of Frozen', release_date: '2014-01-01', character: 'Herself' },
    { media_type: 'movie', id: 1000, title: 'Adult Film', release_date: '2001-01-01', character: 'X', adult: true },
    { media_type: 'movie', id: 2000, title: 'Uncut Gems', release_date: '2019-08-30', character: 'Dinah' },
    { media_type: 'movie', id: 3000, title: 'Disenchanted', release_date: '2022-11-16', character: 'Nancy Tremaine' },
    { media_type: 'tv', id: 1418, name: 'Glee', first_air_date: '2009-05-19', character: 'Shelby Corcoran', episode_count: 15 },
    { media_type: 'tv', id: 5000, name: 'Some Talk Show', first_air_date: '2015-01-01', character: 'Self - Guest' },
  ] },
};

let realFetch;
const requested = [];
let failing = false;

let ids;
before(() => {
  openDb(':memory:');
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'TV', 'show', '[]', ?), (3, 'Private', 'movie', '[]', ?)", t, t, t);
  run("INSERT INTO users (id, username, password_hash, is_admin, library_access, created_at) VALUES (1, 'admin', 'x', 1, NULL, ?), (2, 'kid', 'x', 0, '[1,2]', ?)", t, t);
  ids = {
    frozen: add({ title: 'Frozen', year: 2013, tmdb_id: 109445, cast: [{ name: 'Kristen Bell', role: 'Anna (voice)' }, ELSA] }),
    // On the server but its cast list (first 20 billed) leaves her out: TMDB's credits put it on her page.
    enchanted: add({ title: 'Enchanted', year: 2007, tmdb_id: 4523, cast: [{ name: 'Amy Adams', role: 'Giselle' }] }),
    // Not matched on TMDB: found by title and year.
    rent: add({ title: 'Rent', year: 2005, cast: [] }),
    // Directed by her (made up): listed as director.
    directed: add({ title: 'Her Short', year: 2020, directors: ['Idina Menzel'], cast: [] }),
    glee: add({ title: 'Glee', type: 'show', library_id: 2, year: 2009, tmdb_id: 1418, cast: [] }),
    // In a library the kid can't see: not "on the server" for them.
    hidden: add({ title: 'Frozen II', library_id: 3, year: 2019, tmdb_id: 330457, cast: [ELSA] }),
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    requested.push(u.pathname + u.search);
    if (failing) return new Response('{}', { status: 503 });
    const answer = RESPONSES[u.pathname];
    const body = typeof answer === 'function' ? answer(u) : answer;
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  closeDb();
});

beforeEach(() => {
  clearPeopleCache();
  requested.length = 0;
  failing = false;
  updateSettings({ tmdbApiKey: '0123456789abcdef0123456789abcdef', metadataLanguage: 'en-US' });
});

const admin = { id: 1, isAdmin: true, libraryAccess: null };
const kid = { id: 2, isAdmin: false, libraryAccess: [1, 2] };
const row = (id) => ({ id, type: 'movie', tmdb_id: 109445 });
const titles = (list) => list.map((i) => i.title);

test('without a TMDB key: their titles on the server by name, newest first, and no other movies', async () => {
  updateSettings({ tmdbApiKey: '' });
  const p = await personPage(admin, 'Idina Menzel', row(ids.frozen));
  assert.deepEqual(titles(p.items), ['Her Short', 'Frozen II', 'Frozen']);
  assert.equal(p.items.find((i) => i.title === 'Frozen').role, 'Elsa (voice)');
  assert.equal(p.items.find((i) => i.title === 'Her Short').role, null);
  assert.equal(p.items.find((i) => i.title === 'Her Short').directed, true);
  assert.equal(p.items.find((i) => i.title === 'Frozen').directed, undefined);
  assert.equal(p.profile, '/api/tmdb-image/profile/idina.jpg');
  assert.deepEqual(p.others, { status: 'off', items: [] });
  assert.equal(p.info, null);
  assert.equal(requested.length, 0);
});

test('who they are: biography, birthday with age, birthplace', async () => {
  const p = await personPage(admin, 'Idina Menzel', row(ids.frozen));
  assert.deepEqual(p.info, {
    biography: 'Idina Kim Menzel is an American actress and singer.', birthday: '1971-05-30', deathday: null,
    birthplace: 'Queens, New York, USA', age: yearsBetween('1971-05-30'),
  });
  assert.ok(p.info.age >= 55);
  const q = await personPage(admin, 'Chris Evans', null);
  assert.equal(q.info, null, 'nothing known about them: no info');
});

test('a biography missing in the metadata language comes in English', async () => {
  updateSettings({ metadataLanguage: 'de-DE' });
  const original = IDINA.biography;
  IDINA.biography = '';
  try {
    const p = await personPage(admin, 'Idina Menzel', row(ids.frozen));
    assert.equal(p.info.biography, 'An English biography.');
    assert.ok(requested.some((r) => r.startsWith('/3/person/19394?') && r.includes('language=en-US') && !r.includes('append_to_response')));
  } finally {
    IDINA.biography = original;
  }
});

test('ages: on their birthday, the day before, and at death', () => {
  const today = new Date(2026, 9, 20); // 20 October 2026
  assert.equal(yearsBetween('1971-10-20', null, today), 55);
  assert.equal(yearsBetween('1971-10-21', null, today), 54);
  assert.equal(yearsBetween('1951-07-21', '2014-08-11'), 63);
  assert.equal(yearsBetween('1951-07-21', '2014-07-20'), 62);
  assert.equal(yearsBetween(null), null);
  assert.equal(yearsBetween('1951', null, today), null);
});

test('with TMDB: titles on the server it credits them for are added; the rest of their movies are listed', async () => {
  const p = await personPage(admin, 'Idina Menzel', row(ids.frozen));
  assert.ok(requested.some((r) => r.startsWith('/3/movie/109445/credits')), 'found through the title she was picked from');
  assert.ok(!requested.some((r) => r.startsWith('/3/search/person')), 'no name search needed');
  assert.deepEqual(titles(p.items), ['Her Short', 'Frozen II', 'Frozen', 'Glee', 'Enchanted', 'Rent']);
  assert.equal(p.items.find((i) => i.title === 'Enchanted').role, 'Nancy Tremaine', 'its part comes from TMDB');
  assert.equal(p.items.find((i) => i.title === 'Glee').role, 'Shelby Corcoran');
  assert.equal(p.others.status, 'ok');
  assert.deepEqual(titles(p.others.items), ['Disenchanted', 'Uncut Gems', 'Two Parts', 'Untitled Project'],
    'not on the server, newest first, undated last; no TV, no appearances as herself, no adult titles');
  const two = p.others.items.find((o) => o.title === 'Two Parts');
  assert.equal(two.role, 'Ann / Ann’s sister', 'two parts in one movie make one entry');
  assert.equal(two.poster, null);
  assert.deepEqual(p.others.items[0], { tmdbId: 3000, title: 'Disenchanted', year: 2022, role: 'Nancy Tremaine', poster: null });
});

test('a movie in a library someone can\'t see counts as not on the server for them', async () => {
  const p = await personPage(kid, 'Idina Menzel', row(ids.frozen));
  assert.ok(!titles(p.items).includes('Frozen II'));
  const f2 = p.others.items.find((o) => o.title === 'Frozen II');
  assert.deepEqual(f2, { tmdbId: 330457, title: 'Frozen II', year: 2019, role: 'Elsa (voice)', poster: '/api/tmdb-image/poster/frozen2.jpg' });
});

test('answers are cached, and a TMDB id in the cast list skips the lookup', async () => {
  await personPage(admin, 'Idina Menzel', row(ids.frozen));
  const first = requested.length;
  await personPage(admin, 'Idina Menzel', row(ids.frozen));
  assert.equal(requested.length, first, 'the second visit asks TMDB nothing');

  clearPeopleCache();
  requested.length = 0;
  run('UPDATE items SET cast_json = ? WHERE id = ?', JSON.stringify([{ ...ELSA, tmdbId: 19394 }]), ids.frozen);
  const p = await personPage(admin, 'Idina Menzel', row(ids.frozen));
  assert.deepEqual(requested.map((r) => r.split('?')[0]), ['/3/person/19394']);
  assert.equal(p.others.status, 'ok');
  run('UPDATE items SET cast_json = ? WHERE id = ?', JSON.stringify([ELSA]), ids.frozen);
});

test('someone only known by name: the search result with the same photo is chosen', async () => {
  const p = await personPage(admin, 'Chris Evans', null);
  assert.deepEqual(p.items, []);
  assert.ok(requested.some((r) => r.startsWith('/3/search/person')));
  assert.ok(requested.some((r) => r.startsWith('/3/person/11')), 'without a photo: the first actor of that name');

  clearPeopleCache();
  add({ title: 'Presenter Thing', year: 2003, cast: [{ name: 'Chris Evans', role: 'Host', profile: 'tmdb:/presenter.jpg' }] });
  const q = await personPage(admin, 'Chris Evans', null);
  assert.deepEqual(titles(q.others.items), ['A Presenter Film'], 'the one whose photo matches the cast list\'s');
  assert.equal(q.profile, '/api/tmdb-image/profile/presenter.jpg');
});

test('when TMDB fails the page still shows what is on the server', async () => {
  failing = true;
  const p = await personPage(admin, 'Idina Menzel', row(ids.frozen));
  assert.equal(p.others.status, 'failed');
  assert.deepEqual(p.others.items, []);
  assert.ok(titles(p.items).includes('Frozen'));
});

test('TMDB ids survive an NFO cast list', () => {
  const merged = mergeCast([{ name: 'Idina Menzel', role: 'Elsa', profile: null }], [{ ...ELSA, tmdbId: 19394 }]);
  assert.deepEqual(merged, [{ name: 'Idina Menzel', role: 'Elsa', profile: 'tmdb:/idina.jpg', tmdbId: 19394 }]);
});
