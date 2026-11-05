// Copies of one film (an SD and an HD file) shown as one film with versions: grouping, lists, watch state, the
// film's page, and copies coming and going in real scans (those skipped when ffmpeg isn't installed).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, closeDb, run, get, all } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { regroupVersions, rankVersions, versionKey } from '../server/versions.js';
import { queueScan, scanStatus } from '../server/scanner/index.js';
import { recordProgress } from '../server/items.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };
let server;
let base;
let token;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-versions-'));

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { ...H, authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}

const state = (itemId) => {
  const r = get('SELECT position, watched, view_count FROM user_state WHERE user_id = 1 AND item_id = ?', itemId);
  return r ? { ...r } : null;
};

before(async () => {
  openDb(':memory:');
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?)", t);
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?)", await hashPassword('correct horse'), t);
  const item = (fields) => {
    const row = { library_id: 1, type: 'movie', added_at: t, updated_at: 100, sort_title: fields.title.toLowerCase(), ...fields };
    const cols = Object.keys(row);
    run(`INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c]));
  };
  const media = (w, h) => JSON.stringify({ container: 'mkv', video: { codec: 'h264', width: w, height: h }, audio: [{ codec: 'aac', channels: 2 }] });
  // Heat: an SD copy added first, a 1080p one later (a wide 1920×800 picture), both matched on TMDB.
  item({ id: 1, title: 'Heat', year: 1995, tmdb_id: 949, file_path: 'C:/m/Heat (1995).avi', width: 720, height: 400, bitrate: 2000000,
    file_size: 700, video_codec: 'mpeg4', container: 'avi', media_json: media(720, 400) });
  item({ id: 2, title: 'Heat', year: 1995, tmdb_id: 949, file_path: 'C:/m/Heat (1995) 1080p.mkv', width: 1920, height: 800, bitrate: 9000000,
    file_size: 9000, video_codec: 'h264', container: 'mkv', media_json: media(1920, 800) });
  item({ id: 3, title: 'Alien', year: 1979, tmdb_id: 348, file_path: 'C:/m/Alien.mkv', width: 1920, height: 1080 });
  // Not matched: the same title and year is the same film; without a year there's nothing to go on.
  item({ id: 4, title: 'Brazil', year: 1985, file_path: 'C:/m/Brazil (1985).mkv', width: 1280, height: 720 });
  item({ id: 5, title: 'Brazil', year: 1985, file_path: 'C:/m/Brazil (1985) SD.avi', width: 640, height: 480 });
  item({ id: 6, title: 'Brazil', file_path: 'C:/m/Brazil.avi', width: 640, height: 480 });
  // Watched in SD long ago, and half-way through the 1080p copy since (when they were still two films).
  run('INSERT INTO user_state (user_id, item_id, position, watched, view_count, updated_at) VALUES (1, 1, 0, 1, 1, 100), (1, 2, 600, 0, 0, 200)');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/device`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'dave', password: 'correct horse', device: 'test' }) });
  token = (await res.json()).token;
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('copies of a film in one library', () => {
  test('the same match, or the same title and year, is the same film; the sharpest copy is the best', () => {
    assert.equal(versionKey({ tmdb_id: 949, sort_title: 'heat', year: 1995 }), 'tmdb:949');
    assert.equal(versionKey({ sort_title: 'brazil', year: 1985 }), 'title:brazil|1985');
    assert.equal(versionKey({ sort_title: 'brazil' }), null);
    const ranked = rankVersions([{ id: 1, width: 720, height: 400 }, { id: 2, width: 1920, height: 800 }, { id: 3, width: 1280, height: 720, bitrate: 1 }]);
    assert.deepEqual(ranked.map((r) => r.id), [2, 3, 1]);

    assert.equal(regroupVersions(1), 2);
    assert.deepEqual(all("SELECT id, version_of FROM items ORDER BY id").map((r) => [r.id, r.version_of]),
      [[1, 2], [2, null], [3, null], [4, null], [5, 4], [6, null]]);
    assert.equal(regroupVersions(1), 0, 'nothing more to do the second time');
  });

  test('the film keeps both copies’ watching: watched (in SD), resumable where the 1080p copy was left, both views', () => {
    assert.deepEqual(state(2), { position: 600, watched: 1, view_count: 1 });
    assert.equal(state(1), null);
  });

  test('lists, counts and search show each film once, as its best copy', async () => {
    const lib = await call('GET', '/api/libraries/1/items');
    assert.deepEqual(lib.data.items.map((i) => i.id).sort(), [2, 3, 4, 6]);
    assert.equal(lib.data.library.count, 4);
    const search = await call('GET', '/api/search?q=heat');
    assert.deepEqual(search.data.movies.map((i) => i.id), [2]);
    const sync = await call('GET', '/api/sync/libraries/1/items');
    assert.deepEqual(sync.data.items.map((i) => i.id).sort(), [2, 3, 4, 6]);
  });

  test('the film’s page lists its copies, best first, with their quality', async () => {
    const { data } = await call('GET', '/api/items/2');
    assert.deepEqual(data.item.versions.map((v) => [v.id, v.label]), [[2, '1080p'], [1, 'SD']]);
    assert.equal(data.item.versions[1].media.video.width, 720);
    assert.equal(data.item.state.position, 600);
    // A copy's own page (an old link, or the player playing that copy): its own file, the film's watching.
    const copy = await call('GET', '/api/items/1');
    assert.equal(copy.data.item.versionOf, 2);
    assert.equal(copy.data.item.media.video.width, 720);
    assert.equal(copy.data.item.state.position, 600);
    assert.equal(copy.data.item.versions.length, 2);
    // A film with one copy has no list.
    assert.equal((await call('GET', '/api/items/3')).data.item.versions, undefined);
  });

  test('playing or marking any copy changes the film', async () => {
    assert.equal((await call('POST', '/api/progress', { itemId: 1, position: 1200, duration: 6000, state: 'paused' })).status, 200);
    assert.equal(state(2).position, 1200);
    assert.equal(state(1), null);
    await call('POST', '/api/items/1/watched', { watched: false });
    assert.deepEqual(state(2), { position: 0, watched: 0, view_count: 1 });
    assert.equal(state(1), null);
  });

  test('a copy matched to another film becomes a film of its own again', () => {
    run('UPDATE items SET tmdb_id = 111 WHERE id = 1');
    assert.equal(regroupVersions(1), 1);
    assert.equal(get('SELECT version_of FROM items WHERE id = 1').version_of, null);
    run('UPDATE items SET tmdb_id = 949 WHERE id = 1');
    regroupVersions(1);
  });
});

