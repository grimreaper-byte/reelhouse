// Content rating limits (server/ratings.js): ratings read as ages across rating systems, and an account with a limit
// seeing only what it allows everywhere titles are listed, opened, played or synced; Requests and TMDB's other films
// off for it; admins never limited; the person's pages and apps told when it changes; TMDB's US rating when the
// metadata country has none.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-ratings-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run, get } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { updateSettings } = await import('../server/settings.js');
const { ageOf, allows, ratingChoices, validLimit } = await import('../server/ratings.js');
const { refreshItem } = await import('../server/metadata/tmdb.js');

let server;
let base;
let admin;
let kid;
const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...H, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const signIn = async (username) => (await call('POST', '/api/auth/device', { body: { username, password: 'a long password', device: 'Test' } })).data.token;
const titles = (list) => list.map((i) => i.title).sort();

/** The events an open stream gets, for [token]. */
async function listen(token) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      }
    } catch {
      // closed
    }
  })();
  await new Promise((r) => setTimeout(r, 100));
  return { events, close: () => controller.abort() };
}

test('ratings read as ages, across rating systems and .nfo spellings', () => {
  const cases = {
    U: 0, G: 0, 'TV-Y': 0, 'TV-G': 0, 'TV-Y7': 7, PG: 8, 'TV-PG': 8, '12A': 12, 12: 12, 'PG-13': 13, 'TV-14': 14,
    15: 15, 'MA15+': 15, M: 15, 'FSK 16': 16, 16: 16, R: 17, 'TV-MA': 17, 18: 18, 'NC-17': 18, R18: 18, 'R18+': 18,
    'Rated PG-13': 13, 'UK:15': 15, 'GB: 12A': 12, 'gb:12a': 12, 'Rated R': 17, PG12: 12,
  };
  for (const [rating, age] of Object.entries(cases)) assert.equal(ageOf(rating), age, rating);
  for (const none of [null, undefined, '', 'NR', 'Not Rated', 'Unrated', 'ATP', 'Approved']) assert.equal(ageOf(none), null, String(none));
});

test('IMDb’s long ratings, with the reason, as some media managers write them into .nfo files', () => {
  const cases = {
    'Rated R for strong violence and language': 17,
    'Rated NC-17 for explicit sexual content': 18,
    'Rated PG-13 for intense sequences of sci-fi violence': 13,
    'Rated PG for some mild language': 8,
    'Rated G': 0,
    'TV-MA for language': 17,
  };
  for (const [rating, age] of Object.entries(cases)) assert.equal(ageOf(rating), age, rating);
});

test('a limit allows ratings up to its age; titles without one only when ticked', () => {
  assert.equal(allows(null, 'R'), true);
  const twelve = { maxAge: 12, allowUnrated: false };
  assert.deepEqual(['U', 'PG', '12A', '12', 'PG-13', '15', 'TV-14', 'R', null].map((r) => allows(twelve, r)),
    [true, true, true, true, false, false, false, false, false]);
  assert.equal(allows({ maxAge: 12, allowUnrated: true }, null), true);
  assert.equal(allows({ maxAge: 12, allowUnrated: true }, 'Not Rated'), true);
  assert.equal(allows({ maxAge: 0, allowUnrated: false }, 'U'), true);
  assert.equal(allows({ maxAge: 0, allowUnrated: false }, 'PG'), false);
});

test('the choices are the metadata country’s ratings; limits are checked', () => {
  assert.deepEqual(ratingChoices('GB').map((c) => c.label), ['U', 'PG', '12A and 12', '15']);
  assert.deepEqual(ratingChoices('US').map((c) => c.maxAge), [0, 7, 8, 13, 14, 17]);
  assert.deepEqual(ratingChoices('DE').map((c) => c.maxAge), [6, 12, 15, 16]);
  assert.deepEqual(validLimit(null, true), { maxAge: null, allowUnrated: false });
  assert.deepEqual(validLimit('12', 1), { maxAge: 12, allowUnrated: true });
  assert.throws(() => validLimit(30));
  assert.throws(() => validLimit('twelve'));
});

