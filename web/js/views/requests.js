// Requests: films people would like on the server (server/requests.js). A search box finds films on TMDB to ask for
// (one already on the server opens instead; one someone asked for says who); under it every request, newest first,
// with its poster, who asked and when. You can remove your own; an admin any, or all of them. The list follows other
// people's changes live (the "requests" event, see live.js), and a request goes by itself once its film is in. It's
// off until a TMDB API key is set up, and an admin can turn it off (Settings → General): the page then says which.
import { h, icon, debounce, setChildren } from '../dom.js';
import { api } from '../api.js';
import { lazyImg, emptyState, confirmDialog, toast, toastError } from '../components.js';
import { avatarContent } from '../avatar.js';
import { isAdmin, state } from '../state.js';
import { refresh } from '../router.js';

const SEARCH_DELAY_MS = 400;

const dateOf = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const filmPlaceholder = (title) => h('div.card-placeholder', icon('film', 28), h('div', title));
const poster = (film) => h('div.card-img', lazyImg(film.poster, { width: 160, fallback: () => filmPlaceholder(film.title) }) || filmPlaceholder(film.title));

// Turned off (or on) while the page is open: it's drawn again, as it is now.
function followSwitch(ctx, enabled) {
  const onChange = (e) => {
    if ('enabled' in e.detail && e.detail.enabled !== enabled) void refresh();
  };
  window.addEventListener('reelhouse:requests', onChange);
  ctx.onCleanup(() => window.removeEventListener('reelhouse:requests', onChange));
}

function turnedOff(ctx, needsKey) {
  followSwitch(ctx, false);
  return h('div.page.requests-page',
    h('h1.page-title', 'Requests'),
    needsKey
      ? emptyState('Requests isn’t set up yet', isAdmin()
        ? h('span', 'It needs a free TMDB API key to find movies: add one in ', h('a', { href: '/settings/metadata' }, 'Settings → Metadata'),
          ', and Requests turns on.')
        : 'It needs a TMDB API key, which an admin adds in Settings.')
      : emptyState('Requests are turned off', isAdmin()
        ? h('span', 'Turn them on in ', h('a', { href: '/settings/general' }, 'Settings → General'), '.')
        : 'An admin has turned off asking for movies on this server.'));
}

