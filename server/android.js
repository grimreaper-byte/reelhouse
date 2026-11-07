// Hands out the Reelhouse app for Android, so phones can install it straight from the server: open
// http://<server>/android/ on the phone. The server can't build the app, so an admin uploads the APK (Settings →
// General); it's checked to be the Reelhouse app and kept in the data folder. The APK holds no secrets, so
// downloading it needs no sign-in (like the Kodi add-on at /kodi/).
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import express from 'express';
import { dirs } from './lib/paths.js';

export const APP_PACKAGE = 'app.reelhouse.android';
export const MAX_APK_BYTES = 300 * 1024 * 1024;
const APK_TYPE = 'application/vnd.android.package-archive';

const appDir = () => path.join(dirs.data, 'apps');
const apkFile = () => path.join(appDir(), 'reelhouse.apk');
const infoFile = () => path.join(appDir(), 'reelhouse.json');

export class ApkError extends Error {
  status = 400;
}

// ---------- reading an APK ----------

const MAX_ENTRY_BYTES = 16 * 1024 * 1024; // far more than any manifest

/** One file from a zip archive on disk (stored or deflated), or null when it isn't there. */
async function readZipEntry(file, wanted) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    // The end-of-central-directory record is in the last 22 bytes plus up to 64 KB of comment.
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await fh.read(tail, 0, tailLength, size - tailLength);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > tailLength) throw new ApkError('That isn’t an APK file (not a zip archive).');
    const count = tail.readUInt16LE(end + 10);
    const dirSize = tail.readUInt32LE(end + 12);
    const dirOffset = tail.readUInt32LE(end + 16);
    if (dirOffset + dirSize > size) throw new ApkError('That APK file is damaged or incomplete.');
    const dir = Buffer.alloc(dirSize);
    await fh.read(dir, 0, dirSize, dirOffset);
    for (let p = 0, i = 0; i < count && p + 46 <= dirSize; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) break;
      const method = dir.readUInt16LE(p + 10);
      const packedSize = dir.readUInt32LE(p + 20);
      const rawSize = dir.readUInt32LE(p + 24);
      const nameLength = dir.readUInt16LE(p + 28);
      const extraLength = dir.readUInt16LE(p + 30);
      const commentLength = dir.readUInt16LE(p + 32);
      const localOffset = dir.readUInt32LE(p + 42);
      const name = dir.toString('utf8', p + 46, p + 46 + nameLength);
      p += 46 + nameLength + extraLength + commentLength;
      if (name !== wanted) continue;
      // Sizes come from the file itself: check them before making room for anything.
      if (rawSize > MAX_ENTRY_BYTES || packedSize > MAX_ENTRY_BYTES) throw new ApkError(`${wanted} in that APK is too large.`);
      const local = Buffer.alloc(30);
      await fh.read(local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new ApkError('That APK file is damaged.');
      const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (dataStart + packedSize > size) throw new ApkError('That APK file is damaged or incomplete.');
      const packed = Buffer.alloc(packedSize);
      await fh.read(packed, 0, packedSize, dataStart);
      if (method === 0) return packed;
      if (method === 8) return zlib.inflateRawSync(packed, { maxOutputLength: MAX_ENTRY_BYTES });
      throw new ApkError('That APK uses a compression Reelhouse can’t read.');
    }
    return null;
  } finally {
    await fh.close();
  }
}

// Android's binary XML (AndroidManifest.xml inside an APK).
const RES_STRING_POOL = 0x0001;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_XML_START_ELEMENT = 0x0102;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const ATTR_DEBUGGABLE = 0x0101000f;
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;

function readStringPool(buf, start) {
  const count = buf.readUInt32LE(start + 8);
  const utf8 = (buf.readUInt32LE(start + 16) & 0x100) !== 0;
  const stringsStart = start + buf.readUInt32LE(start + 20);
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + buf.readUInt32LE(start + 28 + i * 4);
    if (utf8) {
      p += buf[p] & 0x80 ? 2 : 1; // length in UTF-16 units, unused
      let bytes = buf[p];
      if (bytes & 0x80) {
        bytes = ((bytes & 0x7f) << 8) | buf[p + 1];
        p += 2;
      } else p += 1;
      strings.push(buf.toString('utf8', p, p + bytes));
    } else {
      let units = buf.readUInt16LE(p);
      if (units & 0x8000) {
        units = ((units & 0x7fff) << 16) | buf.readUInt16LE(p + 2);
        p += 4;
      } else p += 2;
      strings.push(buf.toString('utf16le', p, p + units * 2));
    }
  }
  return strings;
}