// ---------- real scans: copies added and deleted ----------

function makeVideo(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10:duration=1`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file]);
}

async function scan(libraryId) {
  queueScan(libraryId);
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const s = scanStatus();
    if (!s.running && !s.queue.length) return;
  }
  throw new Error('scan did not finish');
}

describe('scanning copies', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const root = path.join(tmp, 'Films');
  const parked = path.join(tmp, 'parked');
  const sd = path.join(root, 'Up (2009)', 'Up (2009).mp4');
  const hd = path.join(root, 'Up (2009)', 'Up (2009) 720p.mp4');
  const films = () => all("SELECT id, file_path, version_of FROM items WHERE library_id = 2 AND type = 'movie' ORDER BY id").map((r) => ({ ...r }));
  const byFile = (f) => films().find((r) => r.file_path === f);

  before(() => {
    makeVideo(sd, '320x180');
    makeVideo(hd, '1280x720');
    fs.mkdirSync(parked, { recursive: true });
    run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (2, 'Films', 'movie', ?, ?)", JSON.stringify([root]), Date.now());
  });

  test('two copies in one folder are one film, the 720p copy first', async () => {
    await scan(2);
    assert.equal(films().length, 2);
    assert.equal(byFile(hd).version_of, null);
    assert.equal(byFile(sd).version_of, byFile(hd).id);
    const lib = await call('GET', '/api/libraries/2/items');
    assert.deepEqual(lib.data.items.map((i) => i.id), [byFile(hd).id]);
    recordProgress(1, get('SELECT * FROM items WHERE id = ?', byFile(sd).id), 300, 1000, false); // watching the SD copy
    assert.equal(state(byFile(hd).id).position, 300);
  });

  test('deleting the 720p copy leaves the SD copy as the film, still resumable', async () => {
    fs.renameSync(hd, path.join(parked, 'hd.mp4'));
    await scan(2);
    assert.deepEqual(films().map((r) => [r.file_path, r.version_of]), [[sd, null]]);
    assert.equal(state(byFile(sd).id).position, 300);
    const lib = await call('GET', '/api/libraries/2/items');
    assert.deepEqual(lib.data.items.map((i) => i.id), [byFile(sd).id]);
  });

  test('the 720p copy back: it’s the film again and takes over where you were', async () => {
    fs.renameSync(path.join(parked, 'hd.mp4'), hd);
    await scan(2);
    assert.equal(byFile(hd).version_of, null);
    assert.equal(byFile(sd).version_of, byFile(hd).id);
    assert.equal(state(byFile(hd).id).position, 300);
    assert.equal(state(byFile(sd).id), null);
  });

  test('deleting the SD copy leaves the 720p copy as the film', async () => {
    fs.renameSync(sd, path.join(parked, 'sd.mp4'));
    await scan(2);
    assert.deepEqual(films().map((r) => [r.file_path, r.version_of]), [[hd, null]]);
    assert.equal(state(byFile(hd).id).position, 300);
    assert.equal((await call('GET', `/api/items/${byFile(hd).id}`)).data.item.versions, undefined);
  });
});
