// Home's "Watched by Others" row.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, run, get } from '../server/db.js';
import { loadUser } from '../server/auth.js';
import { watchedByOthers } from '../server/hubs.js';

const now = Date.now();
const DAY = 24 * 3600 * 1000;
let nextId = 1;

function add(fields) {
  const row = { id: nextId++, library_id: 1, type: 'movie', sort_title: fields.title.toLowerCase(), added_at: now, updated_at: now, ...fields };
  const cols = Object.keys(row);
  run(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c]));
  return row.id;
}

const watch = (userId, itemId, { at = now, watched = 1, position = 0 } = {}) => run(
  `INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(user_id, item_id) DO UPDATE SET position = excluded.position, watched = excluded.watched, updated_at = excluded.updated_at`,
  userId, itemId, position, watched, watched, at,
);

let ids;
before(() => {
  openDb(':memory:');
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'TV', 'show', '[]', ?), (3, 'Private', 'movie', '[]', ?)", now, now, now);
  run(`INSERT INTO users (id, username, password_hash, is_admin, library_access, created_at) VALUES
       (1, 'dave', 'x', 1, NULL, ?), (2, 'sam', 'x', 0, '[1,2]', ?), (3, 'alex', 'x', 0, NULL, ?), (4, 'jo', 'x', 0, NULL, ?)`, now, now, now, now);
  ids = {
    heat: add({ title: 'Heat', year: 1995 }),
    up: add({ title: 'Up', year: 2009 }),
    old: add({ title: 'Old Film', year: 1950 }),
    started: add({ title: 'Just Started', year: 2020 }),
    secret: add({ title: 'Secret', library_id: 3, year: 2001 }),
    show: add({ title: 'Bluey', type: 'show', library_id: 2, year: 2018 }),
  };
  ids.season = add({ title: 'Season 1', type: 'season', library_id: 2, parent_id: ids.show, show_id: ids.show, season_number: 1 });
  ids.ep1 = add({ title: 'Magic Xylophone', type: 'episode', library_id: 2, parent_id: ids.season, show_id: ids.show, season_number: 1, episode_number: 1 });
  ids.ep2 = add({ title: 'Hospital', type: 'episode', library_id: 2, parent_id: ids.season, show_id: ids.show, season_number: 1, episode_number: 2 });

  watch(3, ids.heat, { at: now - 2 * DAY }); // alex finished Heat two days ago
  watch(4, ids.heat, { at: now - 1 * DAY, watched: 0, position: 1200 }); // jo is part-way through it
  watch(3, ids.ep1, { at: now - 3 * DAY });
  watch(3, ids.ep2, { at: now - 5 * 3600 * 1000, watched: 0, position: 300 });
  watch(4, ids.up, { at: now - 4 * DAY });
  watch(3, ids.old, { at: now - 90 * DAY }); // too long ago
  watch(4, ids.started, { at: now - 1000, watched: 0, position: 10 }); // barely started: not "watched"
  watch(3, ids.secret, { at: now - 1000 }); // in a library sam can't open
  watch(1, ids.up, { at: now }); // dave's own
});

after(() => closeDb());

const titles = (list) => list.map((i) => i.title);

test('what others watched lately, one card per movie or show, newest first, with who and when', () => {
  const dave = loadUser(1);
  const list = watchedByOthers(dave, [1, 2, 3]);
  assert.deepEqual(titles(list), ['Secret', 'Bluey', 'Heat', 'Up']);
  const bluey = list.find((i) => i.title === 'Bluey');
  assert.equal(bluey.type, 'show', 'episodes make one card for their show');
  assert.deepEqual(bluey.watchedBy, ['alex']);
  assert.equal(bluey.watchedAt, now - 5 * 3600 * 1000, 'the most recent episode counts');
  assert.deepEqual(list.find((i) => i.title === 'Heat').watchedBy, ['jo', 'alex'], 'most recent first, finished or part-way');
  assert.equal(list.find((i) => i.title === 'Up').state.watched, true, 'the viewer\'s own marks on the card are theirs');
  assert.ok(!titles(list).includes('Old Film'), 'older than 60 days');
  assert.ok(!titles(list).includes('Just Started'), 'under 30 s in');
});

test('only titles in the viewer\'s libraries, and never their own viewing', () => {
  const sam = loadUser(2);
  const list = watchedByOthers(sam, [1, 2]);
  assert.ok(!titles(list).includes('Secret'));
  assert.deepEqual(list.find((i) => i.title === 'Up').watchedBy, ['dave', 'jo']);
  const alex = loadUser(3);
  assert.deepEqual(watchedByOthers(alex, [1, 2, 3]).find((i) => i.title === 'Heat').watchedBy, ['jo'], 'alex\'s own isn\'t listed');
  assert.deepEqual(watchedByOthers(sam, []), []);
});

test('someone who keeps their viewing to themselves is left out', () => {
  assert.equal(loadUser(4).shareWatching, true, 'shared unless turned off');
  run('UPDATE users SET share_watching = 0 WHERE id = 4');
  try {
    assert.equal(loadUser(4).shareWatching, false);
    const list = watchedByOthers(loadUser(1), [1, 2, 3]);
    assert.ok(!titles(list).includes('Up'), 'only jo had watched it (besides dave)');
    assert.deepEqual(list.find((i) => i.title === 'Heat').watchedBy, ['alex']);
  } finally {
    run('UPDATE users SET share_watching = 1 WHERE id = 4');
  }
});

test('the database upgrade gives existing users sharing on', () => {
  assert.equal(get("SELECT share_watching FROM users WHERE username = 'sam'").share_watching, 1);
  assert.ok(get("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'user_state_updated'"));
});