/** An element's attributes from binary XML: [{ name, id (resource id), text, dataType, data }]. */
function readAttributes(buf, ext, strings, resourceIds) {
  const attrStart = ext + buf.readUInt16LE(ext + 8);
  const attrSize = buf.readUInt16LE(ext + 10);
  const attrCount = buf.readUInt16LE(ext + 12);
  const out = [];
  for (let i = 0; i < attrCount; i++) {
    const a = attrStart + i * attrSize;
    const nameIndex = buf.readUInt32LE(a + 4);
    const raw = buf.readInt32LE(a + 8);
    const dataType = buf[a + 15];
    const data = buf.readUInt32LE(a + 16);
    const text = raw >= 0 ? strings[raw] : dataType === TYPE_STRING ? strings[data] : undefined;
    out.push({ name: strings[nameIndex], id: resourceIds[nameIndex], text, dataType, data });
  }
  return out;
}

/** From binary XML: <manifest>'s package, versionCode and versionName, and whether <application> is debuggable. */
export function parseManifest(buf) {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw new ApkError('That APK’s manifest can’t be read.');
  let strings = [];
  let resourceIds = [];
  let out = null;
  for (let p = buf.readUInt16LE(2); p + 8 <= buf.length;) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) break;
    if (type === RES_STRING_POOL) strings = readStringPool(buf, p);
    else if (type === RES_XML_RESOURCE_MAP) {
      resourceIds = [];
      for (let q = p + headerSize; q + 4 <= p + size; q += 4) resourceIds.push(buf.readUInt32LE(q));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = p + headerSize;
      const element = strings[buf.readUInt32LE(ext + 4)];
      const attrs = readAttributes(buf, ext, strings, resourceIds);
      if (!out) {
        if (element !== 'manifest') break; // the first element must be <manifest>
        out = { debuggable: false };
        for (const a of attrs) {
          if (a.name === 'package') out.package = a.text;
          else if (a.id === ATTR_VERSION_CODE || a.name === 'versionCode') {
            out.versionCode = a.dataType === TYPE_INT_DEC || a.dataType === TYPE_INT_HEX ? a.data : Number(a.text);
          } else if (a.id === ATTR_VERSION_NAME || a.name === 'versionName') out.versionName = a.text ?? String(a.data);
        }
      } else if (element === 'application') {
        out.debuggable = attrs.some((a) => (a.id === ATTR_DEBUGGABLE || a.name === 'debuggable') && a.data !== 0);
        return out;
      }
    }
    p += size;
  }
  if (out) return out;
  throw new ApkError('That APK’s manifest can’t be read.');
}

/** Checks a file is the Reelhouse app and returns { versionName, versionCode }. */
export async function inspectApk(file) {
  try {
    const manifest = await readZipEntry(file, 'AndroidManifest.xml');
    if (!manifest) throw new ApkError('That isn’t an Android app (it has no AndroidManifest.xml).');
    const m = parseManifest(manifest);
    if (m.package !== APP_PACKAGE) throw new ApkError(`That’s a different app (${m.package || 'unknown'}), not Reelhouse for Android.`);
    // Phones can't update from a debug build to a release one (they're signed with different keys).
    if (m.debuggable) throw new ApkError('That’s a debug build. Upload the release build (app-release.apk; see android/README.md).');
    if (!(await readZipEntry(file, 'META-INF/MANIFEST.MF')) && !(await hasSigningBlock(file))) {
      throw new ApkError('That APK isn’t signed, so phones won’t install it. Build the release version with a signing key (android/README.md).');
    }
    return { versionName: m.versionName || '?', versionCode: m.versionCode || 0 };
  } catch (err) {
    // A damaged or crafted file trips over its own sizes and offsets: say so rather than fail with a server error.
    if (err instanceof ApkError) throw err;
    throw new ApkError('That APK’s manifest can’t be read.');
  }
}

