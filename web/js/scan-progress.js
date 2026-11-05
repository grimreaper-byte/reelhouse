// While Reelhouse adds new files to a library: after the top bar's search box, which file it's reading and how far along
// it is, with a bar under that. Only new files count (server/scanner/index.js), so routine scans that find nothing new
// show nothing. Kept up to date by the 'scan' live event.
import { h } from './dom.js';
import { api } from './api.js';

export function scanProgress() {
  const count = h('span');
  const file = h('span.scan-file');
  const el = h('div.scan-progress', { hidden: true }, h('div.scan-text', h('span.scan-verb', 'Adding '), count, file), h('div.scan-bar'));

  function set(adding) {
    if (!adding || adding.finished || !adding.total) {
      el.hidden = true;
      return;
    }
    // The file being read is the next one to finish: "4 of 12" while the 4th is read.
    const at = Math.min(adding.done + 1, adding.total);
    count.textContent = `${at} of ${adding.total}`;
    file.textContent = `: ${adding.file || '…'}`;
    el.style.setProperty('--scan', `${Math.max(2, Math.round((adding.done / adding.total) * 100))}%`);
    el.title = `Adding ${at} of ${adding.total}: ${adding.file || '…'} to ${adding.libraryName}`;
    el.hidden = false;
  }

  /** Picks up a scan already under way (on start, and when the live connection comes back). */
  async function refresh() {
    try {
      set((await api.get('/api/scan/status')).adding);
    } catch {
      // keep what's shown
    }
  }

  return { el, set, refresh };
}
