// DOM helpers, icons and formatting.

/**
 * h('div.card#id', { onClick, href }, ...children)
 * Props are optional; children may be strings, nodes, arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const [, name = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(tag);
  const el = name === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(name);
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
  } else {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.classList.add(...String(v).split(/\s+/).filter(Boolean));
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (['value', 'checked', 'selected', 'disabled', 'muted', 'volume', 'playsInline'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** Like el.replaceChildren(), but flattens arrays and skips null/false the way h() does. */
export function setChildren(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// ---------- icons (24×24, stroke) ----------

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  film: 'M4 4h16v16H4z M8 4v16 M16 4v16 M4 8h4 M4 12h4 M4 16h4 M16 8h4 M16 12h4 M16 16h4',
  tv: 'M3 7h18v12H3z M8 3l4 4 4-4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-5-5',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  play: 'M7 4.6v14.8a1 1 0 0 0 1.53.85l11.8-7.4a1 1 0 0 0 0-1.7L8.53 3.75A1 1 0 0 0 7 4.6z',
  pause: 'M6 4h4v16H6z M14 4h4v16h-4z',
  stop: 'M6 6h12v12H6z',
  back10: 'M3 12a9 9 0 1 0 2.64-6.36L3 8.3 M3 3.5v4.8h4.8 M10 9.5v6 M13 11a1.5 1.5 0 0 1 3 0v3a1.5 1.5 0 0 1-3 0z',
  fwd30: 'M21 12a9 9 0 1 1-2.64-6.36L21 8.3 M21 3.5v4.8h-4.8 M8 10h2.2a1 1 0 0 1 0 2.4H9.2 M9.2 12.4h1a1 1 0 0 1 0 2.4H8 M13 11a1.5 1.5 0 0 1 3 0v3a1.5 1.5 0 0 1-3 0z',
  volume: 'M11 5 6 9H3v6h3l5 4z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13',
  mute: 'M11 5 6 9H3v6h3l5 4z M16 9l6 6 M22 9l-6 6',
  fullscreen: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  exitFullscreen: 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5',
  subtitles: 'M3 5h18v14H3z M7 15h4 M13 15h4 M7 11h2 M11 11h6',
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M6 6l12 12 M18 6 6 18',
  arrowLeft: 'M19 12H5 M11 18l-6-6 6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  menu: 'M3 6h18 M3 12h18 M3 18h18',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21a7 7 0 0 1 14 0 M16 3.5a4 4 0 0 1 0 7.5 M22 21a7 7 0 0 0-4-6.3',
  refresh: 'M20 11a8 8 0 0 0-14.9-3.9L4 8 M4 3v5h5 M4 13a8 8 0 0 0 14.9 3.9L20 16 M20 21v-5h-5',
  edit: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  folder: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  download: 'M12 4v12 M7 11l5 5 5-5 M4 20h16',
  upload: 'M12 20V8 M7 13l5-5 5 5 M4 4h16',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 4 M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.1-1.4 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v6 M12 7.5h.01',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1 M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  pip: 'M3 5h18v14H3z M12 12h7v5h-7z',
  skipNext: 'M5 4l10 8-10 8z M19 5v14',
  skipPrev: 'M19 4L9 12l10 8z M5 5v14',
  // The player's chapter buttons: chevrons against a bar, unlike the episode buttons' triangles beside them.
  chapterPrev: 'M5 5v14 M18 6l-6 6 6 6 M13 6l-6 6 6 6',
  chapterNext: 'M19 5v14 M6 6l6 6-6 6 M11 6l6 6-6 6',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  signOut: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4 M10 17l-5-5 5-5 M5 12h11',
  server: 'M4 4h16v6H4z M4 14h16v6H4z M8 7h.01 M8 17h.01',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  key: 'M14 10a5 5 0 1 0-4 4.9V17h2v2h2v2h4v-4l-4-4a5 5 0 0 0 0-3z',
  image: 'M3 5h18v14H3z M3 16l5-5 4 4 3-3 6 6 M15.5 9.5h.01',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  speed: 'M12 21a9 9 0 1 1 9-9 M12 12l5-3',
  wrench: 'M14.7 6.3a4 4 0 0 0 5 5L22 14l-8 8-2.3-2.3a4 4 0 0 0-5-5L4 12l8-8z',
  record: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
  radio: 'M4 9h16v11H4z M7 9l10-5 M8 14.5a2 2 0 1 0 4 0 2 2 0 0 0-4 0 M15 13h2 M15 16h2',
  chevronUp: 'M6 15l6-6 6 6',
  request: 'M6 3h12v18l-6-4.5L6 21z M12 7v6 M9 10h6', // a bookmark with a plus: Requests
  // Library icons (LIBRARY_ICONS below), with film and tv.
  tvRecord: 'M3 7h18v12H3z M8 3l4 4 4-4', // and a red spot (SPOTS)
  tvOld: 'M3 8h18v12H3z M8 3l4 5 4-5 M6 11h8v6H6z M17.5 12h.01 M17.5 15.5h.01',
  tvFlat: 'M3 4h18v12H3z M12 16v4 M8 20h8',
  tvPlay: 'M3 7h18v12H3z M8 3l4 4 4-4 M10.5 10.5v6l4.5-3z',
  clapperboard: 'M3 11h18v9H3z M2.5 7.5L19.5 3l1 3.5L3.5 11z M7.6 6.15l2.36 3.14 M13.04 4.71l2.36 3.14',
  movieCamera: 'M3 11h12v9H3z M15 14l6-3v9l-6-3 M6.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z M12.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  trophy: 'M7 4h10v5a5 5 0 0 1-10 0z M7 6H4v1a3 3 0 0 0 3 3 M17 6h3v1a3 3 0 0 1-3 3 M12 14v4 M8 21h8l-1-3H9z',
  heart: 'M12 20s-8-4.7-8-10.6A4.4 4.4 0 0 1 12 6.8a4.4 4.4 0 0 1 8 2.6C20 15.3 12 20 12 20z',
};
const FILLED = new Set(['play', 'pause', 'stop', 'star', 'record']);
// Icons with a spot of colour drawn over the outline, whatever colour the outline takes: [x, y, radius] on the 24×24
// grid (.icon-spot in app.css colours it).
const SPOTS = { tvRecord: [12, 13, 3] };

