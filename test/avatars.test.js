// Account pictures: every upload is checked (size, what it really is, dimensions) and redrawn before it's kept.
// Needs ffmpeg and ffprobe on the PATH (they make the test pictures, and the server uses them).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-avatar-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run, get } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { imageKind, avatarFile } = await import('../server/avatars.js');

let server;
let base;
let dave;
let kid;
const H = { 'x-requested-with': 'reelhouse' };
const pics = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-avatar-pics-'));

/** A test picture made by ffmpeg: a 300×200 (or `size`) colour, saved as `name`; extra ffmpeg args before the output. */
function picture(name, { size = '300x200', extra = [] } = {}) {
  const file = path.join(pics, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=red:s=${size}`, '-frames:v', '1', ...extra, file]);
  return file;
}

const signIn = async (username, password) => (await (await fetch(`${base}/api/auth/device`, {
  method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ username, password, device: 'test' }),
})).json()).token;

async function upload(token, body, type = 'image/png') {
  const res = await fetch(`${base}/api/me/avatar`, { method: 'PUT', headers: { ...H, 'content-type': type, authorization: `Bearer ${token}` }, body });
  return { status: res.status, data: await res.json() };
}

function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format_tags', '-of', 'json', file]).toString());
}

before(async () => {
  openDb(':memory:');
  const t = Date.now();
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?), (2, 'kid', ?, 0, ?)",
    await hashPassword('correct horse'), t, await hashPassword('kid password'), t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  dave = await signIn('dave', 'correct horse');
  kid = await signIn('kid', 'kid password');
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(pics, { recursive: true, force: true });
});

test('a file is known by its first bytes, not its name', () => {
  assert.equal(imageKind(fs.readFileSync(picture('a.png'))), 'png');
  assert.equal(imageKind(fs.readFileSync(picture('a.jpg'))), 'jpeg');
  assert.equal(imageKind(fs.readFileSync(picture('a.gif'))), 'gif');
  assert.equal(imageKind(fs.readFileSync(picture('a.webp'))), 'webp');
  assert.equal(imageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(imageKind(Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])), 'heif');
});

test('a picture is checked, cut to the middle square and redrawn as a 256 px JPEG without its metadata', async () => {
  // A photo with a JPEG comment block (FF FE) right after its start, the way cameras add notes and locations.
  const plain = fs.readFileSync(picture('photo.jpg', { size: '640x480' }));
  const note = Buffer.from('taken at 51.5N 0.1W');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(note.length + 2);
  const photo = Buffer.concat([plain.subarray(0, 2), Buffer.from([0xff, 0xfe]), length, note, plain.subarray(2)]);
  assert.ok(photo.includes(note));
  const { status, data } = await upload(dave, photo, 'image/jpeg');
  assert.equal(status, 200);
  assert.match(data.user.avatar, /^\/api\/users\/1\/avatar\?v=\d+$/);
  const stored = probe(avatarFile(1));
  assert.deepEqual(stored.streams.map((s) => [s.codec_name, s.width, s.height]), [['mjpeg', 256, 256]]);
  assert.ok(!fs.readFileSync(avatarFile(1)).includes(note), 'the comment is left behind');

  // Its address works for anyone signed in, as a JPEG that can be cached for good; not without signing in.
  const img = await fetch(base + data.user.avatar, { headers: { authorization: `Bearer ${kid}` } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.match(img.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(base + data.user.avatar)).status, 401);
  assert.equal((await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${dave}` } })).json()).user.avatar, data.user.avatar);
});

test('PNG, WebP and GIF pictures work too', async () => {
  for (const name of ['wide.png', 'wide.webp', 'wide.gif']) {
    const { status } = await upload(kid, fs.readFileSync(picture(name, { size: '400x100' })), 'image/png');
    assert.equal(status, 200, name);
    assert.deepEqual(probe(avatarFile(2)).streams.map((s) => [s.width, s.height]), [[256, 256]], name);
  }
});

test('files that aren’t usable pictures are refused with a reason, and the old picture stays', async () => {
  const before = get('SELECT avatar_at FROM users WHERE id = 1').avatar_at;
  const refusals = [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', /JPEG, PNG, WebP or GIF/],
    [Buffer.from('just some text pretending to be a picture'), 'image/png', /JPEG, PNG, WebP or GIF/],
    [Buffer.concat([fs.readFileSync(picture('x.png')).subarray(0, 8), Buffer.alloc(2000, 7)]), 'image/png', /damaged/],
    [fs.readFileSync(picture('tiny.png', { size: '32x32' })), 'image/png', /too small \(32×32\)/],
    [Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, ...Buffer.alloc(100)]), 'image/heic', /HEIC/],
    [Buffer.alloc(0), 'image/png', /No picture/],
  ];
  for (const [body, type, reason] of refusals) {
    const { status, data } = await upload(dave, body, type);
    assert.equal(status, 400, String(reason));
    assert.match(data.error, reason);
  }
  assert.equal(get('SELECT avatar_at FROM users WHERE id = 1').avatar_at, before);
  assert.ok(fs.existsSync(avatarFile(1)));
  assert.deepEqual(fs.readdirSync(path.dirname(avatarFile(1))).filter((f) => f.startsWith('upload-')), [], 'nothing left over');
});

test('a picture that says it is too big is refused before it is read', async () => {
  const res = await fetch(`${base}/api/me/avatar`, {
    method: 'PUT',
    headers: { ...H, 'content-type': 'image/jpeg', 'content-length': String(16 * 1024 * 1024), authorization: `Bearer ${dave}` },
    body: Buffer.alloc(16 * 1024 * 1024),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /over 15 MB/);
});

test('removing the picture, and deleting the user, take it away', async () => {
  const { data } = await (async () => {
    const r = await fetch(`${base}/api/me/avatar`, { method: 'DELETE', headers: { ...H, authorization: `Bearer ${dave}` } });
    return { data: await r.json() };
  })();
  assert.equal(data.user.avatar, null);
  assert.ok(!fs.existsSync(avatarFile(1)));
  assert.equal((await fetch(`${base}/api/users/1/avatar?v=1`, { headers: { authorization: `Bearer ${kid}` } })).status, 404);

  assert.ok(fs.existsSync(avatarFile(2)));
  assert.equal((await fetch(`${base}/api/users/2`, { method: 'DELETE', headers: { ...H, authorization: `Bearer ${dave}` } })).status, 200);
  assert.ok(!fs.existsSync(avatarFile(2)), 'a deleted user’s picture goes with them');
});
