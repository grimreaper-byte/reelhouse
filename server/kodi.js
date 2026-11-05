// Hands out the Kodi add-on, so Kodi can install it straight from the server: add http://<server>/kodi/ as a
// file source in Kodi, then Add-ons → Install from zip file. The add-on holds no secrets, so this needs no sign-in.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { ROOT_DIR, dirs } from './lib/paths.js';

export const ADDON_ID = 'plugin.video.reelhouse';
const ADDON_DIR = path.join(ROOT_DIR, 'kodi', ADDON_ID);

export async function addonVersion() {
  const xml = await fs.readFile(path.join(ADDON_DIR, 'addon.xml'), 'utf8');
  return xml.match(/<addon\b[^>]*\bversion="([^"]+)"/)[1];
}

async function addonFiles(dir = ADDON_DIR, prefix = `${ADDON_ID}/`) {
  const out = [{ name: prefix, dir: true }];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name === '__pycache__' || e.name.endsWith('.pyc') || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await addonFiles(full, `${prefix}${e.name}/`)));
    else if (e.isFile()) out.push({ name: prefix + e.name, file: full, mtime: (await fs.stat(full)).mtime });
  }
  return out;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** A zip archive of entries [{ name, data?, dir?, mtime? }]: files deflated, folders as their own entries. */
export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.dir ? Buffer.alloc(0) : entry.data;
    const packed = entry.dir ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const method = entry.dir ? 0 : 8;
    const crc = entry.dir ? 0 : zlib.crc32(raw);
    const { time, day } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(day, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(entry.dir ? 0x10 : 0, 38); // MS-DOS directory attribute
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

// Built on first request and again only when a file in the add-on changes. It's served from a file because
// Kodi reads zips over HTTP in pieces (range requests), which sendFile handles.
let cached = null;
let checking = null;

/** { version, name, file } of the current add-on zip; concurrent callers share one check/build. */
export function addonZip() {
  checking ??= refreshZip().finally(() => { checking = null; });
  return checking;
}

async function refreshZip() {
  const files = await addonFiles();
  const key = files.map((f) => `${f.name}@${f.mtime?.getTime() ?? ''}`).join('|');
  if (cached?.key !== key || !(await fs.stat(cached.file).catch(() => null))) {
    for (const f of files) if (f.file) f.data = await fs.readFile(f.file);
    const version = await addonVersion();
    const name = `${ADDON_ID}-${version}.zip`;
    const file = path.join(dirs.data, 'cache', 'kodi', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, zip(files));
    await fs.rename(`${file}.tmp`, file);
    cached = { key, version, name, file };
  }
  return cached;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const router = express.Router();

// A directory listing in Apache's table layout: Kodi only takes a link as a file when something follows it
// before the next link or "</tr" (one row per line).
router.get('/kodi', async (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect(301, '/kodi/');
  const { name, file } = await addonZip();
  const { size, mtime } = await fs.stat(file);
  const n = escapeHtml(name);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Index of /kodi/</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 16px}th{text-align:left}td{padding-right:1rem;white-space:nowrap;vertical-align:top}td.name{white-space:normal;word-break:break-all}</style></head>
<body><h1>Index of /kodi/</h1>
<table>
<tr><th>Name</th><th>Last modified</th><th>Size</th></tr>
<tr><td class="name"><a href="${n}">${n}</a></td><td>${mtime.toISOString().slice(0, 16).replace('T', ' ')}</td><td>${Math.ceil(size / 1024)}K</td></tr>
</table>
<p>The Reelhouse add-on for Kodi. To install it in Kodi: turn on Settings → System → Add-ons → Unknown sources,
add this page's address as a source in Settings → File manager → Add source, then choose Add-ons → Install from zip file
and pick ${n} from that source.</p>
</body></html>
`);
});

router.get('/kodi/:file', async (req, res) => {
  const { name, file } = await addonZip();
  if (req.params.file !== name) return res.status(404).type('text/plain').send('Not found');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(file, { cacheControl: false, dotfiles: 'allow', headers: { 'Content-Type': 'application/zip' } });
});

export default router;