before(async () => {
  openDb(':memory:');
  const t = Date.now();
  const file = path.join(dataDir, 'film.mp4');
  fs.writeFileSync(file, 'x');
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'TV', 'show', '[]', ?)", t, t);
  const cast = JSON.stringify([{ name: 'Ann Actor', role: 'Someone' }]);
  const films = [
    [1, 'Pixie Film', 'PG', '["Family"]'],
    [2, 'Fifteen Film', '15', '["Drama"]'],
    [3, 'Grim Film', 'R', '["Horror"]'],
    [4, 'Home Video', null, '["Family"]'],
  ];
  for (const [id, title, rating, genres] of films) {
    run(`INSERT INTO items (id, library_id, type, title, sort_title, content_rating, genres, cast_json, file_path, duration, added_at, updated_at)
         VALUES (?, 1, 'movie', ?, ?, ?, ?, ?, ?, 6000, ?, ?)`, id, title, title.toLowerCase(), rating, genres, cast, `${file}.${id}`, t - id, t);
  }
  // Two shows: one rated for teenagers (its episodes too, as they go by the show), one for everyone.
  for (const [show, title, rating] of [[20, 'Teen Show', 'TV-14'], [30, 'Kids Show', 'TV-Y']]) {
    run(`INSERT INTO items (id, library_id, type, title, sort_title, content_rating, added_at, updated_at) VALUES (?, 2, 'show', ?, ?, ?, ?, ?)`,
      show, title, title.toLowerCase(), rating, t, t);
    run(`INSERT INTO items (id, library_id, type, title, sort_title, parent_id, show_id, season_number, added_at, updated_at)
         VALUES (?, 2, 'season', 'Season 1', 'season 1', ?, ?, 1, ?, ?)`, show + 1, show, show, t, t);
    for (const n of [1, 2]) {
      run(`INSERT INTO items (id, library_id, type, title, sort_title, parent_id, show_id, season_number, episode_number, file_path, duration, added_at, updated_at)
           VALUES (?, 2, 'episode', ?, ?, ?, ?, 1, ?, ?, 1500, ?, ?)`, show + 1 + n, `${title} ${n}`, `${title} ${n}`.toLowerCase(), show + 1, show, n, `${file}.${show}.${n}`, t, t);
    }
  }
  const pw = await hashPassword('a long password');
  run(`INSERT INTO users (id, username, password_hash, is_admin, share_watching, max_age, allow_unrated, created_at) VALUES
       (1, 'dave', ?, 1, 1, NULL, 0, ?), (2, 'kid', ?, 0, 1, 12, 0, ?)`, pw, t, pw, t);
  // Part-way through things, for Continue Watching; the admin's for Watched by Others.
  for (const [user, item] of [[2, 1], [2, 3], [2, 22], [2, 32], [1, 1], [1, 2]]) {
    run('INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (?, ?, 300, 0, 0, ?)', user, item, t);
  }
  updateSettings({ tmdbApiKey: 'test-key', requestsEnabled: true });
  // A TMDB key turns Requests on; TMDB itself is never asked (person pages would): it answers "not found" here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).startsWith('https://api.themoviedb.org/')
    ? Promise.resolve(new Response('{}', { status: 404 }))
    : realFetch(url, opts));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await signIn('dave');
  kid = await signIn('kid');
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a limited account sees only what its limit allows, wherever titles are listed', async () => {
  const libs = (await call('GET', '/api/libraries', { token: kid })).data.libraries;
  assert.deepEqual(libs.map((l) => l.count), [1, 1], 'the sidebar counts what they can see');
  assert.deepEqual(titles((await call('GET', '/api/libraries/1/items', { token: kid })).data.items), ['Pixie Film']);
  assert.deepEqual(titles((await call('GET', '/api/libraries/2/items', { token: kid })).data.items), ['Kids Show']);
  assert.deepEqual((await call('GET', '/api/libraries/1/genres', { token: kid })).data.genres.map((g) => g.genre), ['Family']);

  const found = (await call('GET', '/api/search?q=Film', { token: kid })).data;
  assert.deepEqual(titles(found.movies), ['Pixie Film']);
  assert.deepEqual(titles((await call('GET', '/api/search?q=Show', { token: kid })).data.shows), ['Kids Show']);
  assert.deepEqual(titles((await call('GET', '/api/search?q=Ann', { token: kid })).data.people), ['Pixie Film']);

  const { hubs } = (await call('GET', '/api/hubs/home', { token: kid })).data;
  const row = (id) => hubs.find((h) => h.id === id)?.items || [];
  assert.deepEqual(titles(row('continue')), ['Kids Show 1', 'Pixie Film'], 'Continue Watching');
  assert.deepEqual(titles(row('others')), ['Pixie Film'], 'Watched by Others');
  assert.ok(row('recent-1').every((i) => i.title === 'Pixie Film'), 'Recently added films');
  assert.ok(!row('recent-2').some((i) => /Teen/.test(i.title) || i.showId === 20), 'Recently added episodes');

  const person = (await call('GET', '/api/people?name=Ann%20Actor', { token: kid })).data;
  assert.deepEqual(titles(person.items), ['Pixie Film']);
  assert.equal(person.others.status, 'off', 'no TMDB films for a limited account');
  const related = (await call('GET', '/api/items/1/related', { token: kid })).data;
  assert.ok(related.byCast.every((p) => p.items.every((i) => i.title === 'Pixie Film')));
  assert.ok(related.similar.every((i) => i.title === 'Pixie Film'));

  // The admin sees everything.
  assert.deepEqual(titles((await call('GET', '/api/libraries/1/items', { token: admin })).data.items), ['Fifteen Film', 'Grim Film', 'Home Video', 'Pixie Film']);
  assert.deepEqual((await call('GET', '/api/libraries', { token: admin })).data.libraries.map((l) => l.count), [4, 2]);
});

