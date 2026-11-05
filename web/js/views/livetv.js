// Live TV's guide (Tvheadend's EPG): on wide screens a grid of channels against time with a line at "now", loading
// more hours as it's scrolled, and under it the highlighted programme (pointed at or focused; at first what's on now
// on the first channel), as Kodi's guide shows it, moved with the arrow keys as on a remote; on phones a list of
// what's on now and next. A programme opens its details, with Watch and, for accounts allowed to, Record / Cancel
// recording / Stop recording (their own recordings; an admin's, anyone's: see /recordings), and, for accounts allowed
// that too, Record series / Cancel series recording: every episode of the show on that channel, from Tvheadend's autorecs
// (one of its episodes offers Skip this episode instead of Cancel recording, and Record again once skipped). Radio stations have their own page (/radio), the same guide with Listen instead of Watch.
import { h, icon, setChildren, formatBytes } from '../dom.js';
import { api } from '../api.js';
import { confirmDialog, modal, toast, toastError } from '../components.js';
import { navigate } from '../router.js';
import { HALF_HOUR, CHUNK, todayFrom, followNow } from '../guide-window.js';

const PX_PER_MIN = 5; // 30 minutes = 150 px
const MAX_SPAN = 24 * 3600; // from a day's start
const REFRESH_MS = 60 * 1000;

export const timeOf = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function dayLabel(t) {
  const d = new Date(t * 1000);
  const today = new Date();
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

const startOfDay = (offset) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return Math.floor(d.getTime() / 1000);
};

/** Tvheadend's recordings drive: free space, size, how full (a warning under 10% free) and what recordings take up. */
export function recordingsDrive({ free, total, recordings }) {
  const low = free / total < 0.1;
  return [
    h('div', `${formatBytes(free) || '0 B'} free of ${formatBytes(total)}`, low && h('span.status.warn', { style: { marginLeft: '8px' } }, 'Low on space')),
    h(`div.bar.disk-bar${low ? '.low' : ''}`, h('div', { style: { width: `${Math.min(100, Math.max(0, ((total - free) / total) * 100))}%` } })),
    recordings != null && h('div.hint', recordings ? `Recordings take up ${formatBytes(recordings)}` : 'No recordings yet'),
  ];
}

/** A channel's logo, or its first letters when it has none (or Tvheadend can't give it). */
export function channelLogo(c, cls = '') {
  const fallback = () => h(`span.logo-fallback${cls}`, c.name.slice(0, 2));
  if (!c.icon) return fallback();
  const img = h(`img${cls}`, { src: c.icon, alt: '', loading: 'lazy', onError: () => img.replaceWith(fallback()) });
  return img;
}

// A programme's genre group, coloured in the guide as Kodi does: the first hex digit of its ETSI EN 300 468 content
// type (1 film / drama, 2 news, 3 show / game show, 4 sport, 5 children's, 6 music, 7 arts, 8 social / political,
// 9 education / science, 10 leisure / hobbies, 11 special characteristics), or null.
const genreGroup = (e) => (e.genre || []).map((code) => code >> 4).find((g) => g >= 1 && g <= 11) || null;

const recordingLabel = (rec) => (rec.state === 'recording' ? 'Recording now'
  : rec.state === 'scheduled' ? (rec.series ? 'Series recording' : 'Will be recorded')
    : rec.state === 'skipped' ? 'Skipped' : rec.state === 'failed' ? 'Recording failed' : 'Recorded');
// A programme marked in the guide as recording: not one of a series recording's episodes that's been skipped, or one that failed.
const recordingMark = (rec) => rec && rec.state !== 'skipped' && rec.state !== 'failed';
// A show's own name, as Reelhouse keeps it: without the "New: " UK guides put on new episodes.
const showName = (title) => title.replace(/^\s*new\s*:\s*/i, '');

/**
 * Asks, then ends a series recording (`who`: who set it, when it isn't the person asking). True when it's done.
 */
