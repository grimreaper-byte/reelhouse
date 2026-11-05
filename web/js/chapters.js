// A film's chapters (read from the file by the server, server/media/ffmpeg.js: { start, end, title } in seconds) and
// where the player's chapter buttons go. Pure, so it's tested on its own (test/chapters.test.js).

/** Back within this many seconds of a chapter's start goes to the chapter before; later, to the start of its own. */
export const RESTART_SECONDS = 3;
// A position this little before a chapter's start counts as in it: a seek lands a moment either side.
const SLACK = 0.5;

/** The chapters worth buttons: in order, with a start, and at least two of them (else none). */
export function usableChapters(list) {
  const chapters = (list || []).filter((c) => Number.isFinite(c?.start)).sort((a, b) => a.start - b.start);
  return chapters.length >= 2 ? chapters : [];
}

/** The chapter playing at t (its index), or -1 before the first. */
export function chapterIndex(chapters, t) {
  let index = -1;
  chapters.forEach((c, i) => {
    if (c.start <= t + SLACK) index = i;
  });
  return index;
}

/** Where "next chapter" goes ({ index, start }), or null in the last chapter. */
export function nextChapter(chapters, t) {
  const index = chapters.findIndex((c) => c.start > t + SLACK);
  return index < 0 ? null : { index, start: chapters[index].start };
}

/** Where "previous chapter" goes: the start of the chapter playing, or of the one before it just after a start. */
export function previousChapter(chapters, t) {
  const i = chapterIndex(chapters, t);
  if (i < 0) return { index: 0, start: 0 };
  const index = i > 0 && t - chapters[i].start < RESTART_SECONDS ? i - 1 : i;
  return { index, start: chapters[index].start };
}

// Titles that only repeat the number or the time ("Chapter 03", "Chapitre 3", "12", "00:05:12.000") say nothing new.
const PLAIN_TITLE = /^(?:\p{L}+\.?\s*)?\d+$|^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?$/u;

/** A chapter's own title, or null when it has none worth showing. */
export function chapterTitle(chapter) {
  const title = String(chapter?.title || '').trim();
  return title && !PLAIN_TITLE.test(title) ? title : null;
}

/** "Chapter 3 of 12 · The Heist" (the title only when it says something). */
export function chapterLabel(chapters, index) {
  const title = chapterTitle(chapters[index]);
  return `Chapter ${index + 1} of ${chapters.length}${title ? ` · ${title}` : ''}`;
}
