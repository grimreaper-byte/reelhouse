// The Android app handed out at /android/: an admin uploads the APK, which is checked to be a signed release build of
// Reelhouse for Android, and phones download it (also offered on the pairing screen).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-android-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { zip } = await import('../server/kodi.js');
const { parseManifest } = await import('../server/android.js');

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'android', name));
const H = { 'x-requested-with': 'reelhouse' };
let server;
let base;
let admin;
let user;

/** A zip like an APK; `signed` adds an APK Signing Block (v2) between the files and the central directory. */
function apk(manifest, { signed = true } = {}) {
  const files = [{ name: 'classes.dex', data: Buffer.from('dex\n035\0') }];
  if (manifest) files.unshift({ name: 'AndroidManifest.xml', data: manifest });
  const z = zip(files);
  if (!signed) return z;
  const end = z.length - 22;
  const dirOffset = z.readUInt32LE(end + 16);
  // The block's layout doesn't matter here, only the magic that ends it.
  const block = Buffer.concat([Buffer.alloc(24), Buffer.from('APK Sig Block 42', 'latin1')]);
  const out = Buffer.concat([z.subarray(0, dirOffset), block, z.subarray(dirOffset)]);
  out.writeUInt32LE(dirOffset + block.length, out.length - 22 + 16);
  return out;
}

async function signIn(username, password) {
  const res = await fetch(`${base}/api/auth/device`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, device: 'Test' }),
  });
  return (await res.json()).token;
}

const upload = (body, token = admin) => fetch(`${base}/api/admin/android-app`, {
  method: 'PUT',
  headers: { ...H, authorization: `Bearer ${token}`, 'content-type': 'application/vnd.android.package-archive' },
  body,
});

before(async () => {
  openDb(':memory:');
  const t = Date.now();
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?)", await hashPassword('correct horse'), t);
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (2, 'kid', ?, 0, ?)", await hashPassword('kid password'), t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await signIn('dave', 'correct horse');
  user = await signIn('kid', 'kid password');
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the binary manifest gives the package, version and whether it is a debug build', () => {
  assert.deepEqual(parseManifest(fixture('release-manifest.bin')), {
    package: 'app.reelhouse.android', versionName: '0.1.0', versionCode: 1, debuggable: false,
  });
  assert.equal(parseManifest(fixture('debug-manifest.bin')).debuggable, true);
  assert.throws(() => parseManifest(Buffer.from('<manifest/>')), /can’t be read/);
});

test('before an upload, the download page says the app isn’t there yet', async () => {
  const page = await (await fetch(`${base}/android/`)).text();
  assert.match(page, /hasn’t been added/);
  assert.equal((await fetch(`${base}/android/reelhouse-0.1.0.apk`)).status, 404);
  assert.equal((await fetch(`${base}/android`, { redirect: 'manual' })).headers.get('location'), '/android/');
});

test('only signed release builds of Reelhouse are accepted, and only from admins', async () => {
  const refused = async (body, pattern) => {
    const res = await upload(body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, pattern);
  };
  await refused(Buffer.from('not an apk at all'), /not a zip/);
  await refused(apk(null), /no AndroidManifest/);
  await refused(apk(fixture('debug-manifest.bin')), /debug build/);
  await refused(apk(fixture('release-manifest.bin'), { signed: false }), /isn’t signed/);
  assert.equal((await upload(apk(fixture('release-manifest.bin')), user)).status, 403);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'apps')), []); // nothing left behind
});

test('a damaged or hostile APK is refused, not read', async () => {
  // A manifest whose string table claims more entries than it holds.
  const broken = Buffer.alloc(64);
  broken.writeUInt16LE(0x0003, 0); broken.writeUInt16LE(8, 2); broken.writeUInt32LE(64, 4);
  broken.writeUInt16LE(0x0001, 8); broken.writeUInt16LE(28, 10); broken.writeUInt32LE(56, 12);
  broken.writeUInt32LE(100000, 16); // string count
  broken.writeUInt32LE(28, 28); // strings start
  let res = await upload(apk(broken));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /can’t be read/);

  // A central directory that claims the manifest is 4 GB compressed: refused before anything that size is made.
  const z = apk(fixture('release-manifest.bin'));
  const entry = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); // the manifest's entry comes first
  z.writeUInt32LE(0xfffffff0, entry + 20);
  const started = Date.now();
  res = await upload(z);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /too large|damaged/);
  assert.ok(Date.now() - started < 2000);
});

test('an uploaded app is offered for download and on the pairing screen', async () => {
  const body = apk(fixture('release-manifest.bin'));
  const res = await upload(body);
  assert.equal(res.status, 200);
  const { app } = await res.json();
  assert.equal(app.versionName, '0.1.0');
  assert.equal(app.size, body.length);
  assert.equal(app.fileName, 'reelhouse-0.1.0.apk');

  const page = await (await fetch(`${base}/android/`)).text();
  assert.match(page, /href="reelhouse-0\.1\.0\.apk"/);
  const file = await fetch(`${base}/android/reelhouse-0.1.0.apk`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.match(file.headers.get('content-disposition'), /attachment; filename="?reelhouse-0\.1\.0\.apk"?$/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), body);

  // The app learns about it (to offer the update itself).
  const me = await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${user}` } })).json();
  assert.deepEqual(me.androidApp, { versionName: '0.1.0', versionCode: 1, size: body.length, fileName: 'reelhouse-0.1.0.apk' });

  // Any signed-in user pairing a phone is offered the download, with a QR code for the phone's camera.
  const pairing = await (await fetch(`${base}/api/me/pairings`, { method: 'POST', headers: { ...H, authorization: `Bearer ${user}` } })).json();
  assert.equal(pairing.app.versionName, '0.1.0');
  if (pairing.app.url) {
    assert.match(pairing.app.url, /^https?:\/\/.+\/android\/$/);
    assert.match(pairing.app.qr, /<svg/);
  }
});

test('removing the app takes it off the download page', async () => {
  const res = await fetch(`${base}/api/admin/android-app`, { method: 'DELETE', headers: { ...H, authorization: `Bearer ${admin}` } });
  assert.deepEqual(await res.json(), { app: null });
  assert.match(await (await fetch(`${base}/android/`)).text(), /hasn’t been added/);
  assert.equal((await fetch(`${base}/android/reelhouse-0.1.0.apk`)).status, 404);
  const pairing = await (await fetch(`${base}/api/me/pairings`, { method: 'POST', headers: { ...H, authorization: `Bearer ${user}` } })).json();
  assert.equal(pairing.app, null);
  assert.equal((await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${user}` } })).json()).androidApp, null);
});