/**
 * The icons a library can have, in Settings → Libraries' picker order (server/libraries.js has the same list), each
 * with what it shows. A library without one of these shows its type's.
 */
export const LIBRARY_ICONS = [
  ['film', 'Film strip'], ['tv', 'TV'], ['tvRecord', 'TV recording'], ['tvOld', 'Old TV'], ['tvFlat', 'Flat TV'],
  ['tvPlay', 'TV with play'], ['clapperboard', 'Clapperboard'], ['movieCamera', 'Movie camera'], ['trophy', 'Trophy'],
  ['heart', 'Heart'],
];
export const typeIcon = (type) => (type === 'movie' ? 'film' : 'tv');
/** The icon a library shows (one from a newer server this page doesn't know: its type's). */
export const libraryIcon = (lib) => (LIBRARY_ICONS.some(([name]) => name === lib.icon) ? lib.icon : typeIcon(lib.type));

export function icon(name, size = 20, extraClass) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  if (extraClass) svg.setAttribute('class', extraClass);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.info);
  if (FILLED.has(name)) {
    path.setAttribute('fill', 'currentColor');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', name === 'more' ? '3' : '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(path);
  if (SPOTS[name]) {
    const [cx, cy, r] = SPOTS[name];
    const spot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const [k, v] of Object.entries({ cx, cy, r, class: 'icon-spot' })) spot.setAttribute(k, v);
    svg.append(spot);
  }
  return svg;
}

// ---------- formatting ----------

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const hrs = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return hrs ? `${hrs}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatDuration(seconds) {
  if (!seconds) return '';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} hr ${mins % 60 ? `${mins % 60} min` : ''}`.trim();
}

export function formatBytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${units[i]}`;
}

export function formatBitrate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  const days = Math.floor(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

// ISO 639-2/B codes that Intl doesn't know, mapped to 639-1.
const BIBLIOGRAPHIC = { ger: 'de', fre: 'fr', dut: 'nl', chi: 'zh', cze: 'cs', gre: 'el', per: 'fa', rum: 'ro', slo: 'sk', alb: 'sq', arm: 'hy', baq: 'eu', bur: 'my', geo: 'ka', ice: 'is', mac: 'mk', mao: 'mi', may: 'ms', tib: 'bo', wel: 'cy' };
let langNames;
export function languageName(code) {
  if (!code) return null;
  try {
    langNames ||= new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' });
    const name = langNames.of(BIBLIOGRAPHIC[code.toLowerCase()] || code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function channelsLabel(n) {
  return { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' }[n] || (n ? `${n} ch` : '');
}

export function codecLabel(codec) {
  const map = {
    h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', vc1: 'VC-1',
    aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital+', dts: 'DTS', truehd: 'TrueHD', flac: 'FLAC', opus: 'Opus',
    mp3: 'MP3', vorbis: 'Vorbis', pcm_s16le: 'PCM', pcm_s24le: 'PCM',
    subrip: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'WebVTT', mov_text: 'MP4 text', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub', dvb_subtitle: 'DVB', srt: 'SRT', vtt: 'WebVTT',
  };
  return map[codec] || (codec ? codec.toUpperCase() : '');
}

/** Image URL sized for the display (rounded to a few buckets so caches hit). */
export function imgUrl(url, cssWidth) {
  if (!url) return null;
  const want = cssWidth * Math.min(window.devicePixelRatio || 1, 2);
  const bucket = [160, 240, 320, 480, 640, 960, 1280, 1920].find((b) => b >= want) || 1920;
  return `${url}${url.includes('?') ? '&' : '?'}w=${bucket}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function episodeLabel(item) {
  if (item.seasonNumber == null) return '';
  const s = item.seasonNumber === 0 ? 'Special' : `S${item.seasonNumber}`;
  if (item.episodeNumber == null) return s;
  const e = item.episodeEnd ? `E${item.episodeNumber}–${item.episodeEnd}` : `E${item.episodeNumber}`;
  return `${s} · ${e}`;
}
