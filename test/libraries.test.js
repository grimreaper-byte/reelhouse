import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openDb, closeDb, run, get, all } from '../server/db.js';
import { addLibraryPaths, mergeLibraries, sameNamedLibrary } from '../server/libraries.js';
import { mergeSameNamedShows, pruneEmptyContainers, renameShows, showName } from '../server/scanner/index.js';

before(() => openDb(':memory:'));
after(() => closeDb());

const t = 1_000;
function library(name, type, paths) {
  return Number(run('INSERT INTO libraries (name, type, paths, created_at) VALUES (?, ?, ?, ?)', name, type, JSON.stringify(paths), t).lastInsertRowid);
}
function item(fields) {
  const f = { title: 'x', sort_title: 'x', added_at: t, updated_at: t, ...fields };
  const cols = Object.keys(f);
  return Number(run(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...Object.values(f)).lastInsertRowid);
}
function user(name, access) {
  return Number(run('INSERT INTO users (username, password_hash, library_access, created_at) VALUES (?, ?, ?, ?)', name, 'x', access ? JSON.stringify(access) : null, t).lastInsertRowid);
}

beforeEach(() => {
  run('DELETE FROM user_state');
  run('DELETE FROM items');
  run('DELETE FROM libraries');
  run('DELETE FROM users');
});

test('a library is found by name and kind, whatever the case or spaces', () => {
  const movies = library('Movies', 'movie', ['/d1/Movies']);
  library('Movies', 'show', ['/d1/TV']);
  assert.equal(sameNamedLibrary(' movies ', 'movie').id, movies);
  assert.equal(sameNamedLibrary('Movies', 'movie', movies), null);
  assert.equal(sameNamedLibrary('Films', 'movie'), null);
  assert.deepEqual(addLibraryPaths(movies, ['/d2/Movies', '/d1/Movies']), ['/d1/Movies', '/d2/Movies']);
});

test('merging two "Movies" libraries moves the films and keeps their watch history and access', () => {
  const first = library('Movies', 'movie', ['/d1/Movies']);
  const second = library('Movies', 'movie', ['/d2/Movies', '/d1/Movies']);
  const a = item({ library_id: first, type: 'movie', title: 'A', file_path: '/d1/Movies/A.mkv' });
  const b = item({ library_id: second, type: 'movie', title: 'B', file_path: '/d2/Movies/B.mkv' });
  item({ library_id: second, type: 'movie', title: 'A again', file_path: '/d1/Movies/A.mkv' }); // that folder was in both
  const kid = user('kid', [second]);
  const other = user('other', [999]);
  run('INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (?, ?, 1234, 0, 0, ?)', kid, b, t);

  const { target, moved } = mergeLibraries(second, first);
  assert.equal(target.id, first);
  assert.equal(moved, 1);
  assert.deepEqual(JSON.parse(target.paths), ['/d1/Movies', '/d2/Movies']);
  assert.deepEqual(all('SELECT id FROM items WHERE library_id = ? ORDER BY id', first).map((r) => r.id), [a, b]);
  assert.equal(get('SELECT position FROM user_state WHERE item_id = ?', b).position, 1234);
  assert.equal(get('SELECT COUNT(*) AS n FROM libraries WHERE id = ?', second).n, 0);
  assert.deepEqual(JSON.parse(get('SELECT library_access FROM users WHERE id = ?', kid).library_access), [first]);
  assert.deepEqual(JSON.parse(get('SELECT library_access FROM users WHERE id = ?', other).library_access), [999]);
});

test('only libraries of the same kind merge', () => {
  const movies = library('Movies', 'movie', ['/m']);
  const shows = library('Movies', 'show', ['/s']);
  assert.throws(() => mergeLibraries(shows, movies), /same kind/);
  assert.throws(() => mergeLibraries(movies, movies), /same library/);
  assert.throws(() => mergeLibraries(movies, 12345), /No such library/);
});