export async function requestsView(ctx) {
  const page = h('div.page.requests-page');
  let data;
  try {
    data = await api.get('/api/requests', { signal: ctx.signal });
  } catch (err) {
    if (err.data?.off) return turnedOff(ctx, !!err.data.needsKey);
    throw err;
  }
  followSwitch(ctx, true);
  let query = '';
  let results = null; // the last search's films, or null when there's no search
  let searchSeq = 0;

  const listEl = h('section.hub');
  const resultsEl = h('section.hub.request-results');
  const removeAll = isAdmin() && h('button.btn.btn-danger.btn-sm', { onClick: () => void clearAll() }, icon('trash', 16), 'Remove all');
  const input = h('input.input', {
    type: 'search', placeholder: 'Find a movie to request…', 'aria-label': 'Find a movie to request', autocomplete: 'off',
    onInput: debounce(() => void runSearch(input.value), SEARCH_DELAY_MS),
    onKeydown: (e) => {
      if (e.key === 'Enter') void runSearch(input.value);
      if (e.key === 'Escape' && input.value) {
        input.value = '';
        void runSearch('');
      }
    },
  });

  async function reload() {
    try {
      data = await api.get('/api/requests', { signal: ctx.signal });
      renderList();
      if (results) await runSearch(query, { quiet: true }); // its "Asked for by …" marks follow too
    } catch (err) {
      // Turned off meanwhile: followSwitch draws the page again.
      if (err.name !== 'AbortError' && !err.data?.off) console.error(err);
    }
  }

  async function runSearch(text, { quiet = false } = {}) {
    query = text.trim();
    const seq = ++searchSeq;
    if (!query) {
      results = null;
      renderResults();
      return;
    }
    if (!quiet) setChildren(resultsEl, h('div.hub-head', h('h2', `Searching for “${query}”…`)));
    try {
      const r = await api.get(`/api/requests/search?q=${encodeURIComponent(query)}`, { signal: ctx.signal });
      if (seq !== searchSeq) return;
      results = r.results;
      renderResults();
    } catch (err) {
      if (err.name === 'AbortError' || seq !== searchSeq) return;
      results = [];
      setChildren(resultsEl, h('div.hub-head', h('h2', `Results for “${query}”`)), h('p.hint', err.message));
    }
  }

  async function ask(film, button) {
    button.disabled = true;
    try {
      await api.post('/api/requests', { tmdbId: film.tmdbId });
      toast(`Requested “${film.title}”`);
      await reload();
    } catch (err) {
      button.disabled = false;
      toastError(err);
      if (err.data?.limit) await reload(); // asked from elsewhere meanwhile: the note and buttons catch up
    }
  }

  async function remove(req) {
    const mine = req.user.id === state.me?.user?.id;
    if (!mine && !(await confirmDialog({
      title: 'Remove this request?',
      message: `${req.user.username} asked for “${req.title}”.`,
      confirmLabel: 'Remove', danger: true,
    }))) return;
    try {
      await api.del(`/api/requests/${req.id}`);
      toast(`Removed the request for “${req.title}”`);
      await reload();
    } catch (err) {
      toastError(err);
    }
  }

  async function clearAll() {
    const n = data.requests.length;
    if (!n || !(await confirmDialog({
      title: 'Remove all requests?',
      message: n === 1 ? `The request for “${data.requests[0].title}” will be removed.` : `All ${n} requests, everyone’s, will be removed.`,
      confirmLabel: 'Remove all', danger: true,
    }))) return;
    try {
      await api.del('/api/requests');
      toast('Removed all requests');
      await reload();
    } catch (err) {
      toastError(err);
    }
  }

  // { max, open } when an admin limits how many requests each person has waiting (none for admins).
  const atLimit = () => !!data.limit && data.limit.open >= data.limit.max;

  function resultCard(film) {
    let action;
    if (film.onServer) action = h('a.btn.btn-sm', { href: `/item/${film.onServer}` }, icon('play', 14), 'On the server');
    else if (film.request) action = h('div.request-state', film.request.mine ? 'You asked for it' : `Asked for by ${film.request.username}`);
    else {
      action = h('button.btn.btn-primary.btn-sm', {
        onClick: () => void ask(film, action),
        disabled: atLimit(),
        title: atLimit() ? 'You have as many requests waiting as you can' : null,
      }, icon('plus', 14), 'Request');
    }
    return h('div.card.request-card', { title: film.overview || film.title },
      poster(film),
      h('div.card-title', film.title),
      h('div.card-sub', film.year || ''),
      h('div.request-action', action),
    );
  }

  function requestCard(req) {
    return h('div.card.request-card', { title: req.overview || req.title },
      h('div.card-img-wrap',
        poster(req),
        req.canRemove && h('button.request-remove', {
          'aria-label': `Remove the request for ${req.title}`, title: 'Remove request',
          onClick: () => void remove(req),
        }, icon('x', 16)),
      ),
      h('div.card-title', req.title),
      h('div.card-sub', req.year || ''),
      // Who asked, then the day (on its own line, so a long name can't push it out of sight).
      h('div.request-by', h('span.avatar.avatar-xs', avatarContent(req.user)), h('span', req.user.username)),
      h('div.card-sub', { title: new Date(req.requestedAt).toLocaleString() }, dateOf(req.requestedAt)),
    );
  }

  function renderResults() {
    if (!results) return setChildren(resultsEl);
    setChildren(resultsEl,
      h('div.hub-head', h('h2', `Results for “${query}”`)),
      results.length
        ? h('div.grid', results.map(resultCard))
        : h('p.hint', 'TMDB has no film by that name. Try another spelling, or add the year (e.g. “Heat 1995”).'));
  }

  // How many requests this person may have waiting, and how many they have (when an admin set a limit).
  const limitNote = h('p.hint.request-limit');
  function renderLimit() {
    const l = data.limit;
    limitNote.hidden = !l;
    if (!l) return;
    limitNote.textContent = `You can have ${l.max} request${l.max === 1 ? '' : 's'} waiting at a time; you have ${l.open}.`
      + (atLimit() ? ' To ask for another, remove one of yours, or wait for one of those films to arrive.' : '');
  }

  function renderList() {
    renderLimit();
    if (removeAll) removeAll.hidden = !data.requests.length;
    setChildren(listEl,
      h('div.hub-head', h('h2', `Requested${data.requests.length ? ` (${data.requests.length})` : ''}`), removeAll && h('div.hub-nav', removeAll)),
      data.requests.length
        ? h('div.grid', data.requests.map(requestCard))
        : emptyState('Nothing requested yet', 'Search for a movie above to ask for it.'));
  }

  // Other people's requests, and films arriving, while this page is open.
  const onChange = () => void reload();
  window.addEventListener('reelhouse:requests', onChange);
  ctx.onCleanup(() => window.removeEventListener('reelhouse:requests', onChange));

  page.append(h('h1.page-title', 'Requests'),
    h('p.page-intro', 'Ask for a movie that isn’t on the server. When it turns up in a library you can open, its request goes by itself.'),
    limitNote, h('div.request-search', icon('search', 18), input), resultsEl);
  page.append(listEl);
  renderList();
  return page;
}
