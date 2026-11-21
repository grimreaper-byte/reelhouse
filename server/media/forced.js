// Which subtitle tracks are forced subtitles: only the parts in another language (signs, a foreign scene), which
// Reelhouse's players show without being asked (the audio's language's). Files say so with a "forced" flag, but some
// releases flag their only, full subtitle track forced (every episode of a series, with "English" as its title), and
// those would come on for everything. So the flag is believed when the track says what it is in its title, or when
// it sits beside an ordinary track in the same language (a full one, which a real forced track goes with).

const FORCED_TITLE = /forced|foreign|signs|songs|parts|non[ -]?english|narrative/i;

/**
 * Whether [track] ({ forced, language, title }) is forced subtitles, among [all] the item's subtitle tracks (embedded
 * and sidecar files alike).
 */
export function believedForced(track, all) {
  if (!track?.forced) return false;
  if (FORCED_TITLE.test(track.title || '')) return true;
  const lang = track.language || null;
  return all.some((o) => o !== track && !o.forced && (o.language || null) === lang);
}