test('a show whose folder is on two drives becomes one show, seasons and all, with its history', () => {
  const tv = library('TV Shows', 'show', ['/d1/TV', '/d2/TV']);
  const show1 = item({ library_id: tv, type: 'show', title: 'Bluey', folder_path: '/d1/TV/Bluey' });
  const s1 = item({ library_id: tv, type: 'season', parent_id: show1, show_id: show1, season_number: 1 });
  const e1 = item({ library_id: tv, type: 'episode', parent_id: s1, show_id: show1, season_number: 1, episode_number: 1, file_path: '/d1/TV/Bluey/S01E01.mkv' });
  const show2 = item({ library_id: tv, type: 'show', title: 'Bluey', folder_path: '/d2/TV/Bluey' });
  const s1b = item({ library_id: tv, type: 'season', parent_id: show2, show_id: show2, season_number: 1 });
  const e2 = item({ library_id: tv, type: 'episode', parent_id: s1b, show_id: show2, season_number: 1, episode_number: 2, file_path: '/d2/TV/Bluey/S01E02.mkv' });
  const s2 = item({ library_id: tv, type: 'season', parent_id: show2, show_id: show2, season_number: 2 });
  const e3 = item({ library_id: tv, type: 'episode', parent_id: s2, show_id: show2, season_number: 2, episode_number: 1, file_path: '/d2/TV/Bluey/S02E01.mkv' });
  // A different name stays a different show.
  const other = item({ library_id: tv, type: 'show', title: 'Bluey', folder_path: '/d2/TV/Bluey (2018)' });
  const otherSeason = item({ library_id: tv, type: 'season', parent_id: other, show_id: other, season_number: 1 });
  item({ library_id: tv, type: 'episode', parent_id: otherSeason, show_id: other, season_number: 1, episode_number: 1, file_path: '/d2/TV/Bluey (2018)/S01E01.mkv' });
  const viewer = user('viewer', null);
  run('INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (?, ?, 0, 1, 1, ?)', viewer, e3, t);

  assert.equal(mergeSameNamedShows(tv), 1);
  pruneEmptyContainers(tv);
  const shows = all("SELECT id FROM items WHERE library_id = ? AND type = 'show' ORDER BY id", tv).map((r) => r.id);
  assert.deepEqual(shows, [show1, other]);
  assert.deepEqual(all('SELECT id, parent_id, show_id FROM items WHERE id IN (?, ?, ?) ORDER BY id', e1, e2, e3).map((r) => [r.parent_id, r.show_id]),
    [[s1, show1], [s1, show1], [s2, show1]]);
  assert.equal(get('SELECT parent_id FROM items WHERE id = ?', s2).parent_id, show1);
  assert.equal(get('SELECT COUNT(*) AS n FROM items WHERE id = ?', s1b).n, 0);
  assert.equal(get('SELECT watched FROM user_state WHERE item_id = ?', e3).watched, 1);
});

test('show names match by folder name, or by the name in files lying in a library folder', () => {
  assert.equal(showName('/d1/TV/The Office'), showName('/d2/TV/the office'));
  assert.notEqual(showName('/d1/TV/Bluey'), showName('/d1/TV/Bluey (2018)'));
  assert.equal(showName('/d1/TV/::office'), 'office');
  assert.equal(showName('/rec/New_ Mock The Week'), showName('/rec/Mock The Week'));
  assert.notEqual(showName('/d1/TV/New Girl'), showName('/d1/TV/Girl'));
});

test('a recording\'s "New_ …" show joins its plain-named one, which is kept even when younger', () => {
  const rec = library('Recorded TV', 'show', ['/rec']);
  const fresh = item({ library_id: rec, type: 'show', title: 'New Mock The Week', folder_path: '/rec/New_ Mock The Week' });
  const s2 = item({ library_id: rec, type: 'season', parent_id: fresh, show_id: fresh, season_number: 2 });
  const e8 = item({ library_id: rec, type: 'episode', parent_id: s2, show_id: fresh, season_number: 2, episode_number: 8, file_path: '/rec/New_ Mock The Week/New_ Mock The Week - S02E08 -.ts' });
  const plain = item({ library_id: rec, type: 'show', title: 'Mock The Week', folder_path: '/rec/Mock The Week', tmdb_id: 1406 });
  const s2b = item({ library_id: rec, type: 'season', parent_id: plain, show_id: plain, season_number: 2 });
  item({ library_id: rec, type: 'episode', parent_id: s2b, show_id: plain, season_number: 2, episode_number: 7, file_path: '/rec/Mock The Week/Mock The Week - S02E07 -.ts' });

  assert.equal(mergeSameNamedShows(rec), 1);
  pruneEmptyContainers(rec);
  assert.deepEqual(all("SELECT id FROM items WHERE library_id = ? AND type = 'show'", rec).map((r) => r.id), [plain]);
  assert.deepEqual({ ...get('SELECT parent_id, show_id FROM items WHERE id = ?', e8) }, { parent_id: s2b, show_id: plain });
});

