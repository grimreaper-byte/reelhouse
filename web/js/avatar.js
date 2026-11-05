// Account pictures in the web app: drawing someone's picture (or their initial), and checking a chosen file before
// it's uploaded. The server checks and redraws it again (server/avatars.js); this catches problems first, applies the
// photo's rotation, and shows what it will look like.
import { h, formatBytes } from './dom.js';

export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const MAX_AVATAR_BYTES = 15 * 1024 * 1024; // as the server
const MIN_SIDE = 64;
const UPLOAD_SIDE = 512;
const NAMES = { 'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WebP', 'image/gif': 'GIF' };

/** What goes inside an `.avatar` circle: the user's picture, or the first letter of their name. */
export function avatarContent(user) {
  const initial = (user.username || '?').slice(0, 1);
  if (!user.avatar) return initial;
  const img = h('img', { src: user.avatar, alt: '', decoding: 'async', draggable: 'false' });
  img.addEventListener('error', () => img.replaceWith(initial));
  return img;
}

/** Whether a file's first bytes are what its type says (a renamed file isn't a picture). */
function bytesMatch(head, type) {
  const ascii = (a, b) => String.fromCharCode(...head.slice(a, b));
  switch (type) {
    case 'image/jpeg': return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png': return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b);
    case 'image/gif': return /^GIF8[79]a$/.test(ascii(0, 6));
    case 'image/webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    default: return false;
  }
}

/**
 * Checks a chosen file and makes the square picture to upload (the middle of it, upright, as a JPEG).
 * Resolves { blob, url, width, height }; rejects with a reason fit to show.
 */
export async function prepareAvatar(file) {
  const name = `“${file.name}”`;
  if (/^image\/hei[cf]$/.test(file.type) || /\.(heic|heif)$/i.test(file.name)) {
    throw new Error('HEIC photos can’t be used from a browser. Choose a JPEG or PNG, or set the picture from the Reelhouse app.');
  }
  if (!AVATAR_TYPES.includes(file.type)) throw new Error(`${name} isn’t a JPEG, PNG, WebP or GIF picture.`);
  if (!file.size) throw new Error(`${name} is empty.`);
  if (file.size > MAX_AVATAR_BYTES) throw new Error(`${name} is ${formatBytes(file.size)}; pictures can be up to 15 MB.`);
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!bytesMatch(head, file.type)) throw new Error(`${name} isn’t really a ${NAMES[file.type]} picture (it may be damaged, or renamed).`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file); // turns phone photos upright (their rotation tag)
  } catch {
    throw new Error(`${name} couldn’t be opened as a picture. It may be damaged.`);
  }
  const { width, height } = bitmap;
  try {
    if (width < MIN_SIDE || height < MIN_SIDE) throw new Error(`${name} is only ${width}×${height}. Choose a picture at least ${MIN_SIDE} pixels each way.`);
    const side = Math.min(width, height);
    const canvas = h('canvas', { width: Math.min(UPLOAD_SIDE, side), height: Math.min(UPLOAD_SIDE, side) });
    const g = canvas.getContext('2d');
    // Transparent parts get the page's background colour rather than JPEG's black.
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-elev2').trim() || '#262a30';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, (width - side) / 2, (height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The picture couldn’t be prepared. Try another.'))), 'image/jpeg', 0.9,
    ));
    return { blob, url: URL.createObjectURL(blob), width, height };
  } finally {
    bitmap.close();
  }
}
