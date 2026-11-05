// Renders web/favicon.svg into the PNG/ICO icons browsers and phones ask for:
//   favicon.ico (16/32/48), apple-touch-icon.png (180), icon-192.png, icon-512.png
//
//   npm run icons
//
// No dependencies: it understands the small SVG subset the logo uses (<rect> with rx,
// <circle>, and fill inherited from <g>), renders with 4×4 supersampling, and writes PNGs
// with node:zlib.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const svg = fs.readFileSync(path.join(WEB, 'favicon.svg'), 'utf8');

// ---------- parse ----------

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const viewBox = attrs(svg.match(/<svg[^>]*>/)[0]).viewBox.split(/\s+/).map(Number);
const shapes = [];
const fillStack = [];
for (const m of svg.matchAll(/<(\/?)(g|rect|circle)\b([^>]*?)\/?>/g)) {
  const [, closing, name, rest] = m;
  if (name === 'g') {
    if (closing) fillStack.pop();
    else fillStack.push(attrs(rest).fill);
    continue;
  }
  const a = attrs(rest);
  const fill = a.fill || fillStack.at(-1);
  if (!fill || fill === 'none') continue;
  const color = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16));
  if (name === 'rect') {
    shapes.push({ type: 'rect', x: +(a.x || 0), y: +(a.y || 0), w: +a.width, h: +a.height, r: +(a.rx || 0), color });
  } else {
    shapes.push({ type: 'circle', cx: +a.cx, cy: +a.cy, r: +a.r, color });
  }
}

function inside(s, px, py) {
  if (s.type === 'circle') return (px - s.cx) ** 2 + (py - s.cy) ** 2 <= s.r ** 2;
  // Rounded rectangle via its signed distance.
  const r = Math.min(s.r, s.w / 2, s.h / 2);
  const qx = Math.abs(px - (s.x + s.w / 2)) - (s.w / 2 - r);
  const qy = Math.abs(py - (s.y + s.h / 2)) - (s.h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

// ---------- render ----------

/** RGBA pixels. fullBleed paints the first shape's colour everywhere (no transparent corners). */
function render(size, { fullBleed = false } = {}) {
  const SS = 4;
  const scale = viewBox[2] / size;
  const pixels = Buffer.alloc(size * size * 4);
  const bg = shapes[0].color;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = viewBox[0] + (x + (sx + 0.5) / SS) * scale;
          const py = viewBox[1] + (y + (sy + 0.5) / SS) * scale;
          let color = fullBleed ? bg : null;
          for (const s of shapes) if (inside(s, px, py)) color = s.color; // later shapes paint over earlier ones
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 1;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        pixels[i] = Math.round(r / a);
        pixels[i + 1] = Math.round(g / a);
        pixels[i + 2] = Math.round(b / a);
      }
      pixels[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return pixels;
}

// ---------- encode ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** .ico containing PNG images (supported by every browser and Windows Vista+). */
function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size >= 256 ? 0 : size;
    head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.data)]);
}

// ---------- write ----------

const write = (name, data) => {
  fs.writeFileSync(path.join(WEB, name), data);
  console.log(`web/${name}  ${data.length} bytes`);
};

write('favicon.ico', ico([16, 32, 48].map((size) => ({ size, data: png(size, render(size)) }))));
// iOS rounds the corners itself and shows transparent pixels as black, so this one is full-bleed.
write('apple-touch-icon.png', png(180, render(180, { fullBleed: true })));
write('icon-192.png', png(192, render(192)));
write('icon-512.png', png(512, render(512)));