test('a show named from a "New_ …" folder before takes the plain name and is looked up again, unless matched', () => {
  const rec = library('Recorded TV', 'show', ['/rec']);
  const jury = item({ library_id: rec, type: 'show', title: 'New The Jury', folder_path: '/rec/New_ The Jury', metadata_at: t });
  const matched = item({ library_id: rec, type: 'show', title: 'Wrong Show', folder_path: '/rec/New_ Other', tmdb_id: 7, metadata_at: t });
  const locked = item({ library_id: rec, type: 'show', title: 'New Fixed', folder_path: '/rec/New_ Fixed', match_locked: 1, metadata_at: t });
  const nfo = item({ library_id: rec, type: 'show', title: 'New: As Named', folder_path: '/rec/New_ As Named', nfo_json: '{"title":"New: As Named"}', metadata_at: t });
  const girl = item({ library_id: rec, type: 'show', title: 'New Girl', folder_path: '/rec/New Girl', metadata_at: t });

  assert.equal(renameShows(rec), 1);
  const row = (id) => ({ ...get('SELECT title, sort_title, metadata_at FROM items WHERE id = ?', id) });
  assert.deepEqual(row(jury), { title: 'The Jury', sort_title: 'jury', metadata_at: null });
  for (const [id, title] of [[matched, 'Wrong Show'], [locked, 'New Fixed'], [nfo, 'New: As Named'], [girl, 'New Girl']]) {
    assert.deepEqual([row(id).title, row(id).metadata_at], [title, t]);
  }
  assert.equal(renameShows(rec), 0, 'nothing more the second time');
});

test('recordings lying in the library folder: a "New_ …" show is filed under the plain name and joins it', () => {
  const rec = library('Recorded TV', 'show', ['/rec']);
  const key = (name) => `/rec${path.sep}::${name}`;
  const fresh = item({ library_id: rec, type: 'show', title: 'New Mock The Week', folder_path: key('new mock the week'), metadata_at: t });
  const s2 = item({ library_id: rec, type: 'season', parent_id: fresh, show_id: fresh, season_number: 2 });
  const e8 = item({ library_id: rec, type: 'episode', parent_id: s2, show_id: fresh, season_number: 2, episode_number: 8, file_path: path.join('/rec', 'New_ Mock The Week - S02E08 -.ts') });
  const plain = item({ library_id: rec, type: 'show', title: 'Mock The Week', folder_path: key('mock the week') });
  const s2b = item({ library_id: rec, type: 'season', parent_id: plain, show_id: plain, season_number: 2 });
  item({ library_id: rec, type: 'episode', parent_id: s2b, show_id: plain, season_number: 2, episode_number: 7, file_path: path.join('/rec', 'Mock The Week - S02E07 -.ts') });

  assert.equal(renameShows(rec), 1);
  assert.deepEqual({ ...get('SELECT title, folder_path, metadata_at FROM items WHERE id = ?', fresh) },
    { title: 'Mock The Week', folder_path: key('mock the week'), metadata_at: null });
  assert.equal(mergeSameNamedShows(rec), 1);
  pruneEmptyContainers(rec);
  assert.deepEqual(all("SELECT id FROM items WHERE library_id = ? AND type = 'show'", rec).map((r) => r.id), [fresh]);
  assert.equal(get('SELECT show_id FROM items WHERE id = ?', e8).show_id, fresh);
  assert.equal(renameShows(rec), 0);
});
