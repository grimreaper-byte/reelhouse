// Downloads for offline viewing follow the server's "Allow downloads" setting, including ones already under way.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, closeDb, run } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { updateSettings } from '../server/settings.js';

const SIZE = 32 * 1024 * 1024; // more than the sockets buffer, so a download is still going when it's cut off
let server;
let base;
let dir;
let token;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reelhouse-downloads-'));
  const file = path.join(dir, 'Film (2020).mkv');
  fs.writeFileSync(file, Buffer.alloc(SIZE, 7));
  openDb(':memory:');
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?)", t);
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?)", await hashPassword('correct horse'), t);
  run("INSERT INTO items (id, library_id, type, title, sort_title, file_path, container, added_at, updated_at) VALUES (1, 1, 'movie', 'Film', 'film', ?, 'mkv', ?, ?)", file, t, t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' },
    body: JSON.stringify({ username: 'dave', password: 'correct horse', device: 'Phone' }),
  });
  token = (await res.json()).token;
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const download = () => fetch(`${base}/api/stream/1?download=1`, { headers: { authorization: `Bearer ${token}` } });
const defaults = async () => (await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json()).defaults;

test('downloads are off until allowed, and apps are told so', async () => {
  assert.equal((await defaults()).allowDownloads, false);
  assert.equal((await download()).status, 403);
  updateSettings({ allowDownloads: true });
  assert.equal((await defaults()).allowDownloads, true);
  const res = await download();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment/);
  assert.equal((await res.arrayBuffer()).byteLength, SIZE);
});

test('turning downloads off cuts off one under way and refuses new ones', async () => {
  const res = await download();
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let received = (await reader.read()).value.length;
  updateSettings({ allowDownloads: false });
  await assert.rejects(async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
    }
  });
  assert.ok(received < SIZE, `got ${received} of ${SIZE}`);
  assert.equal((await download()).status, 403);
  assert.equal((await defaults()).allowDownloads, false);
  // Playing isn't downloading: streaming still works.
  const play = await fetch(`${base}/api/stream/1`, { headers: { authorization: `Bearer ${token}`, range: 'bytes=0-99' } });
  assert.equal(play.status, 206);
  await play.arrayBuffer();
  updateSettings({ allowDownloads: true });
  const again = await download();
  assert.equal(again.status, 200);
  await again.arrayBuffer();
});
