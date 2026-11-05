import { h, icon, formatDate } from '../dom.js';
import { api } from '../api.js';
import { posterCard, lazyImg } from '../components.js';
import { liveRefresh } from '../live.js';
import { isAdmin } from '../state.js';

/** A cast member's page; `itemId` is the movie or show they were picked from (it tells same-named people apart). */
export const personUrl = (name, itemId) => `/person/${encodeURIComponent(name)}${itemId ? `?item=${itemId}` : ''}`;

const initials = (name) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('');

/** "2 movies on this server", "1 movie and 1 show on this server", "No movies on this server". */
export function hereLine(items) {
  const movies = items.filter((i) => i.type === 'movie').length;
  const shows = items.length - movies;
  const parts = [movies && `${movies} movie${movies === 1 ? '' : 's'}`, shows && `${shows} show${shows === 1 ? '' : 's'}`].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} on this server` : 'No movies on this server';
}

const part = (it) => (it.role ? `as ${it.role}` : it.directed ? 'Director' : null);

export async function personView(ctx) {
  const query = new URLSearchParams({ name: ctx.params.name });
  if (ctx.query.item) query.set('item', ctx.query.item);
  const p = await api.get(`/api/people?${query}`, { signal: ctx.signal });
  liveRefresh('all');
  document.title = `${p.name} · Reelhouse`;
  ctx.onCleanup(() => {
    document.title = 'Reelhouse';
  });

  const others = p.others.items;
  const counts = [hereLine(p.items), others.length && `${others.length} more movie${others.length === 1 ? '' : 's'}`];
  return h('div.page.person-page',
    h('div.person-head',
      h('div.person-photo', lazyImg(p.profile, { width: 180, alt: '', fallback: () => h('span', initials(p.name)) }) || initials(p.name)),
      h('div.person-info',
        h('h1', p.name),
        h('div.person-counts', counts.filter(Boolean).join(' · ')),
        facts(p.info),
      ),
      p.info?.biography && h('div.person-bio', biography(p.info.biography)),
    ),
    h('section.hub',
      h('div.hub-head', h('h2', 'On this server')),
      p.items.length
        ? h('div.grid', p.items.map((it) => posterCard(it, { subtitle: [it.year, part(it)].filter(Boolean).join(' · ') })))
        : h('p.hint', `Nothing with ${p.name} is on this server.`)),
    othersSection(p),
  );
}

/** "Born 30 May 1971 (age 55)", "in Queens, New York, USA", "Died …" — whatever TMDB knows. */
function facts(info) {
  if (!info) return null;
  const lines = [];
  if (info.birthday) lines.push(`Born ${formatDate(info.birthday)}${info.age != null && !info.deathday ? ` (age ${info.age})` : ''}`);
  if (info.birthplace) lines.push(info.birthday ? `in ${info.birthplace}` : `Born in ${info.birthplace}`);
  if (info.deathday) lines.push(`Died ${formatDate(info.deathday)}${info.age != null ? ` (aged ${info.age})` : ''}`);
  return lines.length ? h('div.person-facts', lines.map((l) => h('div', l))) : null;
}

/** The biography, cut to a few lines when it's long (a click shows the rest). */
function biography(text) {
  const el = h('p.overview', text);
  if (text.length > 420) {
    el.classList.add('clamp');
    el.title = 'Show more';
    el.addEventListener('click', () => el.classList.toggle('clamp'));
  }
  return el;
}

// Movies they've been in that aren't on the server (TMDB's list): for reading, there's nothing to open.
function othersSection(p) {
  const { status, items } = p.others;
  let body;
  if (status === 'ok' && items.length) {
    body = h('ul.film-list', items.map((f) => h('li.film-row',
      h('div.film-poster', lazyImg(f.poster, { width: 46, alt: '', fallback: () => icon('film', 18) }) || icon('film', 18)),
      h('div.film-text',
        h('div.film-title', { title: f.title }, f.title),
        h('div.film-sub', [f.year, f.role && `as ${f.role}`].filter(Boolean).join(' · ')),
      ),
    )));
  } else if (status === 'ok') {
    body = h('p.hint', `Every movie TMDB lists for ${p.name} is on this server.`);
  } else if (status === 'failed') {
    body = h('p.hint', 'Their other movies couldn’t be loaded from TMDB just now.');
  } else if (status === 'unknown') {
    body = h('p.hint', `TMDB has no movies listed for ${p.name}.`);
  } else if (isAdmin()) {
    body = h('p.hint', 'Add a TMDB API key in Settings → Metadata to also list the movies they’ve been in that aren’t on this server.');
  } else {
    return null;
  }
  return h('section.hub', h('div.hub-head', h('h2', 'Not on this server'), items.length ? h('span.count', String(items.length)) : null), body);
}
