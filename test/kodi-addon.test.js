// The Kodi add-on download: the directory page Kodi browses and the zip it installs from.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-kodi-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { zip } = await import('../server/kodi.js');
const { ROOT_DIR } = await import('../server/lib/paths.js');

const ADDON_DIR = path.join(ROOT_DIR, 'kodi', 'plugin.video.reelhouse');
const version = fs.readFileSync(path.join(ADDON_DIR, 'addon.xml'), 'utf8').match(/<addon\b[^>]*\bversion="([^"]+)"/)[1];
const zipName = `plugin.video.reelhouse-${version}.zip`;

let server;
let base;

before(async () => {
  openDb(':memory:');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Reads a zip through its central directory, the way unzip tools (and Kodi) do. */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + packed);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, size, `size of ${name}`);
    assert.equal(zlib.crc32(data), crc, `crc of ${name}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function addonFilesOnDisk(dir = ADDON_DIR, prefix = 'plugin.video.reelhouse/') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name.endsWith('.pyc') || e.name.startsWith('.')) continue;
    if (e.isDirectory()) out.push(...addonFilesOnDisk(path.join(dir, e.name), `${prefix}${e.name}/`));
    else out.push(prefix + e.name);
  }
  return out;
}

test('zip() round-trips files and folders', () => {
  const files = [
    { name: 'a/', dir: true },
    { name: 'a/hello.txt', data: Buffer.from('hello '.repeat(100)) },
    { name: 'a/ünïcode.bin', data: Buffer.from([0, 1, 2, 255]) },
    { name: 'a/empty.txt', data: Buffer.alloc(0) },
  ];
  const entries = unzip(zip(files));
  assert.deepEqual([...entries.keys()], files.map((f) => f.name));
  for (const f of files) assert.deepEqual(entries.get(f.name), f.dir ? Buffer.alloc(0) : f.data);
});

test('/kodi redirects to the directory page, which needs no sign-in', async () => {
  const res = await fetch(`${base}/kodi`, { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/kodi/');
});

test('the page lists the zip the way Kodi parses an http:// source', async () => {
  const res = await fetch(`${base}/kodi/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  const html = await res.text();
  // Kodi: link text equal to the href, and something after </a> before "</tr" on the same line.
  const links = html.split('\n').filter((line) => /<a href="[^"]*"[^>]*>.*?<\/a>.+?<\/tr/.test(line));
  assert.equal(links.length, 1);
  const [, href, text] = links[0].match(/<a href="([^"]*)"[^>]*>(.*?)<\/a>/);
  assert.equal(href, zipName);
  assert.equal(text, zipName);
});

test('the zip holds the add-on folder, byte for byte', async () => {
  const res = await fetch(`${base}/kodi/${zipName}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const entries = unzip(Buffer.from(await res.arrayBuffer()));
  const files = [...entries.keys()].filter((n) => !n.endsWith('/'));
  assert.deepEqual(files.sort(), addonFilesOnDisk().sort());
  for (const name of files) {
    const onDisk = fs.readFileSync(path.join(ADDON_DIR, ...name.split('/').slice(1)));
    assert.deepEqual(entries.get(name), onDisk, name);
  }
  assert.match(entries.get('plugin.video.reelhouse/addon.xml').toString(), /id="plugin.video.reelhouse"/);
});

test('the zip answers range requests (Kodi reads zips in pieces)', async () => {
  const res = await fetch(`${base}/kodi/${zipName}`, { headers: { range: 'bytes=0-3' } });
  assert.equal(res.status, 206);
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x50, 0x4b, 0x03, 0x04]);
});

test('other names under /kodi/ are not found', async () => {
  for (const p of ['/kodi/plugin.video.reelhouse-0.0.0.zip', '/kodi/addon.xml', '/kodi/..%2Fpackage.json']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
  }
});

test('the Kodi add-on tab: the add-on on offer, where Kodi installs it from, and the signed-in Kodis', async () => {
  const { run } = await import('../server/db.js');
  const { hashPassword } = await import('../server/auth.js');
  const t = Date.now();
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'dave', ?, 1, ?), (2, 'kid', ?, 0, ?)",
    await hashPassword('correct horse'), t, await hashPassword('kid password'), t);
  const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };
  const signIn = async (username, password, device) => (await (await fetch(`${base}/api/auth/device`, {
    method: 'POST', headers: H, body: JSON.stringify({ username, password, device }),
  })).json()).token;
  const admin = await signIn('dave', 'correct horse', 'test runner');
  const kid = await signIn('kid', 'kid password', 'Kodi (LIVINGROOM)');
  const get = (token) => fetch(`${base}/api/admin/kodi-addon`, { headers: { ...H, authorization: `Bearer ${token}` } });

  assert.equal((await get(kid)).status, 403, 'admins only');
  const r = await (await get(admin)).json();
  assert.equal(r.addon.version, version);
  assert.equal(r.addon.fileName, zipName);
  assert.ok(r.addon.size > 1000);
  assert.ok(Array.isArray(r.addresses) && r.addresses.every((a) => /^https?:\/\/.+\/kodi\/$/.test(a)));
  assert.deepEqual(r.devices.map((d) => [d.user, d.name]), [['kid', 'Kodi (LIVINGROOM)']], 'only Kodi sign-ins, with whose account');
});
