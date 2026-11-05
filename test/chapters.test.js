// The web player's chapter buttons (web/js/chapters.js): where previous and next go, and how a chapter is named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usableChapters, chapterIndex, nextChapter, previousChapter, chapterTitle, chapterLabel } from '../web/js/chapters.js';

const film = usableChapters([
  { start: 75, end: 120, title: 'Part Two' }, // out of order in the list: put right
  { start: 0, end: 30, title: 'Opening' },
  { start: 30, end: 75, title: 'Part One' },
  { start: 120, end: 160, title: 'Chapter 04' },
]);

test('chapters come in order, and one chapter alone is no chapters', () => {
  assert.deepEqual(film.map((c) => c.start), [0, 30, 75, 120]);
  assert.deepEqual(usableChapters([{ start: 0, end: 100, title: 'Movie' }]), []);
  assert.deepEqual(usableChapters(null), []);
  assert.deepEqual(usableChapters([{ start: 0 }, { start: Number.NaN }, { title: 'no start' }]), []);
});

test('next goes to the start of the following chapter, and nowhere from the last', () => {
  assert.deepEqual(nextChapter(film, 10), { index: 1, start: 30 });
  assert.deepEqual(nextChapter(film, 29), { index: 1, start: 30 });
  // Just landed on a chapter's start (a little before or after it): on to the one after, not the same again.
  assert.deepEqual(nextChapter(film, 29.7), { index: 2, start: 75 });
  assert.deepEqual(nextChapter(film, 30.2), { index: 2, start: 75 });
  assert.equal(nextChapter(film, 130), null);
});

test('previous goes to the start of this chapter, or the one before when it has only just begun', () => {
  assert.deepEqual(previousChapter(film, 50), { index: 1, start: 30 });
  assert.deepEqual(previousChapter(film, 31), { index: 0, start: 0 }); // 1 s in: the chapter before
  assert.deepEqual(previousChapter(film, 29.8), { index: 0, start: 0 }); // landed a moment early
  assert.deepEqual(previousChapter(film, 2), { index: 0, start: 0 }); // the first: its start
  // A film whose first chapter starts late: before it, back to the very start.
  assert.deepEqual(previousChapter(usableChapters([{ start: 20 }, { start: 60 }]), 5), { index: 0, start: 0 });
  assert.equal(chapterIndex(film, 76), 2);
});

test('a chapter is named by its title, unless the title only repeats the number or a time', () => {
  assert.equal(chapterTitle({ title: 'Part One' }), 'Part One');
  for (const plain of ['Chapter 04', 'Chapter 4', 'Chapitre 12', '7', '00:05:12.000', '1:02:03', '', null]) {
    assert.equal(chapterTitle({ title: plain }), null, String(plain));
  }
  assert.equal(chapterLabel(film, 1), 'Chapter 2 of 4 · Part One');
  assert.equal(chapterLabel(film, 3), 'Chapter 4 of 4');
});
