import { h } from '../dom.js';
import { api } from '../api.js';
import { posterCard, landscapeCard, emptyState } from '../components.js';
import { liveRefresh } from '../live.js';

export async function searchView(ctx) {
  const q = (ctx.query.q || '').trim();
  const page = h('div.page');
  if (!q) {
    page.append(emptyState('Search', 'Type in the search box to find movies, shows, episodes and people.'));
    return page;
  }
  liveRefresh('all');
  const r = await api.get(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctx.signal });
  page.append(h('h1.page-title', `Results for “${q}”`));
  const section = (title, items, card = posterCard) => items.length
    ? h('section.hub', h('div.hub-head', h('h2', title)), h('div.grid', { style: card === landscapeCard ? '--card-w: 250px' : null }, items.map((i) => card(i))))
    : null;
  const sections = [
    section('Movies', r.movies),
    section('TV Shows', r.shows),
    section('Episodes', r.episodes, landscapeCard),
    section('Cast & Crew', r.people),
  ].filter(Boolean);
  if (!sections.length) page.append(emptyState('No results', `Nothing in your libraries matches “${q}”.`));
  else page.append(...sections);
  return page;
}
