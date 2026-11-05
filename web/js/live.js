// Live library updates. While the tab is visible, an EventSource listens for library changes
// (new or removed files, freshly fetched posters); the sidebar counts update and the page on
// screen re-renders quietly if it shows that library. Hidden tabs disconnect, so a pile of
// background tabs doesn't use up the browser's six connections to the server, and catch up
// when they're shown again.
import { refresh } from './router.js';
import { state } from './state.js';
import { toast } from './components.js';

const SETTLE_MS = 1200; // coalesce bursts of events into one refresh
const BUSY_RETRY_MS = 2000;

let source = null;
let version = null; // last library version seen; a different one on reconnect means we missed changes
let interest = null; // { path, ids: 'all' | Set } for the page on screen
let timer = null;
let retryTimer = null;
let onLibraries = () => {};
let activity = null; // the top bar's activity count (admins), see activity-badge.js
let scan = null; // the top bar's "Adding …" while new files are read, see scan-progress.js
let onMe = () => {}; // asks /api/me again (Live TV turned on or off, or this account's switches changed)

/**
 * Views call this to be re-rendered when one of these libraries changes ('all' for any).
 * Tied to the current URL, so it lapses as soon as the user goes elsewhere.
 */
export function liveRefresh(libraryIds = 'all') {
  interest = {
    path: location.pathname + location.search,
    ids: libraryIds === 'all' ? 'all' : new Set([].concat(libraryIds).filter((x) => x != null).map(Number)),
  };
}

const onPage = () => interest && interest.path === location.pathname + location.search;
const wants = (libraryId) => onPage() && (interest.ids === 'all' || interest.ids.has(Number(libraryId)));

// Don't yank the page out from under someone mid-action.
function busy() {
  if (document.hidden || document.querySelector('.modal-backdrop, .menu')) return true;
  const a = document.activeElement;
  return !!a?.closest?.('main') && a.matches('input, select, textarea');
}

function scheduleRefresh() {
  clearTimeout(timer);
  timer = setTimeout(function apply() {
    if (!onPage()) return;
    if (busy()) {
      timer = setTimeout(apply, BUSY_RETRY_MS);
      return;
    }
    void refresh();
  }, SETTLE_MS);
}

function announce(data) {
  if (!(data.added > 0) || location.pathname.startsWith('/play/')) return;
  const lib = state.libraries.find((l) => l.id === data.libraryId);
  if (!lib) return;
  const noun = lib.type === 'movie' ? 'movie' : 'episode';
  toast(`${data.added} new ${noun}${data.added === 1 ? '' : 's'} in ${lib.name}`);
}

function onLibraryEvent(data) {
  version = data.version;
  onLibraries();
  announce(data);
  if (data.deleted ? onPage() : wants(data.libraryId)) scheduleRefresh();
}

function connect() {
  if (source || document.hidden) return;
  clearTimeout(retryTimer);
  source = new EventSource('/api/events');
  source.addEventListener('hello', (e) => {
    // (Re)connected: streams may have started or stopped while this tab wasn't listening.
    void activity?.refresh();
    void scan?.refresh();
    const { version: v } = JSON.parse(e.data);
    const missed = version != null && v !== version;
    version = v;
    if (missed) {
      onLibraries();
      if (onPage()) scheduleRefresh();
    }
  });
  source.addEventListener('library', (e) => onLibraryEvent(JSON.parse(e.data)));
  // A stream started or stopped (admins only).
  source.addEventListener('activity', (e) => activity?.set(JSON.parse(e.data).count));
  // New files being added to a library this user can open: which one, and how far along.
  source.addEventListener('scan', (e) => scan?.set(JSON.parse(e.data)));
  // Live TV turned on or off, or this account's Live TV switches changed: show or hide it.
  source.addEventListener('livetv', () => onMe());
  // Someone asked for a film, a request was removed, or a requested film arrived: the sidebar's count and an open
  // Requests page follow (see app.js and views/requests.js).
  source.addEventListener('requests', (e) => window.dispatchEvent(new CustomEvent('reelhouse:requests', { detail: JSON.parse(e.data) })));
  // E.g. downloads turned off: the item menu stops offering "Download file".
  source.addEventListener('defaults', (e) => {
    if (state.me) state.me.defaults = JSON.parse(e.data);
  });
  source.addEventListener('error', () => {
    // The browser retries dropped connections itself; it gives up on HTTP errors (e.g. signed out).
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      retryTimer = setTimeout(connect, 30000);
    }
  });
}

function disconnect() {
  source?.close();
  source = null;
}

let started = false;
/**
 * Start listening (after sign-in). `refreshLibraries` reloads the sidebar's library list; `activityCount` (admins)
 * is the top bar's count of what's being watched; `scanProgress` is its "Adding …"; `refreshMe` asks
 * /api/me again when Live TV changes.
 */
export function startLive(refreshLibraries, activityCount = null, scanProgress = null, refreshMe = null) {
  activity = activityCount;
  scan = scanProgress;
  onMe = refreshMe || (() => {});
  void activity?.refresh();
  void scan?.refresh();
  let pending = null;
  onLibraries = () => {
    clearTimeout(pending);
    pending = setTimeout(() => void refreshLibraries(), 500);
  };
  if (started || typeof EventSource === 'undefined') return;
  started = true;
  document.addEventListener('visibilitychange', () => (document.hidden ? disconnect() : connect()));
  connect();
}
