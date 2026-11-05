// Filename parsing for movies and TV episodes. Handles the common naming schemes:
//   Movies:  "Title (2019).mkv", "Title.2019.1080p.BluRay.x264.mkv", "Title (2019) {tmdb-1234}.mkv"
//   TV:      "Show - S01E02 - Name.mkv", "Show.S01E02E03.mkv", "Show 1x02.mkv", "Season 1/Episode 2.mkv",
//            "Show - 05.mkv" (absolute numbering, common for anime)
import path from 'node:path';

export const VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.m4v', '.mov', '.avi', '.wmv', '.ts', '.m2ts', '.mts', '.webm',
  '.flv', '.mpg', '.mpeg', '.ogv', '.3gp', '.divx', '.xvid', '.asf', '.vob', '.iso',
]);
// Formats we can't stream directly from the file (disc images).
export const UNSUPPORTED_EXTENSIONS = new Set(['.iso']);

export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub', '.smi']);
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// Folder names that hold bonus material rather than main content.
const EXTRA_DIRS = new Set([
  'extras', 'extra', 'featurettes', 'featurette', 'behind the scenes', 'deleted scenes', 'interviews',
  'scenes', 'shorts', 'trailers', 'trailer', 'other', 'sample', 'samples', 'bonus', 'specials features',
]);
const JUNK_DIRS = new Set(['$recycle.bin', 'system volume information', '@eadir', '.@__thumb', 'lost+found', '.trash']);

export function isIgnoredDir(name) {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || JUNK_DIRS.has(lower) || EXTRA_DIRS.has(lower);
}

export function isSampleFile(name, size) {
  return /(^|[\W_])sample([\W_]|$)/i.test(name) && size < 300 * 1024 * 1024;
}

// Release-name tokens that mark the end of a title.
const JUNK_TOKENS = [
  '2160p', '1080p', '1080i', '720p', '576p', '480p', '4k', 'uhd', 'hdr', 'hdr10', 'dv', 'dolby vision',
  'bluray', 'blu-ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'web-dl', 'webdl', 'webrip', 'web', 'hdtv',
  'hdrip', 'dvdrip', 'dvdscr', 'dvd', 'xvid', 'divx', 'x264', 'x265', 'h264', 'h.264', 'h265', 'h.265',
  'hevc', 'avc', 'av1', '10bit', '8bit', 'aac', 'ac3', 'eac3', 'dts', 'dts-hd', 'truehd', 'atmos', 'ddp5',
  'dd5', '5.1', '7.1', 'proper', 'repack', 'extended', 'unrated', 'uncut', 'remastered', 'directors cut',
  "director's cut", 'imax', 'limited', 'internal', 'multi', 'subbed', 'dubbed', 'hc', 'amzn', 'nf', 'dsnp',
  'hmax', 'atvp', 'hulu',
];
const JUNK_RE = new RegExp(
  `(?:^|[\\s._\\-\\[\\(])(?:${JUNK_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[\\s._\\-\\]\\)])`,
  'i',
);

export function extractIds(name) {
  const ids = {};
  const tmdb = name.match(/[\[{](?:tmdb|tmdbid)[-=](\d+)[\]}]/i);
  if (tmdb) ids.tmdbId = Number(tmdb[1]);
  const imdb = name.match(/[\[{](?:imdb|imdbid)[-=](tt\d+)[\]}]/i);
  if (imdb) ids.imdbId = imdb[1];
  return ids;
}

function stripIds(name) {
  return name.replace(/[\[{](?:tmdb|tmdbid|imdb|imdbid|tvdb|tvdbid)[-=][\w]+[\]}]/gi, ' ');
}

function normalizeSeparators(name) {
  // Dotted/underscored release names: "The.Matrix.1999" -> "The Matrix 1999"
  let s = name.replace(/_/g, ' ');
  const dots = (s.match(/\./g) || []).length;
  const spaces = (s.match(/ /g) || []).length;
  if (dots >= 2 && dots > spaces) s = s.replace(/\.(?!\d(?:\D|$))/g, ' ').replace(/(\D)\.(\d)/g, '$1 $2');
  return s;
}

