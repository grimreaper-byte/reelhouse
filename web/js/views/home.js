import { h, timeAgo } from '../dom.js';
import { api } from '../api.js';
import { hubRow, emptyState } from '../components.js';
import { isAdmin } from '../state.js';
import { liveRefresh } from '../live.js';

export async function homeView(ctx) {
  liveRefresh('all');
  const { hubs, libraries } = await api.get('/api/hubs/home?channels=1', { signal: ctx.signal });
  const page = h('div.page');
  if (!libraries.length) {
    page.append(emptyState(
      'No libraries yet',
      isAdmin()
        ? 'Add a folder with your movies or TV shows and Reelhouse will organize it for you.'
        : 'Ask the server owner to add a library or give you access to one.',
      isAdmin() && h('a.btn.btn-primary', { href: '/settings/libraries?welcome=1' }, 'Add a library'),
    ));
    return page;
  }
  if (!hubs.length) {
    const scan = await api.get('/api/scan/status', { signal: ctx.signal }).catch(() => null);
    page.append(emptyState(
      scan?.running ? 'Scanning your media…' : 'Nothing here yet',
      scan?.running
        ? `Reading ${scan.libraryName}${scan.total ? ` (${scan.done} of ${scan.total})` : ''}. This page will fill up as files are found.`
        : 'Your libraries are empty. Check that the folders contain video files.',
    ));
    if (scan?.running) {
      const t = setTimeout(() => {
        if (!ctx.signal.aborted && location.pathname === '/') import('../router.js').then((r) => r.render());
      }, 4000);
      ctx.onCleanup(() => clearTimeout(t));
    }
    return page;
  }
  for (const hub of hubs) {
    page.append(hubRow({
      title: hub.title,
      href: hub.libraryId ? `/library/${hub.libraryId}?sort=added&order=desc` : null,
      items: hub.items,
      style: hub.style,
      subtitle: hub.id === 'others' ? watchedByLine : undefined,
    }));
  }
  return page;
}

/** "sam · 2 days ago", "sam and jo · …", "sam and 2 others · …" under a "Watched by Others" card. */
export function watchedByLine(item) {
  const people = item.watchedBy || [];
  const who = people.length > 2 ? `${people[0]} and ${people.length - 1} others` : people.join(' and ');
  return [who, item.watchedAt && timeAgo(item.watchedAt)].filter(Boolean).join(' · ');
}
