import { h, icon } from '../dom.js';
import { api } from '../api.js';
import { posterCard, emptyState, popupMenu, toast, toastError } from '../components.js';
import { navigate } from '../router.js';
import { isAdmin, getPrefs, setPrefs } from '../state.js';
import { liveRefresh } from '../live.js';

const SORTS = [
  { id: 'title', label: 'Title', order: 'asc' },
  { id: 'added', label: 'Date added', order: 'desc' },
  { id: 'year', label: 'Year', order: 'desc' },
  { id: 'released', label: 'Release date', order: 'desc' },
  { id: 'rating', label: 'Rating', order: 'desc' },
];
const FILTERS = [
  { id: '', label: 'All' },
  { id: 'unwatched', label: 'Unwatched' },
  { id: 'inprogress', label: 'In progress' },
  { id: 'watched', label: 'Watched' },
];

// The letter a title is under on the letter bar: "The Matrix" under M, "1917" under #.
const letterOf = (item) => {
  const ch = (item.title.replace(/^(the|a|an)\s+/i, '')[0] || '#').toUpperCase();
  return /[A-Z]/.test(ch) ? ch : '#';
};

// How many cards each library page had rendered, so a live refresh can render as many again and
// the scroll position still lands in the same place.
const renderedCounts = new Map();

export async function libraryView(ctx) {
  const id = ctx.params.id;
  liveRefresh(id);
  const saved = getPrefs()[`lib.${id}`] || {};
  const q = {
    sort: ctx.query.sort || saved.sort || 'title',
    order: ctx.query.order || saved.order || null,
    filter: ctx.query.filter ?? saved.filter ?? '',
    genre: ctx.query.genre || '',
  };
  if (!q.order) q.order = SORTS.find((s) => s.id === q.sort)?.order || 'asc';

  const params = new URLSearchParams({ sort: q.sort, order: q.order });
  if (q.filter) params.set('filter', q.filter);
  if (q.genre) params.set('genre', q.genre);
  const [{ library, items }, { genres }] = await Promise.all([
    api.get(`/api/libraries/${id}/items?${params}`, { signal: ctx.signal }),
    api.get(`/api/libraries/${id}/genres`, { signal: ctx.signal }),
  ]);

  const update = (patch) => {
    const next = { ...q, ...patch };
    if (patch.sort && !patch.order) next.order = SORTS.find((s) => s.id === patch.sort)?.order || 'asc';
    setPrefs({ [`lib.${id}`]: { sort: next.sort, order: next.order, filter: next.filter } });
    const p = new URLSearchParams({ sort: next.sort, order: next.order });
    if (next.filter) p.set('filter', next.filter);
    if (next.genre) p.set('genre', next.genre);
    navigate(`/library/${id}?${p}`, { replace: true });
  };

  const select = (options, value, onChange, label) => h('select.select', { 'aria-label': label, onChange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: o.id, selected: o.id === value }, o.label)));

  const toolbar = h('div.toolbar',
    h('h1', library.name),
    h('span.count', `${items.length} ${library.type === 'movie' ? (items.length === 1 ? 'movie' : 'movies') : items.length === 1 ? 'show' : 'shows'}`),
    h('div.spacer'),
    select(FILTERS, q.filter, (v) => update({ filter: v }), 'Filter'),
    genres.length ? select([{ id: '', label: 'All genres' }, ...genres.map((g) => ({ id: g.genre, label: g.genre }))], q.genre, (v) => update({ genre: v }), 'Genre') : null,
    select(SORTS, q.sort, (v) => update({ sort: v }), 'Sort by'),
    h('button.btn.btn-icon', {
      'aria-label': q.order === 'asc' ? 'Ascending' : 'Descending',
      title: q.order === 'asc' ? 'Ascending' : 'Descending',
      onClick: () => update({ order: q.order === 'asc' ? 'desc' : 'asc' }),
    }, h('span', { style: { display: 'inline-flex', transform: q.order === 'asc' ? 'rotate(180deg)' : '' } }, icon('chevronDown', 18))),
    isAdmin() && h('button.btn.btn-icon', {
      'aria-label': 'Library actions',
      onClick: (e) => popupMenu(e.currentTarget, [
        { label: 'Scan library files', icon: 'refresh', onClick: () => scan(id, false) },
        { label: 'Rescan all files (slower)', icon: 'refresh', onClick: () => scan(id, true) },
        { label: 'Refresh all metadata', icon: 'globe', onClick: () => refreshMeta(id) },
        '-',
        { label: 'Edit library', icon: 'edit', onClick: () => navigate('/settings/libraries') },
      ]),
    }, icon('more', 18)),
  );

  const page = h('div.page', toolbar);
  if (!items.length) {
    page.append(emptyState(
      q.filter || q.genre ? 'Nothing matches' : 'This library is empty',
      q.filter || q.genre ? 'Try a different filter.' : 'Reelhouse scans the library folders automatically. New files show up within a minute.',
      (q.filter || q.genre) && h('button.btn', { onClick: () => update({ filter: '', genre: '' }) }, 'Clear filters'),
    ));
    return page;
  }

  const grid = h('div.grid');
  // Render in chunks so huge libraries don't block the first paint.
  const CHUNK = 120;
  let rendered = 0;
  const letters = new Map();
  const renderMore = () => {
    const slice = items.slice(rendered, rendered + CHUNK);
    for (const it of slice) {
      const card = posterCard(it);
      if (q.sort === 'title') {
        const letter = letterOf(it);
        if (!letters.has(letter)) {
          letters.set(letter, card);
          card.dataset.letter = letter;
        }
      }
      grid.append(card);
    }
    rendered += slice.length;
    renderedCounts.set(id, rendered);
  };
  const keep = ctx.refresh ? renderedCounts.get(id) || 0 : 0;
  do renderMore(); while (rendered < Math.min(keep, items.length));
  page.append(grid);

  if (rendered < items.length) {
    const sentinel = h('div', { style: { height: '1px' } });
    page.append(sentinel);
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        renderMore();
        if (rendered >= items.length) {
          io.disconnect();
          sentinel.remove();
        }
      }
    }, { rootMargin: '1200px' });
    io.observe(sentinel);
    ctx.onCleanup(() => io.disconnect());
  }

  if (q.sort === 'title') {
    const hasTitles = new Set(items.map(letterOf));
    const bar = h('div.letter-bar', { hidden: true }, ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((L) => h('button', {
      disabled: !hasTitles.has(L),
      onClick: () => {
        while (!letters.has(L) && rendered < items.length) renderMore();
        letters.get(L)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
    }, L)));
    page.append(bar);
    // Only while the page can scroll (there's nowhere to jump to otherwise), beside its scrollbar, however wide that is:
    // looked at again whenever the page changes size (the window, the list, the scrollbar appearing).
    const scroller = document.querySelector('main.main');
    const measure = new ResizeObserver(() => {
      bar.hidden = scroller.scrollHeight <= scroller.clientHeight;
      bar.style.setProperty('--scrollbar-w', `${scroller.offsetWidth - scroller.clientWidth}px`);
    });
    measure.observe(scroller);
    measure.observe(page);
    ctx.onCleanup(() => measure.disconnect());
  }
  return page;
}

async function scan(id, force) {
  try {
    await api.post(`/api/libraries/${id}/scan`, { force });
    toast('Scan started');
  } catch (err) {
    toastError(err);
  }
}

async function refreshMeta(id) {
  try {
    await api.post(`/api/libraries/${id}/refresh-metadata`);
    toast('Refreshing metadata in the background');
  } catch (err) {
    toastError(err);
  }
}