export async function cancelSeries(uuid, title, { someoneElses = false, who = null } = {}) {
  if (!(await confirmDialog({
    title: 'Cancel this series recording?',
    message: `New episodes of “${title}” won’t be recorded any more, and what it has scheduled is cancelled. What’s recording now or already recorded stays.`
      + (someoneElses ? ` ${who ? `${who} set it` : 'It wasn’t set through Reelhouse'}.` : ''),
    confirmLabel: 'Cancel series recording', cancelLabel: 'Keep it', danger: true,
  }))) return false;
  try {
    await api.post(`/api/livetv/series/${uuid}/cancel`);
    toast('Series recording cancelled');
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

// Season and episode numbers as Reelhouse writes them elsewhere; else the guide's own label (e.g. "Series 3, Ep 2").
const episodeOf = (e) => (e.season != null && e.episode != null ? `S${e.season} E${e.episode}` : e.episodeLabel || (e.episode != null ? `Episode ${e.episode}` : null));

export const liveTvView = (ctx) => guideView(ctx, { radio: false });
export const radioView = (ctx) => guideView(ctx, { radio: true });

async function guideView(ctx, { radio }) {
  const now = () => Math.floor(Date.now() / 1000);
  // The TV channels, or the radio stations.
  const keep = (d) => ({ ...d, channels: d.channels.filter((c) => !!c.radio === radio) });
  const playPath = (uuid) => (radio ? `/radio/listen/${uuid}` : `/livetv/watch/${uuid}`);
  const verb = radio ? 'Listen' : 'Watch';
  let day = 0; // 0 = today (from just before now), 1 = tomorrow…
  let from = todayFrom(now());
  let to = from + CHUNK;
  let data = keep(await api.get(`/api/livetv/guide?from=${from}&to=${to}`, { signal: ctx.signal }));
  let events = data.events;
  let loadingMore = false;

  document.title = radio ? 'Radio · Reelhouse' : 'Live TV · Reelhouse';
  const root = h('div.page.livetv-page');
  const scroller = h('div.guide-scroll');
  const summary = h('div.guide-summary', { 'aria-live': 'polite' });
  const list = h('div.guide-list');
  let highlighted = null; // the programme shown under the grid (its id)

  const byChannel = () => {
    const map = new Map(data.channels.map((c) => [c.uuid, []]));
    for (const e of events) map.get(e.channel)?.push(e);
    return map;
  };

  function openProgramme(e) {
    const channel = data.channels.find((c) => c.uuid === e.channel);
    // Opened from the grid: the arrow keys carry on from it once the details close.
    const backToGrid = scroller.contains(document.activeElement) || document.activeElement === document.body;
    const t = now();
    const airing = e.start <= t && e.stop > t;
    const past = e.stop <= t;
    const rec = e.dvr;
    const actions = [];
    if (airing) actions.push({ label: verb, primary: true, onClick: () => navigate(playPath(e.channel)) });
    // Someone else's recording: only they (or an admin) can cancel or stop it.
    const othersRecording = rec && rec.canChange === false;
    if (data.canRecord && !past && !othersRecording) {
      if (!rec) {
        actions.push({ label: 'Record', primary: !airing, onClick: async () => {
          await api.post('/api/livetv/record', { eventId: e.id });
          toast(`“${e.title}” will be recorded`);
          await reload();
        } });
      } else if (rec.state === 'recording') {
        actions.push({ label: 'Stop recording', danger: true, onClick: async () => {
          await api.post(`/api/livetv/recordings/${rec.uuid}/stop`);
          toast('Recording stopped');
          await reload();
        } });
      } else if (rec.state === 'scheduled') {
        actions.push({ label: rec.series ? 'Skip this episode' : 'Cancel recording', danger: true, onClick: async () => {
          await api.post(`/api/livetv/recordings/${rec.uuid}/cancel`);
          toast(rec.series ? 'Episode skipped' : 'Recording cancelled');
          await reload();
        } });
      } else if (rec.state === 'skipped') {
        actions.push({ label: 'Record', primary: !airing, onClick: async () => {
          await api.post(`/api/livetv/recordings/${rec.uuid}/record`);
          toast(`“${e.title}” will be recorded`);
          await reload();
        } });
      }
    }
    if (!past && !othersRecording) {
      if (rec?.series) {
        actions.push({ label: 'Cancel series recording', danger: true, onClick: async () => {
          if (await cancelSeries(rec.series, showName(e.title))) await reload();
        } });
      } else if (data.canRecordSeries) {
        actions.push({ label: 'Record series', onClick: async () => {
          const { already } = await api.post('/api/livetv/series', { eventId: e.id });
          const on = channel?.name || 'this channel';
          toast(already ? `You already have a series recording of “${showName(e.title)}” on ${on}`
            : `Every episode of “${showName(e.title)}” on ${on} will be recorded`);
          await reload();
        } });
      }
    }
    actions.push({ label: 'Close' });
    const ep = episodeOf(e);
    const group = genreGroup(e);
    modal({
      title: e.title,
      body: h('div.programme',
        h('div.programme-meta',
          channel && channelLogo(channel, '.programme-logo'),
          h('div',
            h('div', [channel ? `${channel.number ? `${channel.number} · ` : ''}${channel.name}` : null].filter(Boolean)),
            h('div.sub', `${dayLabel(e.start)}, ${timeOf(e.start)}–${timeOf(e.stop)} · ${Math.round((e.stop - e.start) / 60)} min`))),
        (e.subtitle || ep) && h('p.programme-sub', [ep, e.subtitle].filter(Boolean).join(' · ')),
        e.genreName && h('p.programme-genre', h(`span.genre-dot${group ? `.genre-${group}` : ''}`), e.genreName),
        rec && h('p', h('span.status.warn', recordingLabel(rec))),
        h('p.programme-desc', e.description || e.summary || 'No description.'),
        !data.canRecord && !past && h('p.hint', 'Your account can’t schedule recordings.'),
        data.canRecord && !past && othersRecording && h('p.hint', rec.series
          ? 'Someone else has a series recording of this; only they or an admin can change it.'
          : 'Someone else set this recording; only they or an admin can cancel it.'),
      ),
      actions,
      onClose: () => {
        if (backToGrid) buttonFor(highlighted)?.focus({ preventScroll: true });
      },
    });
  }

  /** What's on now on the first channel with anything (else its next programme): shown before anything is pointed at. */
  function firstHighlight(t) {
    for (const c of data.channels) {
      const evs = events.filter((e) => e.channel === c.uuid);
      const pick = evs.find((e) => e.start <= t && e.stop > t) || evs.find((e) => e.stop > Math.max(t, from)) || evs[0];
      if (pick) return pick;
    }
    return null;
  }

  function renderSummary(e) {
    if (!e) return setChildren(summary, h('p.hint', 'No guide information for these hours.'));
    const t = now();
    const channel = data.channels.find((c) => c.uuid === e.channel);
    const group = genreGroup(e);
    const day = dayLabel(e.start);
    const airing = e.start <= t && e.stop > t;
    // While it's on, how much is left of it; otherwise how long it is.
    const duration = airing ? `${Math.max(1, Math.round((e.stop - t) / 60))} min left` : `${Math.round((e.stop - e.start) / 60)} min`;
    setChildren(summary,
      h('div.guide-summary-head',
        h('span.time', `${day === 'Today' ? '' : `${day}, `}${timeOf(e.start)}–${timeOf(e.stop)}`),
        h('span.title', e.title),
        e.dvr && h('span.status.warn', recordingLabel(e.dvr))),
      h('div.guide-summary-meta',
        [channel?.name, episodeOf(e), e.subtitle, duration].filter(Boolean).join(' · '),
        e.genreName && h('span.guide-summary-genre', h(`span.genre-dot${group ? `.genre-${group}` : ''}`), e.genreName)),
      h('p.guide-summary-desc', e.description || e.summary || 'No description.'));
  }

  function highlight(e, button) {
    if (highlighted === e.id) return;
    highlighted = e.id;
    scroller.querySelector('.guide-prog.selected')?.classList.remove('selected');
    button.classList.add('selected');
    renderSummary(e);
  }

  const buttonFor = (id) => scroller.querySelector(`.guide-prog[data-id="${CSS.escape(String(id))}"]`);

  // The mouse highlights what it's moved onto. The guide scrolling under a mouse that hasn't moved (arrow keys,
  // more hours loading) sends the same "entered" events, so those are told apart by the pointer's position.
  let pointer = '';
  function pointedAt(ev, e) {
    const at = `${ev.screenX},${ev.screenY}`;
    if (at === pointer) return;
    pointer = at;
    anchor = null;
    highlight(e, ev.currentTarget);
  }

  // The arrow keys, as Kodi's guide on a remote: ←/→ the programme before or after on the same channel (loading more
  // hours at the end), ↑/↓ the channel above or below at the same time, kept while going up and down so the
  // highlight doesn't drift; Enter opens the programme.
  let anchor = null; // the time ↑/↓ keep to
  const visibleFrom = () => from + (scroller.scrollLeft / PX_PER_MIN) * 60;

  function nearestAt(list, at) {
    let best = null;
    let gap = Infinity;
    for (const e of list) {
      const d = e.start > at ? e.start - at : e.stop <= at ? at - e.stop : 0;
      if (d < gap) [best, gap] = [e, d];
    }
    return best;
  }

  async function move(key, loaded = false) {
    const current = events.find((e) => e.id === highlighted);
    if (!current) return;
    const rows = byChannel();
    let target = null;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      anchor = null;
      const row = rows.get(current.channel) || [];
      target = row[row.findIndex((e) => e.id === current.id) + (key === 'ArrowRight' ? 1 : -1)];
      if (!target && key === 'ArrowRight' && !loaded) {
        await loadMore();
        return move(key, true);
      }
    } else {
      const t = now();
      anchor ??= current.start <= t && current.stop > t ? t : Math.max(current.start, visibleFrom());
      const uuids = [...rows.keys()];
      const step = key === 'ArrowDown' ? 1 : -1;
      for (let i = uuids.indexOf(current.channel) + step; !target && i >= 0 && i < uuids.length; i += step) {
        target = nearestAt(rows.get(uuids[i]), anchor);
      }
    }
    const button = target && buttonFor(target.id);
    if (!button) return;
    button.focus({ preventScroll: true });
    highlight(target, button);
    reveal(button);
  }

  /** Scrolls the grid so a programme is in sight, clear of the channel column and the times along the top. */
  function reveal(button) {
    const box = scroller.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const left = box.left + scroller.clientLeft + scroller.querySelector('.guide-corner').offsetWidth;
    const right = box.left + scroller.clientLeft + scroller.clientWidth;
    const top = box.top + scroller.clientTop + scroller.querySelector('.guide-times').offsetHeight;
    const bottom = box.top + scroller.clientTop + scroller.clientHeight;
    // A programme longer than the view shows its start.
    if (b.left < left) scroller.scrollLeft -= left - b.left + 8;
    else if (b.right > right) scroller.scrollLeft += Math.min(b.right - right + 8, b.left - left - 8);
    if (b.top < top) scroller.scrollTop -= top - b.top;
    else if (b.bottom > bottom) scroller.scrollTop += b.bottom - bottom;
  }

  const onKey = (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || !scroller.offsetParent) return; // phones: no grid
    if (document.querySelector('.modal-backdrop')) return;
    const active = document.activeElement;
    const inGrid = scroller.contains(active);
    // Anywhere on the page (the day chips too) but a text box (search…) or a menu elsewhere.
    if (!inGrid && active !== document.body && !(root.contains(active) && !active.matches('input, textarea, select'))) return;
    if ((ev.key === 'Enter' && (inGrid || active === document.body)) || (ev.key === ' ' && inGrid)) {
      const e = events.find((x) => x.id === highlighted);
      if (!e) return;
      ev.preventDefault();
      openProgramme(e);
    } else if (ev.key.startsWith('Arrow')) {
      ev.preventDefault();
      void move(ev.key);
    }
  };

  function progButton(e, left, width, t) {
    const group = genreGroup(e);
    const cls = [e.stop <= t ? '.past' : '', e.start <= t && e.stop > t ? '.now' : '', recordingMark(e.dvr) ? (e.dvr.state === 'recording' ? '.recording' : '.rec') : '',
      group ? `.genre.genre-${group}` : '', e.id === highlighted ? '.selected' : ''].join('');
    return h(`button.guide-prog${cls}`, {
      type: 'button',
      style: { left: `${left}px`, width: `${Math.max(width - 3, 4)}px` },
      dataset: { id: e.id },
      onMouseenter: (ev) => pointedAt(ev, e),
      onFocus: (ev) => highlight(e, ev.currentTarget),
      onClick: () => openProgramme(e),
    },
    h('span.title', recordingMark(e.dvr) && icon('record', 12, 'rec-dot'), e.title),
    h('span.time', `${timeOf(e.start)}–${timeOf(e.stop)}`));
  }

  function renderGrid() {
    const t = now();
    // The same programme stays highlighted as the guide refreshes (with what's changed, e.g. now recording).
    const shown = events.find((e) => e.id === highlighted && e.stop > from) || firstHighlight(t);
    highlighted = shown?.id ?? null;
    renderSummary(shown);
    const width = ((to - from) / 60) * PX_PER_MIN;
    const x = (time) => ((Math.max(time, from) - from) / 60) * PX_PER_MIN;
    const times = [];
    for (let s = from; s < to; s += HALF_HOUR) times.push(h('span.guide-time', { style: { left: `${x(s)}px` } }, timeOf(s)));
    const rows = [];
    for (const [uuid, list] of byChannel()) {
      const c = data.channels.find((ch) => ch.uuid === uuid);
      rows.push(h('div.guide-row',
        h('button.guide-channel', { type: 'button', title: `${verb}${radio ? ' to' : ''} ${c.name}`, onClick: () => navigate(playPath(c.uuid)) },
          channelLogo(c),
          h('span.num', c.number ?? ''), h('span.name', c.name)),
        h('div.guide-progs', { style: { width: `${width}px` } },
          list.length ? list.map((e) => progButton(e, x(e.start), x(Math.min(e.stop, to)) - x(e.start), t))
            : h('div.guide-empty', 'No guide information')),
      ));
    }
    const nowLine = t >= from && t < to ? h('div.guide-nowline', { style: { left: `calc(var(--guide-channel-w) + ${x(t)}px)` } }) : null;
    const hadFocus = scroller.contains(document.activeElement);
    setChildren(scroller, h('div.guide-grid', { style: { width: `calc(var(--guide-channel-w) + ${width}px)` } },
      h('div.guide-times', h('div.guide-corner', dayLabel(from)), h('div.guide-ruler', { style: { width: `${width}px` } }, times)),
      rows, nowLine));
    // Built afresh (every minute, more hours): the keys carry on from the same programme.
    if (hadFocus) buttonFor(highlighted)?.focus({ preventScroll: true });
  }

  function renderList() {
    const t = now();
    setChildren(list, [...byChannel()].map(([uuid, evs]) => {
      const c = data.channels.find((ch) => ch.uuid === uuid);
      const current = evs.find((e) => e.start <= t && e.stop > t);
      const next = evs.find((e) => e.start >= (current?.stop ?? t));
      return h('div.guide-item',
        h('button.guide-item-channel', { type: 'button', onClick: () => navigate(playPath(c.uuid)), 'aria-label': `${verb} ${radio ? 'to ' : ''}${c.name}` },
          channelLogo(c),
          h('span.num', c.number ?? '')),
        h('div.guide-item-body',
          h('div.guide-item-name', c.name),
          current ? h('button.guide-item-now', { type: 'button', onClick: () => openProgramme(current) },
            h('span.title', recordingMark(current.dvr) && icon('record', 12, 'rec-dot'), current.title),
            h('span.bar', h('span', { style: { width: `${Math.round(((t - current.start) / (current.stop - current.start)) * 100)}%` } })),
            h('span.sub', `${timeOf(current.start)}–${timeOf(current.stop)} · ${Math.max(1, Math.round((current.stop - t) / 60))} min left`))
            : h('div.sub', 'No guide information'),
          next && h('button.guide-item-next', { type: 'button', onClick: () => openProgramme(next) }, `${timeOf(next.start)} ${next.title}`)),
      );
    }));
  }

  const render = () => {
    renderGrid();
    renderList();
  };

  async function load(newFrom, span = CHUNK) {
    from = newFrom;
    to = from + span;
    data = keep(await api.get(`/api/livetv/guide?from=${from}&to=${to}`));
    events = data.events;
    render();
  }

  /**
   * The same hours again (after recording, or every minute), keeping the scroll position. Today's guide left open
   * moves on with the time (see followNow): the programmes move left rather than the now line drifting right.
   */
  async function reload() {
    let left = scroller.scrollLeft;
    if (day === 0) ({ from, to, scrollLeft: left } = followNow({ from, to, scrollLeft: left }, now(), PX_PER_MIN));
    const fresh = keep(await api.get(`/api/livetv/guide?from=${from}&to=${to}`));
    data = fresh;
    events = fresh.events;
    render();
    scroller.scrollLeft = left;
  }

  async function loadMore() {
    if (loadingMore || to - startOfDay(day) >= MAX_SPAN + HALF_HOUR * 2) return;
    loadingMore = true;
    try {
      const more = await api.get(`/api/livetv/guide?from=${to}&to=${to + CHUNK}`);
      const seen = new Set(events.map((e) => e.id));
      events = [...events, ...more.events.filter((e) => !seen.has(e.id))];
      to += CHUNK;
      renderGrid();
    } finally {
      loadingMore = false;
    }
  }
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollLeft + scroller.clientWidth > scroller.scrollWidth - 600) void loadMore();
  }, { passive: true });

  const dayName = (i) => (i === 0 ? 'Today' : dayLabel(startOfDay(i)).replace(/,.*$/, ''));
  const days = h('div.guide-days', Array.from({ length: 7 }, (_, i) => h(`button.chip${i === 0 ? '.active' : ''}`, {
    type: 'button',
    onClick: async (ev) => {
      day = i;
      for (const b of days.children) b.classList.toggle('active', b === ev.currentTarget);
      try {
        await load(i === 0 ? todayFrom(now()) : startOfDay(i));
      } catch (err) {
        return toastError(err);
      }
      scroller.scrollLeft = 0;
      buttonFor(highlighted)?.focus({ preventScroll: true }); // the keys carry on in the new day's guide
    },
  }, dayName(i))));

  // Left open past midnight: the day buttons are named afresh (Tomorrow becomes Today), and the day shown keeps its
  // button (a later day's moves one along; today's follows the time anyway).
  let today = startOfDay(0);
  const newDay = () => {
    const was = today;
    today = startOfDay(0);
    if (today === was) return;
    day = Math.max(0, day - Math.round((today - was) / 86400));
    [...days.children].forEach((b, i) => {
      b.textContent = dayName(i);
      b.classList.toggle('active', i === day);
    });
  };

  // The time now, across from the heading as in Kodi's guide, turning over with the minute.
  const clock = h('div.guide-clock');
  let clockTimer = null;
  const tick = () => {
    clearTimeout(clockTimer);
    newDay();
    clock.textContent = timeOf(now());
    clockTimer = setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
  };
  tick();

  setChildren(root,
    h('div.page-head', h('div.guide-title', h('h1', radio ? 'Radio' : 'Live TV'), clock), days),
    data.channels.length ? [scroller, summary, list]
      : radio ? h('div.empty', h('h2', 'No radio stations'), h('p', 'Tvheadend gives radio stations a channel tag such as “Radio channels” when it maps them; stations without one show here once they’ve been played.'))
        : h('div.empty', h('h2', 'No channels'), h('p', 'Tvheadend has no channels this server’s account may watch.')),
  );
  render();

  // The now-line moves and programmes change: refresh the hours on screen every minute (and when shown again).
  const timer = setInterval(() => {
    if (!document.hidden) void reload().catch(() => {});
  }, REFRESH_MS);
  const onVisible = () => {
    if (document.hidden) return;
    tick(); // a hidden tab's timers run late
    void reload().catch(() => {});
  };
  document.addEventListener('visibilitychange', onVisible);
  document.addEventListener('keydown', onKey);
  ctx.onCleanup(() => {
    document.title = 'Reelhouse';
    clearInterval(timer);
    clearTimeout(clockTimer);
    document.removeEventListener('visibilitychange', onVisible);
    document.removeEventListener('keydown', onKey);
  });
  return root;
}
