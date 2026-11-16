// History-API router. Views are async functions (ctx) => Node; ctx.signal aborts when the user
// navigates away and ctx.onCleanup registers teardown work.

const routes = [];
let current = null;
let renderTarget = null;
let notFound = null;
const navListeners = new Set();

// Where each page in this tab's history was scrolled to when it was left, so Back and Forward come back to the same
// place (a library's grid, Home's rows, a film page after the player), as the Android app does. Keyed by the history
// entry (history.state.key); a link or the sidebar opens a page at its top as before. Views see ctx.restoring and
// ctx.key, to render as much as they had then (the library's grid renders in chunks).
const SCROLLS_KEPT = 100;
const scrolls = new Map();
let keyCount = 0;
const newKey = () => `${Date.now().toString(36)}.${(keyCount++).toString(36)}`;

function remember(key, saved) {
  scrolls.delete(key);
  scrolls.set(key, saved);
  if (scrolls.size > SCROLLS_KEPT) scrolls.delete(scrolls.keys().next().value);
}

export function route(pattern, view, opts = {}) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/\/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '/([^/]+)';
  })}/?$`);
  routes.push({ re, keys, view, opts });
}

export function setNotFound(view) {
  notFound = view;
}

/** target(opts) returns the element to render a route into (lets the app choose shell vs. fullscreen). */
export function setRenderTarget(fn) {
  renderTarget = fn;
}

export const onNavigate = (fn) => navListeners.add(fn);

export function navigate(url, { replace = false, state } = {}) {
  if (replace) history.replaceState({ ...(state || {}), key: history.state?.key || newKey() }, '', url);
  else history.pushState({ ...(state || {}), internal: true, key: newKey() }, '', url);
  return render();
}

export function back(fallback = '/') {
  if (history.state?.internal) history.back();
  else navigate(fallback, { replace: true });
}

export function currentPath() {
  return location.pathname;
}

/**
 * Re-render the current page in place (live updates): no spinner, and the page keeps its scroll
 * position and the scroll position of rows marked with data-scroll-key. Views see ctx.refresh.
 */
export function refresh() {
  return render({ soft: true });
}

function captureScroll(target) {
  const rows = new Map();
  for (const el of target.querySelectorAll('[data-scroll-key]')) if (el.scrollLeft) rows.set(el.dataset.scrollKey, el.scrollLeft);
  return { top: target.scrollTop, rows };
}

function restoreScroll(target, saved) {
  target.scrollTop = saved.top;
  for (const el of target.querySelectorAll('[data-scroll-key]')) {
    const left = saved.rows.get(el.dataset.scrollKey);
    if (left) el.scrollTo({ left, behavior: 'instant' });
  }
}

/** `popped`: Back or Forward brought this page back, so it returns to where it was scrolled to (if this tab saw it). */
export async function render({ soft = false, popped = false } = {}) {
  const path = location.pathname;
  const key = history.state?.key || null;
  // The page being left, before anything replaces it (the spinner included).
  if (!soft && current?.key && current.target?.isConnected) remember(current.key, captureScroll(current.target));
  const restoring = popped && key ? scrolls.get(key) || null : null;
  const query = Object.fromEntries(new URLSearchParams(location.search));
  let match = null;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (m) {
      match = { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
  }
  if (current) {
    current.controller.abort();
    for (const fn of current.cleanups) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }
  const controller = new AbortController();
  const ctx = {
    path,
    params: match?.params || {},
    query,
    signal: controller.signal,
    refresh: soft,
    restoring: !!restoring,
    key,
    cleanups: [],
    onCleanup(fn) {
      this.cleanups.push(fn);
    },
  };
  const opts = match?.route.opts || {};
  const target = renderTarget(opts);
  current = { controller, cleanups: ctx.cleanups, key, target };
  if (!soft) for (const fn of navListeners) fn(path, opts);
  const view = match?.route.view || notFound;

  const saved = soft ? captureScroll(target) : null;
  if (!opts.keepScroll && !soft) target.scrollTop = 0;
  // Show a spinner only if the view takes a moment to load.
  const spinnerTimer = setTimeout(() => {
    if (controller.signal.aborted || soft) return;
    const box = document.createElement('div');
    box.className = 'boot';
    box.append(Object.assign(document.createElement('div'), { className: 'spinner' }));
    target.replaceChildren(box);
  }, 150);
  try {
    const node = await view(ctx);
    clearTimeout(spinnerTimer);
    if (controller.signal.aborted) return;
    target.replaceChildren(node);
    if (saved || restoring) restoreScroll(target, saved || restoring);
  } catch (err) {
    clearTimeout(spinnerTimer);
    if (controller.signal.aborted || err.name === 'AbortError') return;
    console.error(err);
    // A live refresh that hits a hiccup keeps what's on screen; a removed item still shows "Not found".
    if (soft && err.status !== 404) return;
    const box = document.createElement('div');
    box.className = 'empty';
    const h2 = document.createElement('h2');
    h2.textContent = err.status === 404 ? 'Not found' : 'Something went wrong';
    const p = document.createElement('p');
    p.textContent = err.message;
    box.append(h2, p);
    target.replaceChildren(box);
  }
}

export function startRouter() {
  // The page the tab opened on gets its key too, so coming Back to it finds where it was.
  if (!history.state?.key) history.replaceState({ ...(history.state || {}), key: newKey() }, '');
  window.addEventListener('popstate', () => render({ popped: true }));
  // Intercept same-origin link clicks.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href.startsWith('/') || href.startsWith('/api/') || href.startsWith('//')) return;
    e.preventDefault();
    if (href !== location.pathname + location.search) navigate(href);
  });
  return render();
}
