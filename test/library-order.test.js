// The libraries' order from Settings → Libraries: kept in the database, and what an upgrade starts it as.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb, run, get, all } from '../server/db.js';
import { orderLibraries, LIBRARY_ORDER } from '../server/libraries.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-library-order-'));
after(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const names = () => all(`SELECT name FROM libraries ORDER BY ${LIBRARY_ORDER}`).map((r) => r.name);

test('the upgrade keeps the order libraries had (by name), and the order is kept in the database file', () => {
  const file = path.join(dir, 'reelhouse.db');
  // A database from before the order existed (v10): the column isn't there yet.
  openDb(file);
  run('ALTER TABLE libraries DROP COLUMN position');
  run('DROP INDEX items_version_of');
  run('ALTER TABLE items DROP COLUMN version_of'); // v12, after this one
  run('DROP TABLE requests'); // v13
  run('ALTER TABLE libraries DROP COLUMN icon'); // v14
  run('DROP TABLE recordings'); // v15
  run('DROP TABLE recording_stills'); // v17
  run('DROP TABLE recording_art'); // v16
  run('DROP TABLE recording_series'); // v19
  run('ALTER TABLE users DROP COLUMN live_tv_series'); // v19
  run('PRAGMA user_version = 10');
  for (const [id, name, type] of [[1, 'TV Shows', 'show'], [2, 'movies', 'movie'], [3, 'Recorded TV', 'show'], [4, 'Anime', 'show']]) {
    run('INSERT INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', id, name, type, '[]', 1);
  }
  closeDb();

  openDb(file);
  assert.equal(get('PRAGMA user_version').user_version, 19);
  assert.deepEqual(names(), ['Anime', 'movies', 'Recorded TV', 'TV Shows']);

  // Recorded TV under TV Shows, as someone would set it; still so after the server starts again.
  orderLibraries([4, 2, 1, 3]);
  closeDb();
  openDb(file);
  assert.deepEqual(names(), ['Anime', 'movies', 'TV Shows', 'Recorded TV']);
});

test('the libraries named go first, in that order; others keep theirs after them; unknown ids are ignored', () => {
  // [4 Anime, 2 movies, 1 TV Shows, 3 Recorded TV] from the test before.
  assert.deepEqual(orderLibraries([3, 99, 3, 1]), [3, 1, 4, 2]);
  assert.deepEqual(names(), ['Recorded TV', 'TV Shows', 'Anime', 'movies']);
  assert.deepEqual(all('SELECT position FROM libraries ORDER BY position').map((r) => r.position), [0, 1, 2, 3]);
});
