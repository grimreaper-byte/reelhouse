// History-API router. Views are async functions (ctx) => Node; ctx.signal aborts when the user
// navigates away and ctx.onCleanup registers teardown work.

const routes = [];
let current = null;
let renderTarget = null;
let notFound = null;
const navListeners = new Set();

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
  if (replace) history.replaceState(state ?? null, '', url);
  else history.pushState({ ...(state || {}), internal: true }, '', url);
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

export async function render({ soft = false } = {}) {
  const path = location.pathname;
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
    cleanups: [],
    onCleanup(fn) {
      this.cleanups.push(fn);
    },
  };
  current = { controller, cleanups: ctx.cleanups };
  const opts = match?.route.opts || {};
  const target = renderTarget(opts);
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
    if (saved) restoreScroll(target, saved);
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
  window.addEventListener('popstate', () => render());
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