test('anything over the limit can’t be opened, played or pictured, a show’s episodes going by the show', async () => {
  assert.equal((await call('GET', '/api/items/1', { token: kid })).status, 200);
  for (const id of [2, 3, 4, 20, 21, 22]) assert.equal((await call('GET', `/api/items/${id}`, { token: kid })).status, 404, `item ${id}`);
  assert.equal((await call('GET', '/api/items/32', { token: kid })).status, 200);
  assert.equal((await call('POST', '/api/playback/3', { token: kid, body: {} })).status, 404);
  assert.equal((await call('POST', '/api/playback/22', { token: kid, body: {} })).status, 404);
  assert.equal((await fetch(`${base}/api/images/3/poster`, { headers: { authorization: `Bearer ${kid}` } })).status, 404);
  assert.equal((await call('POST', '/api/items/3/watched', { token: kid, body: { watched: true } })).status, 404);
  assert.equal((await call('GET', '/api/items/3', { token: admin })).status, 200);
});

test('Kodi’s library sync leaves out what the limit hides', async () => {
  const ids = async (lib) => (await call('GET', `/api/sync/libraries/${lib}/items`, { token: kid })).data.items.map((i) => i.id);
  assert.deepEqual(await ids(1), [1]);
  assert.deepEqual(await ids(2), [30, 31, 32, 33]);
  assert.deepEqual((await call('POST', '/api/sync/items', { token: kid, body: { ids: [1, 2, 3, 22, 32] } })).data.items.map((i) => i.id), [1, 32]);
  assert.deepEqual((await call('POST', '/api/sync/states', { token: kid, body: { ids: [1, 3, 22] } })).data.states.map((s) => s.id), [1]);
});

test('Requests is off for a limited account, on for others', async () => {
  assert.equal((await call('GET', '/api/me', { token: kid })).data.requests.enabled, false);
  assert.equal((await call('GET', '/api/me', { token: admin })).data.requests.enabled, true);
  const refused = await call('GET', '/api/requests', { token: kid });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.off, true);
  assert.equal((await call('GET', '/api/requests', { token: admin })).status, 200);
});

