// The picture someone chooses for their account (Your account, or the Android app's settings). Every upload is
// checked before it's kept: its size; what its first bytes say it is (JPEG, PNG, WebP or GIF, so never SVG or
// anything else that could carry script); and that ffprobe reads it as that kind of picture, with sensible
// dimensions. ffmpeg then redraws it as a 256 px square JPEG, so what's stored is always a fresh, plain image without
// the original's metadata (a phone photo's location, for one).
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { get, run } from './db.js';
import { dirs } from './lib/paths.js';
import { ffmpegBin, ffprobeBin, runProcess } from './media/ffmpeg.js';

export const MAX_AVATAR_BYTES = 15 * 1024 * 1024;
export const AVATAR_SIZE = 256;
export const MIN_AVATAR_SIDE = 64;
const MAX_PIXELS = 50e6;

/** A problem with the picture itself, for the person who chose it. */
export class AvatarError extends Error {}

const avatarDir = () => path.join(dirs.data, 'avatars');
export const avatarFile = (userId) => path.join(avatarDir(), `${Number(userId)}.jpg`);

/** What a file's first bytes say it is: 'jpeg', 'png', 'gif' or 'webp'; 'heif' for HEIC/AVIF photos; else null. */
export function imageKind(head) {
  const ascii = (a, b) => head.subarray(a, b).toString('latin1');
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return 'gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (head.length >= 12 && ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|avif)$/.test(ascii(8, 12))) return 'heif';
  return null;
}

// What ffprobe must call the picture for each kind, so a file can't claim to be one thing and be another.
const CODECS = { jpeg: ['mjpeg'], png: ['png'], gif: ['gif'], webp: ['webp'] };

/** Checks the picture coming in on `stream`, stores it as `userId`'s avatar and returns when it was set (ms). */
export async function saveAvatar(userId, stream) {
  await fs.mkdir(avatarDir(), { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(avatarDir(), `upload-${id}.tmp`);
  const out = path.join(avatarDir(), `upload-${id}.jpg`);
  let size = 0;
  const limit = new Transform({
    transform(chunk, enc, done) {
      size += chunk.length;
      if (size > MAX_AVATAR_BYTES) return done(new AvatarError(`That picture is over ${MAX_AVATAR_BYTES / 1024 / 1024} MB. Choose a smaller one.`));
      done(null, chunk);
    },
  });
  try {
    await pipeline(stream, limit, createWriteStream(tmp));
    if (!size) throw new AvatarError('No picture was sent.');
    const head = Buffer.alloc(16);
    const fh = await fs.open(tmp);
    try {
      await fh.read(head, 0, head.length, 0);
    } finally {
      await fh.close();
    }
    const kind = imageKind(head);
    if (kind === 'heif') throw new AvatarError('HEIC and AVIF photos can’t be used here. Choose a JPEG or PNG (or upload it from the Reelhouse app, which converts it).');
    if (!kind) throw new AvatarError('That isn’t a picture Reelhouse can use. Choose a JPEG, PNG, WebP or GIF.');

    const probed = await runProcess(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', tmp], { timeoutMs: 20000 });
    let info = null;
    try {
      info = probed.code === 0 ? JSON.parse(probed.stdout).streams?.[0] : null;
    } catch {
      info = null;
    }
    if (!info || !CODECS[kind].includes(info.codec_name) || !(info.width > 0) || !(info.height > 0)) {
      throw new AvatarError('That picture is damaged, or isn’t the kind of file it looks like.');
    }
    if (info.width < MIN_AVATAR_SIDE || info.height < MIN_AVATAR_SIDE) {
      throw new AvatarError(`That picture is too small (${info.width}×${info.height}). Choose one at least ${MIN_AVATAR_SIDE} pixels each way.`);
    }
    if (info.width * info.height > MAX_PIXELS) throw new AvatarError('That picture is too big to use (over 50 megapixels).');

    // The middle square, scaled to AVATAR_SIZE; no metadata comes along.
    const square = `scale=${AVATAR_SIZE}:${AVATAR_SIZE}:force_original_aspect_ratio=increase,crop=${AVATAR_SIZE}:${AVATAR_SIZE}`;
    const drawn = await runProcess(ffmpegBin(), [
      '-v', 'error', '-y', '-i', tmp, '-map', '0:v:0', '-frames:v', '1', '-vf', square, '-map_metadata', '-1',
      '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2', out,
    ], { timeoutMs: 30000 });
    if (drawn.code !== 0) throw new AvatarError('That picture couldn’t be read. Try another, or save it again as a JPEG or PNG.');
    await fs.rename(out, avatarFile(userId));
    const at = Date.now();
    run('UPDATE users SET avatar_at = ? WHERE id = ?', at, userId);
    return at;
  } finally {
    await fs.rm(tmp, { force: true });
    await fs.rm(out, { force: true });
  }
}

export async function removeAvatar(userId) {
  await fs.rm(avatarFile(userId), { force: true });
  run('UPDATE users SET avatar_at = NULL WHERE id = ?', userId);
}

/** The stored avatar file for a user, or null when they have none. */
export async function avatarPath(userId) {
  const row = get('SELECT avatar_at FROM users WHERE id = ?', Number(userId));
  if (!row?.avatar_at) return null;
  const file = avatarFile(userId);
  return (await fs.stat(file).catch(() => null)) ? file : null;
}
