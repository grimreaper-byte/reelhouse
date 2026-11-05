// The top bar's activity count, for admins: a TV with the number of streams being watched on its screen. A shortcut
// to Settings → Activity & logs; kept up to date by the 'activity' live event (server/activity.js).
import { h } from './dom.js';
import { api } from './api.js';
import { navigate } from './router.js';

const SVG = 'http://www.w3.org/2000/svg';
const SCREEN_MIDDLE = 10.5; // the screen rect runs from y 3.5 to 17.5
const DIGIT_HEIGHT_EM = 0.72; // Segoe UI, Roboto and the like (measured: 6.5 units at font-size 9)

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** A TV (screen and stand) with a number in the middle of the screen. */
function tvWithNumber() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: 26, height: 26, 'aria-hidden': 'true' });
  svg.append(
    svgEl('rect', { x: 2, y: 3.5, width: 20, height: 14, rx: 2.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }),
    svgEl('path', { d: 'M8 21h8 M12 17.5V21', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }),
  );
  // Placed on the ordinary (alphabetic) baseline, worked out in set() from the digits' height. "central" centres the
  // font's em box instead, which put the digits about 1 px (1 unit) below the screen's middle in Firefox and Chromium.
  const number = svgEl('text', { x: 12, 'text-anchor': 'middle', fill: 'currentColor', 'font-weight': 700 });
  svg.append(number);
  return { svg, number };
}

export function activityButton() {
  const { svg, number } = tvWithNumber();
  const el = h('a.btn.btn-ghost.btn-icon.activity-btn', { href: '/settings/activity' }, svg);
  el.addEventListener('click', (e) => {
    e.preventDefault();
    navigate('/settings/activity');
  });

  function set(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const size = n > 99 ? 6 : n > 9 ? 7.5 : 9;
    number.textContent = n > 99 ? '99+' : String(n);
    number.setAttribute('font-size', size);
    // Digits stand about 0.72 em tall on the baseline: half of that below the screen's middle (y 10.5) centres them.
    number.setAttribute('y', (SCREEN_MIDDLE + DIGIT_HEIGHT_EM * size / 2).toFixed(2));
    el.classList.toggle('live', n > 0);
    const what = n === 0 ? 'Nothing is being watched' : `${n} ${n === 1 ? 'stream is' : 'streams are'} being watched`;
    el.setAttribute('aria-label', `${what}. Open Activity & logs`);
    el.title = `${what} — Activity & logs`;
  }

  async function refresh() {
    try {
      set((await api.get('/api/activity')).sessions.length);
    } catch {
      // keep the last count
    }
  }

  set(0);
  return { el, set, refresh };
}