// APK Signature Scheme v2+ keeps its signatures in a block just before the central directory, marked by this magic.
async function hasSigningBlock(file) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await fh.read(tail, 0, tailLength, size - tailLength);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const dirOffset = tail.readUInt32LE(end + 16);
    if (dirOffset < 16) return false;
    const magic = Buffer.alloc(16);
    await fh.read(magic, 0, 16, dirOffset - 16);
    return magic.toString('latin1') === 'APK Sig Block 42';
  } finally {
    await fh.close();
  }
}

// ---------- the stored app ----------

let cachedInfo;

/** { versionName, versionCode, size, sha256, uploadedAt, fileName } of the uploaded APK, or null. */
export async function appInfo() {
  if (cachedInfo !== undefined) return cachedInfo;
  try {
    const info = JSON.parse(await fs.readFile(infoFile(), 'utf8'));
    await fs.access(apkFile());
    cachedInfo = info;
  } catch {
    cachedInfo = null;
  }
  return cachedInfo;
}

/** Saves an uploaded APK from a request body after checking it; replaces the previous one. */
export async function saveApk(stream) {
  await fs.mkdir(appDir(), { recursive: true });
  const tmp = path.join(appDir(), `upload-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const limit = new Transform({
    transform(chunk, enc, done) {
      size += chunk.length;
      if (size > MAX_APK_BYTES) return done(new ApkError(`That file is over ${MAX_APK_BYTES / 1024 / 1024} MB.`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(stream, limit, createWriteStream(tmp));
    if (!size) throw new ApkError('No file was sent.');
    const version = await inspectApk(tmp);
    const info = {
      ...version,
      size,
      sha256: hash.digest('hex'),
      uploadedAt: Date.now(),
      fileName: `reelhouse-${String(version.versionName).replace(/[^\w.-]/g, '_')}.apk`,
    };
    await fs.rename(tmp, apkFile());
    await fs.writeFile(infoFile(), JSON.stringify(info, null, 2));
    cachedInfo = info;
    return info;
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function removeApk() {
  await fs.rm(apkFile(), { force: true });
  await fs.rm(infoFile(), { force: true });
  cachedInfo = null;
}

// ---------- the download page ----------

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const megabytes = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const router = express.Router();

router.get('/android', async (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect(301, '/android/');
  const info = await appInfo();
  res.setHeader('Cache-Control', 'no-cache');
  const body = info
    ? `<p><a class="button" href="${escapeHtml(info.fileName)}">Download Reelhouse ${escapeHtml(info.versionName)}</a></p>
<p class="small">${megabytes(info.size)} · for Android 7.1 and newer: phones, tablets and TV boxes</p>
<ol>
<li>Open this page on the device and download the app.</li>
<li>Open the download. If the device asks, allow your browser to install apps, then install.</li>
<li>Open Reelhouse and choose <b>Scan the QR code</b> (<b>Type the code</b> on a TV box). On a computer, sign in to
Reelhouse and open <b>Your account → Apps and devices → Pair the Reelhouse app</b> for the code.</li>
</ol>
<p class="small">To update, install a newer version over the old one; the app stays paired.</p>`
    : `<p>The app hasn’t been added to this Reelhouse yet. An admin can add it in <b>Settings → Android
app</b>.</p>`;
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reelhouse for Android</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 16px;background:#111315;color:#e8e6e3}
h1{font-size:1.5rem}a{color:#e5a00d}.small{color:#9aa0a6;font-size:.9rem}li{margin:.4rem 0}
.button{display:inline-block;background:#e5a00d;color:#111315;font-weight:600;text-decoration:none;padding:.7rem 1.2rem;border-radius:8px}
</style></head>
<body><h1>Reelhouse for Android</h1>
${body}
</body></html>
`);
});

router.get('/android/:file', async (req, res) => {
  const info = await appInfo();
  if (!info || req.params.file !== info.fileName) return res.status(404).type('text/plain').send('Not found');
  res.setHeader('Cache-Control', 'no-cache');
  res.attachment(info.fileName);
  res.sendFile(apkFile(), { cacheControl: false, dotfiles: 'allow', headers: { 'Content-Type': APK_TYPE } });
});

export default router;
