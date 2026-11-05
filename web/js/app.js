import { h, icon, debounce, setChildren, libraryIcon } from './dom.js';
import { api, onUnauthorized } from './api.js';
import { route, setNotFound, setRenderTarget, startRouter, navigate, onNavigate, render } from './router.js';
import { state, isAdmin, getPrefs, setPrefs } from './state.js';
import { popupMenu, toastError } from './components.js';
import { startLive } from './live.js';
import { activityButton } from './activity-badge.js';
import { avatarContent } from './avatar.js';
import { scanProgress } from './scan-progress.js';
import { homeView } from './views/home.js';
import { libraryView } from './views/library.js';
import { itemView } from './views/item.js';
import { searchView } from './views/search.js';
import { personView } from './views/person.js';
import { playerView } from './views/player.js';
import { liveTvView, radioView } from './views/livetv.js';
import { livePlayerView } from './views/live-player.js';
import { requestsView } from './views/requests.js';
import { recordingsView, recordingShowView, recordingSeriesView } from './views/recordings.js';
import { loginView, setupView } from './views/auth.js';
import { settingsView } from './views/settings.js';

const app = document.getElementById('app');
let shell = null;
let accountButton = null;

// A new picture (Your account) shows in the top bar straight away.
window.addEventListener('reelhouse:user', () => {
  if (accountButton && state.me?.user) setChildren(accountButton, avatarContent(state.me.user));
});

// ---------- shell ----------

// The sidebar is full, or a strip of icons that slides out to full while pointed at: ☰ switches between them, and
// the choice is kept in this browser (until one is made, narrow windows start with icons). Phones and other narrow
// touch screens can't point, so there ☰ opens the sidebar over the page instead.
const drawerScreen = matchMedia('(max-width: 900px) and (hover: none)');
const narrowScreen = matchMedia('(max-width: 900px)');

function applySidebar(root, toggle) {
  const rail = !drawerScreen.matches && (getPrefs().sidebar || (narrowScreen.matches ? 'icons' : 'full')) === 'icons';
  root.classList.toggle('rail', rail);
  if (drawerScreen.matches) root.classList.remove('rail');
  const label = drawerScreen.matches ? 'Menu' : rail ? 'Show the full sidebar' : 'Shrink the sidebar to icons';
  toggle.setAttribute('aria-label', label);
  toggle.title = drawerScreen.matches ? '' : label;
}

function buildShell() {
  const nav = h('nav.sidebar', { 'aria-label': 'Main' });
  const search = h('input', {
    type: 'search',
    placeholder: 'Search movies, shows, people…',
    'aria-label': 'Search',
    autocomplete: 'off',
    onInput: debounce((e) => {
      const q = e.target.value.trim();
      if (q) navigate(`/search?q=${encodeURIComponent(q)}`, { replace: location.pathname === '/search' });
    }, 300),
    onKeydown: (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) navigate(`/search?q=${encodeURIComponent(e.target.value.trim())}`);
    },
  });
  const user = state.me.user;
  const avatar = h('button.avatar', {
    'aria-label': 'Account menu',
    onClick: (e) => popupMenu(e.currentTarget, [
      { label: user.username, heading: true },
      { label: 'Account', icon: 'user', onClick: () => navigate('/settings/account') },
      isAdmin() && { label: 'Settings', icon: 'settings', onClick: () => navigate('/settings') },
      '-',
      { label: 'Sign out', icon: 'signOut', onClick: signOut },
    ]),
  }, avatarContent(user));
  accountButton = avatar;
  // Admins: what's being watched now, a shortcut to Settings → Activity & logs.
  const activity = isAdmin() ? activityButton() : null;
  // In a form of its own: a password manager filling a password box on a page takes the text box before it, among those
  // outside any form, for the username, and a name typed in here runs a search.
  const searchBox = h('form.search-box', { role: 'search', onSubmit: (e) => e.preventDefault() }, icon('search', 18), search);
  // New files being added to a library show after it.
  const scan = scanProgress();
  const main = h('main.main');
  const toggle = h('button.btn.btn-ghost.btn-icon.menu-toggle', {
    'aria-label': 'Menu',
    onClick: () => {
      if (drawerScreen.matches) return root.classList.toggle('nav-open');
      setPrefs({ sidebar: root.classList.contains('rail') ? 'full' : 'icons' });
      applySidebar(root, toggle);
    },
  }, icon('menu'));
  const root = h('div.shell',
    nav,
    h('div.scrim', { onClick: () => root.classList.remove('nav-open') }),
    h('div.main-col',
      h('header.topbar',
        toggle,
        searchBox,
        scan.el,
        h('div.topbar-right', activity?.el, avatar),
      ),
      main,
    ),
  );
  applySidebar(root, toggle);
  for (const query of [drawerScreen, narrowScreen]) query.addEventListener('change', () => applySidebar(root, toggle));
  const playerLayer = h('div.player-layer');
  return { root, nav, main, search, playerLayer, activity, scan };
}

