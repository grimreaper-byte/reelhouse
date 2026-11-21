// Which subtitle tracks are taken as forced (server/media/forced.js): a file's flag is believed beside an ordinary
// track in the same language or with a title that says so, not on a lone full track (as a release of The Big Bang
// Theory flags its only English track, which then came on for every episode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { believedForced } from '../server/media/forced.js';

test('a lone track flagged forced, titled as a language, is an ordinary one', () => {
  const english = { language: 'eng', title: 'English', forced: true, isDefault: true };
  assert.equal(believedForced(english, [english]), false);
});

test('a forced track beside a full one in the same language is forced', () => {
  const full = { language: 'eng', title: 'English', forced: false };
  const parts = { language: 'eng', title: null, forced: true };
  assert.equal(believedForced(parts, [full, parts]), true);
  assert.equal(believedForced(full, [full, parts]), false);
});

test('a title that says what it is is believed, alone or not', () => {
  for (const title of ['English (Forced)', 'Foreign parts', 'Signs & Songs', 'Non-English parts', 'FORCED']) {
    const t = { language: 'eng', title, forced: true };
    assert.equal(believedForced(t, [t]), true, title);
  }
});

test('another language beside it doesn’t make it forced; unflagged tracks never are', () => {
  const english = { language: 'eng', title: 'English', forced: true };
  const french = { language: 'fre', title: 'Français', forced: false };
  assert.equal(believedForced(english, [english, french]), false);
  assert.equal(believedForced(french, [english, french]), false);
  const unknown = { language: null, forced: true };
  const unknownFull = { language: null, forced: false };
  assert.equal(believedForced(unknown, [unknown, unknownFull]), true, 'both without a language: the same one');
});
