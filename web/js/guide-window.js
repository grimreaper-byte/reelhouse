// Which hours the Live TV guide shows (views/livetv.js). Pure, so it's tested on its own (test/guide-window.test.js).

export const HALF_HOUR = 1800;
export const CHUNK = 6 * 3600; // hours loaded at a time

/** Today's guide starts on the half hour, up to half an hour before [now] (seconds), so what's on now is near the left. */
export const todayFrom = (now) => Math.floor((now - HALF_HOUR) / HALF_HOUR) * HALF_HOUR;

/**
 * Today's guide left open: its start moves on with the time (as [todayFrom] says), so the programmes move left and
 * the now line stays near the left edge instead of drifting right. The scroll position moves back by as much, so a
 * guide scrolled ahead keeps the same hours on screen. At least [CHUNK] is loaded from the new start.
 * Returns { from, to, scrollLeft }: the hours to load and where to scroll to.
 */
export function followNow({ from, to, scrollLeft }, now, pxPerMin) {
  const start = todayFrom(now);
  if (start <= from) return { from, to, scrollLeft };
  return {
    from: start,
    to: Math.max(to, start + CHUNK),
    scrollLeft: Math.max(0, scrollLeft - ((start - from) / 60) * pxPerMin),
  };
}