export function renderNav() {
  if (!shell) return;
  const path = location.pathname;
  const isActive = (href) => path === href || (href !== '/' && path.startsWith(`${href}/`));
  const link = (href, iconName, label, extra) => h(`a.nav-link${isActive(href) ? '.active' : ''}`, { href }, icon(iconName, 20), h('span', label), extra);
  setChildren(shell.nav,
    h('a.brand', { href: '/' }, h('img.brand-mark', { src: '/favicon.svg', alt: '' }), h('span.brand-name', 'Reelhouse')),
    link('/', 'home', 'Home'),
    state.libraries.length ? h('div.nav-section', 'Libraries') : null,
    state.libraries.map((l) => link(`/library/${l.id}`, libraryIcon(l), l.name, h('span.count', String(l.count || '')))),
    // Films people asked for (when TMDB is set up to find them, or some are still listed).
    state.me?.requests?.available || state.me?.requests?.count
      ? link('/requests', 'request', 'Requests', h('span.count', String(state.me.requests.count || '')))
      : null,
    h('div.sidebar-spacer'),
    state.me?.liveTv?.available ? link('/livetv', 'tv', 'Live TV') : null,
    state.me?.liveTv?.available && state.me.liveTv.radio !== false ? link('/radio', 'radio', 'Radio') : null,
    // The recordings you set from the guide (accounts allowed to record).
    state.me?.liveTv?.canRecord ? link('/recordings', 'record', 'Manage Recordings') : null,
    isAdmin() ? link('/settings', 'settings', 'Settings') : link('/settings/account', 'user', 'Account'),
  );
}

export async function refreshLibraries() {
  try {
    const { libraries } = await api.get('/api/libraries');
    state.libraries = libraries;
    renderNav();
  } catch (err) {
    console.error(err);
  }
}

/** What the server says about this account again (e.g. Live TV turned on or off), and the sidebar with it. */
export async function refreshMe() {
  try {
    state.me = await api.get('/api/me');
    renderNav();
  } catch (err) {
    console.error(err);
  }
}

async function signOut() {
  try {
    await api.post('/api/auth/logout');
  } finally {
    location.href = '/login';
  }
}

// ---------- routes ----------

route('/', homeView);
route('/library/:id', libraryView);
route('/item/:id', itemView);
route('/search', searchView, { keepSearch: true });
route('/person/:name', personView);
route('/play/:id', playerView, { fullscreen: true });
route('/livetv', liveTvView);
route('/livetv/watch/:channel', livePlayerView, { fullscreen: true });
route('/radio', radioView);
route('/radio/listen/:channel', livePlayerView, { fullscreen: true });
route('/requests', requestsView);
route('/recordings', recordingsView);
route('/recordings/:key', recordingShowView);
route('/recordings/:key/:season', recordingSeriesView);
route('/settings', settingsView);
route('/settings/:tab', settingsView);
route('/login', loginView, { bare: true });
route('/setup', setupView, { bare: true });
setNotFound(async () => h('div.page', h('div.empty', h('h2', 'Page not found'), h('a.btn', { href: '/' }, 'Go home'))));

setRenderTarget((opts) => {
  if (opts.bare || !shell) {
    shell = null;
    const holder = h('div');
    app.replaceChildren(holder);
    return holder;
  }
  if (!shell.root.isConnected) app.replaceChildren(shell.root, shell.playerLayer);
  if (opts.fullscreen) {
    // The player overlays the page underneath (which stays rendered for a smooth return).
    return shell.playerLayer;
  }
  shell.playerLayer.replaceChildren();
  return shell.main;
});

onNavigate((path, opts) => {
  if (!shell) return;
  shell.root.classList.remove('nav-open');
  if (!opts.keepSearch && !opts.fullscreen) shell.search.value = '';
  if (!opts.fullscreen) renderNav();
});

// The requests count in the sidebar follows other people's requests (see live.js).
window.addEventListener('reelhouse:requests', (e) => {
  if (!state.me?.requests) return;
  // { enabled, count, available } (or only { count } from a server before the switch)
  Object.assign(state.me.requests, e.detail);
  renderNav();
});

onUnauthorized(() => {
  if (!['/login', '/setup'].includes(location.pathname)) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
});

// ---------- boot ----------

export async function boot() {
  try {
    state.server = await api.get('/api/server');
  } catch (err) {
    app.replaceChildren(h('div.auth-page', h('div.auth-card', h('h2', 'Server unreachable'), h('p', err.message))));
    return;
  }
  document.title = state.server.name ? `Reelhouse · ${state.server.name}` : 'Reelhouse';

  if (state.server.setupRequired) {
    if (location.pathname !== '/setup') history.replaceState(null, '', '/setup');
    shell = null;
    return startRouter();
  }
  if (location.pathname === '/setup') history.replaceState(null, '', '/');

  try {
    state.me = await api.get('/api/me');
  } catch (err) {
    if (err.status === 401) {
      if (location.pathname !== '/login') {
        history.replaceState(null, '', `/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      }
      return startRouter();
    }
    toastError(err);
    return;
  }
  if (location.pathname === '/login') history.replaceState(null, '', '/');

  shell = buildShell();
  app.replaceChildren(shell.root, shell.playerLayer);
  await refreshLibraries();
  startLive(refreshLibraries, shell.activity, shell.scan, refreshMe);
  return startRouter();
}

// Re-render the shell after signing in without a full reload.
export async function afterSignIn(next = '/') {
  state.me = await api.get('/api/me');
  state.server = await api.get('/api/server');
  shell = buildShell();
  app.replaceChildren(shell.root, shell.playerLayer);
  await refreshLibraries();
  startLive(refreshLibraries, shell.activity, shell.scan, refreshMe);
  history.replaceState(null, '', next);
  return render();
}

boot();
