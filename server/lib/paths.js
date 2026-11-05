import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WEB_DIR = path.join(ROOT_DIR, 'web');
export const DATA_DIR = path.resolve(process.env.REELHOUSE_DATA || path.join(ROOT_DIR, 'data'));

export const dirs = {
  data: DATA_DIR,
  images: path.join(DATA_DIR, 'cache', 'images'),
  subtitles: path.join(DATA_DIR, 'cache', 'subtitles'),
  transcode: path.join(DATA_DIR, 'transcode'),
  tls: path.join(DATA_DIR, 'tls'),
  wireguard: path.join(DATA_DIR, 'wireguard'),
};

export function ensureDirs() {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
}
