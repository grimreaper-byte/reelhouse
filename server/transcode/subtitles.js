// Converts embedded and sidecar text subtitles to WebVTT for the browser, with a disk cache.
import fs from 'node:fs/promises';
import path from 'node:path';
import { dirs } from '../lib/paths.js';
import { ffmpegBin, runProcess } from '../media/ffmpeg.js';
import { createLimiter, createOnce } from '../lib/limit.js';
import { parseJson } from '../db.js';

const limit = createLimiter(2);
const once = createOnce();

const exists = (p) => fs.access(p).then(() => true, () => false);

async function detectCharset(file) {
  const buf = await fs.readFile(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'UTF-16LE';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'UTF-16BE';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return null; // UTF-8, nothing to do
  } catch {
    return 'CP1252'; // the usual suspect for Western subtitles
  }
}

/**
 * Returns the path of a cached .vtt for the subtitle track `key`:
 *   "s<streamIndex>" for an embedded stream, "x<n>" for the n-th sidecar file.
 */
export async function subtitleVtt(item, key) {
  const m = /^([sx])(\d+)$/.exec(key);
  if (!m) throw Object.assign(new Error('Bad subtitle id'), { status: 400 });
  const dest = path.join(dirs.subtitles, `${item.id}-${item.file_mtime || 0}-${key}.vtt`);
  if (await exists(dest)) return dest;

  return once(dest, () => limit(async () => {
    const args = ['-v', 'error', '-y'];
    if (m[1] === 's') {
      const media = parseJson(item.media_json, {});
      const stream = media.subtitles?.find((s) => s.index === Number(m[2]));
      if (!stream?.text) throw Object.assign(new Error('Not a text subtitle stream'), { status: 400 });
      args.push('-i', item.file_path, '-map', `0:${stream.index}`);
    } else {
      const subs = parseJson(item.subs_json, []);
      const sub = subs[Number(m[2])];
      if (!sub) throw Object.assign(new Error('No such subtitle file'), { status: 404 });
      if (sub.format === 'vtt') return sub.path;
      const charset = await detectCharset(sub.path);
      if (charset) args.push('-sub_charenc', charset);
      args.push('-i', sub.path);
    }
    const tmp = `${dest}.tmp`;
    args.push('-f', 'webvtt', tmp);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const { code, stderr } = await runProcess(ffmpegBin(), args, { timeoutMs: 10 * 60 * 1000 });
    if (code !== 0) throw new Error(`Subtitle conversion failed: ${stderr.trim().split('\n').pop()}`);
    await fs.rename(tmp, dest);
    return dest;
  }));
}