export function cleanTitle(s) {
  return s
    .replace(/\[[^\]]*\]/g, ' ') // [group] tags
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:.,]+|[\s\-–—:.,([{]+$/g, '')
    .trim();
}

/** Parses a movie file or folder name into { title, year, tmdbId?, imdbId? }. */
export function parseMovieName(rawName) {
  const ids = extractIds(rawName);
  let name = stripIds(rawName);
  name = normalizeSeparators(name);

  // Find the last plausible year that isn't the very start of the title ("1917 (2019)", "2001 A Space Odyssey 1968").
  const yearRe = /(?:^|[\s(\[.\-])((?:19|20)\d{2})(?=$|[\s)\].\-])/g;
  let match;
  let chosen = null;
  while ((match = yearRe.exec(name))) {
    const idx = match.index + match[0].indexOf(match[1]);
    if (idx === 0) continue;
    const y = Number(match[1]);
    if (y < 1888 || y > new Date().getFullYear() + 2) continue;
    chosen = { year: y, index: idx };
  }

  let title;
  let year = null;
  if (chosen) {
    title = name.slice(0, chosen.index);
    year = chosen.year;
  } else {
    const junk = name.match(JUNK_RE);
    title = junk ? name.slice(0, junk.index) : name;
  }
  title = cleanTitle(title);
  if (!title) title = cleanTitle(name);
  return { title, year, ...ids };
}

const SEASON_DIR_RE = /^(?:season|series|saison|staffel|temporada|stagione|s)[\s._-]*(\d{1,4})(?:\D.*)?$/i;
const SPECIALS_DIR_RE = /^(?:specials?|extras?\s*\(specials\)|season\s*0+)$/i;

export function parseSeasonFolder(name) {
  if (SPECIALS_DIR_RE.test(name.trim())) return 0;
  const m = name.trim().match(SEASON_DIR_RE);
  return m ? Number(m[1]) : null;
}

// UK guides mark a new episode "New: <title>", and Tvheadend names the recording from it, writing the ":" as "_" where
// a file name can't hold one ("New_ Married at First Sight UK"), and the space as "-" when set to replace spaces
// ("New_-Married-at-First-Sight-UK"). That word isn't part of the show's name. A space or "-" must follow, so
// "New Girl" and "New_Girl" (underscores for spaces) keep theirs.
const NEW_EPISODE_PREFIX = /^\s*new\s*[:_][\s-]+/i;

/** A folder or file name without the "New: " / "New_ " a recorded new episode starts with. */
export function dropNewPrefix(name) {
  const rest = String(name ?? '').replace(NEW_EPISODE_PREFIX, '');
  return rest.trim() ? rest : String(name ?? '');
}

/** Parses a show folder name ("Show Name (2019) [tmdbid-123]") into { title, year, ids }. */
export function parseShowFolder(rawName) {
  const name = dropNewPrefix(rawName);
  const ids = extractIds(name);
  const clean = stripIds(name);
  const m = clean.match(/^(.*?)[\s.]*\((\d{4})\)\s*$/);
  if (m) return { title: cleanTitle(m[1]), year: Number(m[2]), ...ids };
  const parsed = parseMovieName(clean);
  return { title: parsed.title, year: parsed.year, ...ids };
}

/**
 * Parses an episode filename. Returns { season, episode, episodeEnd, showTitle, episodeTitle, airDate }
 * where any field may be null when not present.
 */
export function parseEpisodeName(fileName) {
  const base = dropNewPrefix(path.parse(fileName).name);
  const name = normalizeSeparators(stripIds(base));
  const out = { season: null, episode: null, episodeEnd: null, showTitle: null, episodeTitle: null, airDate: null };

  const patterns = [
    // S01E02, S01E02E03, S01E02-E03, S01 E02, S01.E02
    { re: /\bS(\d{1,4})[\s._-]*E(\d{1,4})(?:(?:[\s._]*-[\s._]*E?|[\s._]*E)(\d{1,4})(?!\d|p\b))?/i, s: 1, e: 2, end: 3 },
    // 1x02, 1x02-03
    { re: /(?:^|[^\d])(\d{1,2})x(\d{2,3})(?:-(?:\d{1,2}x)?(\d{2,3}))?(?!\d)/i, s: 1, e: 2, end: 3 },
    // Season 1 Episode 2
    { re: /Season[\s._-]*(\d{1,4})[\s._-]*Episode[\s._-]*(\d{1,4})/i, s: 1, e: 2 },
  ];
  for (const p of patterns) {
    const m = name.match(p.re);
    if (m) {
      out.season = Number(m[p.s]);
      out.episode = Number(m[p.e]);
      if (p.end && m[p.end]) {
        const end = Number(m[p.end]);
        if (end > out.episode && end - out.episode < 10) out.episodeEnd = end;
      }
      out.showTitle = cleanTitle(name.slice(0, m.index)) || null;
      out.episodeTitle = cleanEpisodeTitle(name.slice(m.index + m[0].length));
      return out;
    }
  }

  // Date-based: Show 2024-01-15
  const date = name.match(/(^|\D)((?:19|20)\d{2})[\s._-](\d{2})[\s._-](\d{2})(?!\d)/);
  if (date) {
    out.airDate = `${date[2]}-${date[3]}-${date[4]}`;
    out.showTitle = cleanTitle(name.slice(0, date.index + date[1].length)) || null;
    out.episodeTitle = cleanEpisodeTitle(name.slice(date.index + date[0].length));
    return out;
  }

  // Episode 5 / Ep05 / E05 (season comes from folder)
  const epOnly = name.match(/(?:^|[\s._-])(?:Episode|Ep|E)[\s._-]*(\d{1,4})(?!\d)/i);
  if (epOnly) {
    out.episode = Number(epOnly[1]);
    out.showTitle = cleanTitle(name.slice(0, epOnly.index)) || null;
    out.episodeTitle = cleanEpisodeTitle(name.slice(epOnly.index + epOnly[0].length));
    return out;
  }

  // Absolute numbering: "Show - 05", "Show - 105 [1080p]", "[Group] Show - 05v2"
  const abs = name.match(/^(.*?)[\s._]+-[\s._]+(\d{1,4})(?:v\d)?(?=$|[\s._\[\(])/);
  if (abs) {
    out.episode = Number(abs[2]);
    out.showTitle = cleanTitle(abs[1]) || null;
    out.episodeTitle = cleanEpisodeTitle(name.slice(abs.index + abs[0].length));
    return out;
  }

  // Bare leading number: "02 - Title.mkv" or "02.mkv" inside a season folder
  const lead = name.match(/^(\d{1,3})(?:[\s._-]+(.*))?$/);
  if (lead) {
    out.episode = Number(lead[1]);
    out.episodeTitle = lead[2] ? cleanEpisodeTitle(lead[2]) : null;
  }
  return out;
}

function cleanEpisodeTitle(s) {
  if (!s) return null;
  let t = s;
  const junk = t.match(JUNK_RE);
  if (junk) t = t.slice(0, junk.index);
  t = cleanTitle(t.replace(/^[\s._-]+/, ''));
  return t || null;
}

/** Builds a sort title: lower-case, leading articles removed. */
export function sortTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Detects subtitle language/flags from "Movie.en.forced.srt" style names. */
export function parseSubtitleName(subFile, videoBase) {
  const base = path.parse(subFile).name;
  let rest = base.length > videoBase.length && base.toLowerCase().startsWith(videoBase.toLowerCase())
    ? base.slice(videoBase.length)
    : base;
  const tags = rest.split(/[._\s-]+/).map((t) => t.toLowerCase()).filter(Boolean);
  const forced = tags.includes('forced');
  const sdh = tags.includes('sdh') || tags.includes('cc') || tags.includes('hi');
  const language = tags.find((t) => /^[a-z]{2,3}$/.test(t) && !['sdh', 'cc', 'hi'].includes(t)) || null;
  return { language, forced, sdh };
}
