import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, run, get } from '../server/db.js';
import { relatedFor } from '../server/related.js';

const t = Date.now();
let nextId = 1;

function add(fields) {
  const row = { id: nextId++, library_id: 1, type: 'movie', sort_title: fields.title.toLowerCase(), added_at: t, updated_at: t, ...fields };
  for (const k of ['genres', 'directors']) if (row[k]) row[k] = JSON.stringify(row[k]);
  if (row.cast) {
    row.cast_json = JSON.stringify(row.cast.map((c) => (typeof c === 'string' ? { name: c, role: null } : c)));
    delete row.cast;
  }
  const cols = Object.keys(row);
  run(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c]));
  return row.id;
}

const titles = (items) => items.map((i) => i.title);
const item = (id) => get('SELECT * FROM items WHERE id = ?', id);

let ids;
before(() => {
  openDb(':memory:');
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?), (2, 'TV', 'show', '[]', ?), (3, 'Private', 'movie', '[]', ?)", t, t, t);
  ids = {
    happyFeet: add({ title: 'Happy Feet', year: 2006, genres: ['Animation', 'Family', 'Comedy'], directors: ['George Miller'],
      cast: [{ name: 'Elijah Wood', role: 'Mumble' }, { name: 'Robin Williams', role: 'Ramon' }, 'Brittany Murphy'] }),
    happyFeet2: add({ title: 'Happy Feet Two', year: 2011, genres: ['Animation', 'Family', 'Comedy'], directors: ['George Miller'],
      cast: [{ name: 'Elijah Wood', role: 'Mumble' }, { name: 'Robin Williams', role: 'Ramon' }] }),
    robots: add({ title: 'Robots', year: 2005, genres: ['Animation', 'Family'], cast: ['Ewan McGregor', { name: 'Robin Williams', role: 'Fender' }] }),
    aladdin: add({ title: 'Aladdin', year: 1992, genres: ['Animation', 'Family'], cast: ['Scott Weinger', { name: 'Robin Williams', role: 'Genie' }] }),
    shining: add({ title: 'The Shining', year: 1980, genres: ['Horror'], cast: ['Jack Nicholson'] }),
    show: add({ title: 'Tales of Arcadia', type: 'show', library_id: 2, year: 2016, genres: ['Animation'], cast: [{ name: 'Elijah Wood', role: 'Lead' }] }),
    hidden: add({ title: 'Secret Film', library_id: 3, year: 2008, genres: ['Animation', 'Family', 'Comedy'], cast: ['Elijah Wood'] }),
  };
  run("INSERT INTO users (id, username, password_hash, is_admin, library_access, created_at) VALUES (1, 'admin', 'x', 1, NULL, ?), (2, 'kid', 'x', 0, '[1,2]', ?)", t, t);
});

after(() => closeDb());

const admin = { id: 1, isAdmin: true, libraryAccess: null };
const kid = { id: 2, isAdmin: false, libraryAccess: [1, 2] };

test('related movies are ranked by shared genres, director and cast', () => {
  const r = relatedFor(admin, item(ids.happyFeet));
  assert.equal(r.similar[0].title, 'Happy Feet Two', 'same director, genres and leads ranks first');
  assert.ok(titles(r.similar).includes('Robots'));
  assert.ok(!titles(r.similar).includes('The Shining'), 'unrelated titles are left out');
  assert.ok(!titles(r.similar).includes('Tales of Arcadia'), 'a movie page only suggests movies');
  assert.ok(!titles(r.similar).includes('Happy Feet'), 'never suggests itself');
});

test('rows for the first two cast members, movies first, with their roles', () => {
  const r = relatedFor(admin, item(ids.happyFeet));
  assert.deepEqual(r.byCast.map((c) => c.name), ['Elijah Wood', 'Robin Williams']);
  const elijah = r.byCast[0].items;
  assert.equal(elijah.at(-1).title, 'Tales of Arcadia', 'shows come after movies on a movie page');
  assert.deepEqual(titles(r.byCast[1].items), ['Happy Feet Two', 'Robots', 'Aladdin'], 'newest first');
  assert.equal(r.byCast[1].items.find((i) => i.title === 'Aladdin').role, 'Genie');
});

test('only titles from libraries the user can open', () => {
  assert.ok(titles(relatedFor(admin, item(ids.happyFeet)).byCast[0].items).includes('Secret Film'));
  const r = relatedFor(kid, item(ids.happyFeet));
  assert.ok(!titles(r.similar).includes('Secret Film'));
  assert.ok(!titles(r.byCast[0].items).includes('Secret Film'));
});

test('shows get related shows; empty rows are omitted', () => {
  const r = relatedFor(admin, item(ids.show));
  assert.deepEqual(r.similar, [], 'no other shows on the server');
  assert.deepEqual(titles(r.byCast[0].items).slice(0, 1), ['Happy Feet Two'], 'actor row still finds their movies');
  assert.equal(r.byCast.length, 1, 'only one cast member listed');
});
