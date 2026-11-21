// The subtitles a film or episode starts with in the web player, as Settings → Languages says (the server's
// defaults.subtitles: { mode, language, codes }), the same rule as the Android app's and the Kodi add-on's:
//   1. what the episode before carried: { off } stays off, { language } finds a track in it;
//   2. mode "off": none, forced ones too (anyone can still turn them on in the player);
//   3. "always", or "foreign" while the sound is in another language: the preferred language's track (a full one
//      before SDH; text only, as an image one would need the film converted);
//   4. else (and "forced", today's behaviour): a file's forced subtitles for the language of the sound, or the
//      forced track marked default. The server already left out forced flags it doesn't believe (forced.js).

/** A language tag as the server's codes list it: lower case, no region ("en-US" → "en"). */
export const plainLanguage = (code) => String(code || '').trim().toLowerCase().split(/[-_]/)[0];

/**
 * Whether two tracks' languages are the same one, whichever codes their files use ("en" for a subtitle file next to
 * the video, "eng" for its sound track): the browser's Intl knows the ISO 639-2 codes for 639-1 ones (CLDR).
 */
export function sameLanguage(a, b) {
  const base = (code) => {
    const plain = plainLanguage(code);
    try {
      return new Intl.Locale(Intl.getCanonicalLocales(plain)[0]).language;
    } catch {
      return plain;
    }
  };
  return !!plainLanguage(a) && base(a) === base(b);
}

/** Whether a track's language is one of the server's codes for a language. */
export const inCodes = (code, codes) => !!code && (codes || []).includes(plainLanguage(code));

const SDH = /\bsdh\b|hearing[ -]impaired|\bcc\b/i;

/** Subtitles for the deaf and hard of hearing (sound effects too): last among a language's tracks. */
export const isSdh = (track) => SDH.test(track?.title || '');

/** The track in a language to turn on (the full one before SDH, never a forced one), or null. */
export function preferredSubtitle(tracks, codes) {
  const inLanguage = (tracks || []).filter((t) => t.kind === 'text' && !t.forced && inCodes(t.language, codes));
  return inLanguage.find((t) => !isSdh(t)) || inLanguage[0] || null;
}

/** Whether a sound track's language is known (not "und"). */
const known = (code) => !!plainLanguage(code) && plainLanguage(code) !== 'und';

/**
 * The subtitle track to start with, or null for none. [carried] is what the episode before passed on ({ off } or
 * { language }), [audioLanguage] the playing sound track's, [subtitles] the server's defaults.subtitles.
 */
export function chooseSubtitle(tracks, { audioLanguage = null, carried = null, subtitles = null } = {}) {
  const text = (tracks || []).filter((t) => t.kind === 'text');
  if (carried?.off) return null;
  if (carried) {
    const lang = carried.language;
    const same = text.filter((t) => sameLanguage(t.language, lang));
    const pick = same.find((t) => !t.forced) || same[0] || (lang ? null : text.find((t) => !t.forced)) || null;
    if (pick) return pick;
  }
  const mode = subtitles?.mode || 'forced';
  if (mode === 'off') return null;
  const codes = subtitles?.codes || [];
  const wanted = mode === 'always' || (mode === 'foreign' && known(audioLanguage) && !inCodes(audioLanguage, codes));
  if (wanted) {
    const pick = preferredSubtitle(text, codes);
    if (pick) return pick;
  }
  const forced = text.filter((t) => t.forced);
  return forced.find((t) => sameLanguage(t.language, audioLanguage)) || forced.find((t) => t.isDefault) || null;
}
