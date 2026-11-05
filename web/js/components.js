import { h, icon, imgUrl, episodeLabel, clear } from './dom.js';
import { navigate } from './router.js';

// ---------- images ----------

/** <img> that fades in when loaded and swaps to a placeholder when it fails. */
export function lazyImg(src, { width = 200, alt = '', fallback } = {}) {
  if (!src) return fallback ? fallback() : null;
  const img = h('img', { src: imgUrl(src, width), alt, loading: 'lazy', decoding: 'async', draggable: 'false' });
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => {
    const fb = fallback?.();
    if (fb) img.replaceWith(fb);
    else img.remove();
  });
  return img;
}

function placeholder(item) {
  return h('div.card-placeholder', icon(item.type === 'movie' ? 'film' : 'tv', 28), h('div', item.title));
}

function badges(item) {
  const out = [];
  if (item.type === 'show' || item.type === 'season') {
    const unwatched = (item.leafCount || 0) - (item.viewedLeafCount || 0);
    if (unwatched > 0) out.push(h('div.badge', String(unwatched)));
    else if (item.leafCount) out.push(watchedFlag());
  } else if (item.state?.watched && !item.state.position) {
    out.push(watchedFlag());
  }
  if (item.state?.position && item.duration) {
    const pct = Math.min(100, (item.state.position / item.duration) * 100);
    out.push(h('div.progress', h('div', { style: { width: `${pct}%` } })));
  }
  return out;
}

function watchedFlag() {
  return h('div.watched-flag', icon('check', 14));
}

/** Player URL that resumes from the saved position. */
export function playUrl(item) {
  return `/play/${item.id}${item.state?.position ? `?t=${Math.floor(item.state.position)}` : ''}`;
}

/**
 * A portrait poster card for grids and rows; an episode's poster is its season's or show's, under the show's name.
 * The card opens the item's page; its play button plays (or resumes) it.
 */
export function posterCard(item, { title, subtitle, width = 160 } = {}) {
  const imgSrc = item.images.poster || (item.type === 'movie' ? item.images.thumb : null);
  const playable = item.type === 'movie' || item.type === 'episode';
  const card = h('a.card', { href: `/item/${item.id}`, title: item.title },
    h('div.card-img',
      lazyImg(imgSrc, { width, alt: '', fallback: () => placeholder(item) }) || placeholder(item),
      playable && h('div.card-overlay', h('button.play-circle', {
        'aria-label': `Play ${item.title}`,
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          navigate(playUrl(item));
        },
      }, icon('play', 24))),
      badges(item),
    ),
    h('div.card-title', title ?? (item.type === 'episode' && item.show ? item.show.title : item.title)),
    h('div.card-sub', subtitle ?? defaultSubtitle(item)),
  );
  return card;
}

function defaultSubtitle(item) {
  if (item.type === 'episode') return item.show ? `${episodeLabel(item)} · ${item.title}` : episodeLabel(item);
  if (item.type === 'season') return `${item.leafCount || 0} episodes`;
  if (item.type === 'show') return item.childCount > 1 ? `${item.childCount} seasons` : item.year || (item.childCount ? '1 season' : '');
  return item.year || '';
}

/** Landscape card (episodes in search results; a row the server marks "landscape"): click resumes playback. */
export function landscapeCard(item) {
  const isEp = item.type === 'episode';
  const src = isEp ? item.images.thumb : item.images.backdrop || item.images.thumb;
  return h('a.card.landscape', { href: playUrl(item), title: item.title },
    h('div.card-img',
      lazyImg(src, { width: 300, fallback: () => placeholder(item) }) || placeholder(item),
      h('div.card-overlay', h('div.play-circle', icon('play', 24))),
      badges(item),
    ),
    h('div.card-title', isEp && item.show ? item.show.title : item.title),
    h('div.card-sub', isEp ? `${episodeLabel(item)} · ${item.title}` : item.year || ''),
  );
}

/** Seasons in "recently added" hubs are labelled with their show. */
export function hubCard(item, style) {
  if (style === 'landscape') return landscapeCard(item);
  if (item.type === 'season' && item.show) {
    return posterCard(item, { title: item.show.title, subtitle: `${item.title}${item.newCount ? ` · ${item.newCount} new` : ''}` });
  }
  return posterCard(item);
}

/**
 * Left and right buttons for a horizontally scrolling row, to place as the page likes. They hide when everything
 * fits (and on touch screens, which swipe instead) and disable at either end; the row also gets
 * "more-left"/"more-right" classes for edge fades.
 */
export function scrollArrows(scroller) {
  const step = (dir) => scroller.scrollBy({ left: dir * scroller.clientWidth * 0.85, behavior: 'smooth' });
  const prev = h('button.btn.btn-ghost.btn-icon.btn-sm.scroll-arrow', { type: 'button', 'aria-label': 'Scroll left', onClick: () => step(-1) }, icon('chevronLeft', 18));
  const next = h('button.btn.btn-ghost.btn-icon.btn-sm.scroll-arrow', { type: 'button', 'aria-label': 'Scroll right', onClick: () => step(1) }, icon('chevronRight', 18));
  const update = () => {
    const max = scroller.scrollWidth - scroller.clientWidth;
    const left = scroller.scrollLeft;
    prev.hidden = next.hidden = max <= 1;
    prev.disabled = left <= 1;
    next.disabled = left >= max - 1;
    scroller.classList.toggle('more-left', left > 1);
    scroller.classList.toggle('more-right', left < max - 1);
  };
  scroller.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scroller); // also runs once the row is on screen, and as the window resizes
  return { prev, next };
}