test('an admin sets the limit; only that person’s pages and apps hear of it; admins are never limited', async () => {
  const kidEvents = await listen(kid);
  const adminEvents = await listen(admin);
  try {
    const { users, ratingChoices: choices } = (await call('GET', '/api/users', { token: admin })).data;
    assert.ok(choices.length > 0, 'the choices come with the list');
    const listed = users.find((u) => u.username === 'kid');
    assert.deepEqual(listed.contentLimit, { maxAge: 12, allowUnrated: false });
    assert.ok(listed.contentLimitLabel);

    assert.equal((await call('PATCH', '/api/users/2', { token: admin, body: { maxAge: 40 } })).status, 400);
    const saved = await call('PATCH', '/api/users/2', { token: admin, body: { maxAge: 15, allowUnrated: true } });
    assert.deepEqual(saved.data.user.contentLimit, { maxAge: 15, allowUnrated: true });
    await new Promise((r) => setTimeout(r, 150));
    const told = kidEvents.events.filter((e) => e.type === 'library');
    assert.equal(told.length, 1);
    assert.equal(told[0].data.deleted, true, 'as a deleted library: apps look at everything again');
    assert.equal(told[0].data.libraryId, null);
    assert.equal(adminEvents.events.filter((e) => e.type === 'library').length, 0, 'nobody else is told');
    assert.equal(kidEvents.events.filter((e) => e.type === 'requests').at(-1)?.data.enabled, false);
    assert.equal(adminEvents.events.filter((e) => e.type === 'requests').at(-1)?.data.enabled, true);
    assert.deepEqual(titles((await call('GET', '/api/libraries/1/items', { token: kid })).data.items), ['Fifteen Film', 'Home Video', 'Pixie Film']);

    // Saving the same again tells nobody.
    await call('PATCH', '/api/users/2', { token: admin, body: { maxAge: 15, allowUnrated: true } });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(kidEvents.events.filter((e) => e.type === 'library').length, 1);

    // No limit: everything, and Requests back.
    await call('PATCH', '/api/users/2', { token: admin, body: { maxAge: null } });
    assert.equal((await call('GET', '/api/libraries/1/items', { token: kid })).data.items.length, 4);
    assert.equal((await call('GET', '/api/me', { token: kid })).data.requests.enabled, true);

    // An admin's limit is never kept.
    await call('PATCH', '/api/users/1', { token: admin, body: { maxAge: 0 } });
    assert.equal(get('SELECT max_age FROM users WHERE id = 1').max_age, null);
    const made = await call('POST', '/api/users', { token: admin, body: { username: 'little', password: 'a long password', maxAge: 8 } });
    assert.deepEqual(made.data.user.contentLimit, { maxAge: 8, allowUnrated: false });
    const boss = await call('POST', '/api/users', { token: admin, body: { username: 'boss', password: 'a long password', isAdmin: true, maxAge: 8 } });
    assert.equal(boss.data.user.contentLimit, null);
  } finally {
    kidEvents.close();
    adminEvents.close();
  }
});

test('TMDB’s US rating when the metadata country has none', async () => {
  updateSettings({ metadataLanguage: 'en-GB' });
  const t = Date.now();
  run(`INSERT INTO items (id, library_id, type, title, sort_title, tmdb_id, added_at, updated_at) VALUES (50, 1, 'movie', 'US Only', 'us only', 99, ?, ?),
       (51, 1, 'movie', 'Both', 'both', 98, ?, ?)`, t, t, t, t);
  run(`INSERT INTO items (id, library_id, type, title, sort_title, tmdb_id, added_at, updated_at) VALUES (52, 2, 'show', 'US Show', 'us show', 97, ?, ?)`, t, t);
  const answers = {
    '/movie/99': { id: 99, title: 'US Only', release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13' }] }, { iso_3166_1: 'GB', release_dates: [{ certification: '' }] }] } },
    '/movie/98': { id: 98, title: 'Both', release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }, { iso_3166_1: 'GB', release_dates: [{ certification: '15' }] }] } },
    '/tv/97': { id: 97, name: 'US Show', content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] } },
  };
  const guarded = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const answer = answers[new URL(url).pathname.replace('/3', '')];
    return answer ? new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 });
  };
  try {
    for (const id of [50, 51, 52]) await refreshItem(id);
  } finally {
    globalThis.fetch = guarded;
    updateSettings({ metadataLanguage: 'en-US' });
  }
  const rating = (id) => get('SELECT content_rating FROM items WHERE id = ?', id).content_rating;
  assert.equal(rating(50), 'PG-13', 'none for GB: the US one');
  assert.equal(rating(51), '15', 'GB’s own when there is one');
  assert.equal(rating(52), 'TV-MA', 'shows likewise');
});
