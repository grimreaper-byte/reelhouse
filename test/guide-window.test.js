// The Live TV guide's hours (web/js/guide-window.js): left open, today's guide follows the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayFrom, followNow, CHUNK } from '../web/js/guide-window.js';

const at = (h, m = 0) => Date.UTC(2026, 9, 28, h, m) / 1000;
const PX_PER_MIN = 5;

test('today starts on the half hour, up to half an hour before now', () => {
  assert.equal(todayFrom(at(16, 2)), at(15, 30));
  assert.equal(todayFrom(at(16, 30)), at(16, 0));
  assert.equal(todayFrom(at(16, 59)), at(16, 0));
});

test('left open, the programmes move left and the now line stays near the left', () => {
  // Opened at 16:02 (from 15:30), still open at 19:07: from moves on to 18:30, and the guide was at its start.
  const opened = { from: at(15, 30), to: at(15, 30) + CHUNK, scrollLeft: 0 };
  const later = followNow(opened, at(19, 7), PX_PER_MIN);
  assert.equal(later.from, at(18, 30));
  assert.equal(later.scrollLeft, 0);
  assert.equal(later.to, at(18, 30) + CHUNK); // a full six hours ahead of the new start
  // The now line: 37 minutes in, not three and a half hours.
  assert.equal(((at(19, 7) - later.from) / 60) * PX_PER_MIN, 185);
});

test('a guide scrolled ahead keeps the hours it shows', () => {
  // Scrolled to 22:00 (6.5 h after 15:30); half an hour later the start moves on by 30 minutes, the scroll back as much.
  const looking = { from: at(15, 30), to: at(23, 30), scrollLeft: 6.5 * 60 * PX_PER_MIN };
  const later = followNow(looking, at(16, 35), PX_PER_MIN);
  assert.equal(later.from, at(16, 0));
  assert.equal(later.from + (later.scrollLeft / PX_PER_MIN) * 60, at(22, 0));
  assert.equal(later.to, at(23, 30)); // more already loaded stays
});

test('within the same half hour nothing moves', () => {
  const opened = { from: at(15, 30), to: at(21, 30), scrollLeft: 40 };
  assert.deepEqual(followNow(opened, at(16, 29), PX_PER_MIN), opened);
});