/** scrollArrows() side by side, at the end of a row's heading. */
export function scrollButtons(scroller) {
  const { prev, next } = scrollArrows(scroller);
  return h('div.hub-nav', prev, next);
}

/**
 * A titled, horizontally scrolling row of cards.
 * subtitle(item) overrides the line under each poster; lead is shown before the title (e.g. an avatar).
 */
export function hubRow({ title, href, items, style = 'poster', subtitle, lead }) {
  const scroller = h('div.hub-scroller', { 'data-scroll-key': title }, items.map((it) => (subtitle && style !== 'landscape'
    ? posterCard(it, { subtitle: subtitle(it) })
    : hubCard(it, style))));
  return h('section.hub',
    h('div.hub-head', lead, h('h2', title), href && h('a.more', { href }, 'See all'), scrollButtons(scroller)),
    scroller,
  );
}

// ---------- password boxes ----------

/**
 * Puts an eye button at the end of a password box, which shows what's been typed (and hides it again).
 * Wraps the input where it is, or returns the wrapper to place. `conceal()` hides the text again, e.g. after saving.
 */
export function withReveal(input) {
  const button = h('button.pw-reveal', { type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false', title: 'Show password' });
  const set = (shown) => {
    input.type = shown ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(shown));
    button.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
    button.title = shown ? 'Hide password' : 'Show password';
    button.replaceChildren(icon(shown ? 'eyeOff' : 'eye', 18));
  };
  // Keep the cursor in the box: the click shouldn't take focus from it.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', () => set(input.type === 'password'));
  set(false);
  const wrap = h('div.pw-field');
  if (input.parentNode) input.replaceWith(wrap);
  wrap.append(input, button);
  return { el: wrap, conceal: () => set(false) };
}

// ---------- toasts ----------

let toastHost = null;
export function toast(message, { error = false, ms = 3500 } = {}) {
  if (!toastHost) {
    toastHost = h('div.toasts');
    document.body.append(toastHost);
  }
  const t = h(`div.toast${error ? '.error' : ''}`, message);
  toastHost.append(t);
  setTimeout(() => t.remove(), ms);
}

export const toastError = (err) => toast(err?.message || String(err), { error: true, ms: 6000 });

// ---------- modal ----------

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const foot = actions.length
    ? h('div.modal-foot', actions.map((a) => h(`button.btn${a.primary ? '.btn-primary' : ''}${a.danger ? '.btn-danger' : ''}`, {
      type: 'button',
      onClick: async (e) => {
        if (!a.onClick) return close();
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const keepOpen = await a.onClick(close);
          if (keepOpen !== true) close();
        } catch (err) {
          toastError(err);
        } finally {
          btn.disabled = false;
        }
      },
    }, a.label)))
    : null;
  const backdrop = h('div.modal-backdrop', {
    onMousedown: (e) => {
      if (e.target === backdrop) close();
    },
  },
  h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2', title), h('button.btn.btn-ghost.btn-icon.btn-sm', { 'aria-label': 'Close', onClick: close }, icon('x', 18))),
    h('div.modal-body', body),
    foot,
  ));
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  setTimeout(() => backdrop.querySelector('input, select, textarea, button.btn-primary')?.focus(), 30);
  return { close, el: backdrop };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: h('p', { style: { margin: 0, color: 'var(--text-dim)' } }, message),
      actions: [
        { label: cancelLabel },
        { label: confirmLabel, primary: !danger, danger, onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => {
        if (!done) resolve(false);
      },
    });
  });
}

// ---------- popup menu ----------

let openMenu = null;
export function popupMenu(anchor, entries) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu' }, entries.filter(Boolean).map((e) => {
    if (e === '-') return h('div.sep');
    if (e.label && e.heading) return h('div.menu-label', e.label);
    return h('button', {
      role: 'menuitem',
      type: 'button',
      onClick: () => {
        closeMenu();
        e.onClick?.();
      },
    }, e.icon && icon(e.icon, 18), e.label);
  }));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;
  const onDoc = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) closeMenu();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') closeMenu();
  };
  setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
  document.addEventListener('keydown', onKey);
  openMenu = { menu, cleanup: () => {
    document.removeEventListener('mousedown', onDoc);
    document.removeEventListener('keydown', onKey);
  } };
}

export function closeMenu() {
  if (!openMenu) return;
  openMenu.cleanup();
  openMenu.menu.remove();
  openMenu = null;
}

// ---------- misc ----------

export function emptyState(title, message, action) {
  return h('div.empty', h('h2', title), h('p', message), action);
}

export function statusPill(ok, text) {
  return h(`span.status${ok === true ? '.ok' : ok === false ? '.bad' : ok === 'warn' ? '.warn' : ''}`, text);
}

export function spinnerEl(small) {
  return h(`div.spinner${small ? '.small' : ''}`);
}

/** Renders async content into a container, showing a spinner meanwhile. */
export async function fill(container, loader) {
  clear(container).append(h('div', { style: { padding: '20px', display: 'grid', placeItems: 'center' } }, spinnerEl()));
  try {
    const node = await loader();
    clear(container).append(node);
  } catch (err) {
    clear(container).append(h('div.form-error', err.message));
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed — select the text and copy it manually', { error: true });
  }
}
