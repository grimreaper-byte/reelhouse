// Manage Recordings, as a library (like a TV library: shows, then their series, then the episodes): the Live TV
// recordings you set from the guide (Reelhouse keeps who set each; Tvheadend records them all under one account),
// grouped into shows with their cover art (TMDB's poster for the show's name, else the guide's picture, else the
// channel's logo), under the headings Recording now, Recorded (newest first) and Scheduled (soonest first), each a grid
// like a library's. A show opens its series' covers (/recordings/<key>; TMDB's poster for each series, else the show's), and a series its
// episodes (/recordings/<key>/<series>, "other" for those without a number; TMDB's still for each episode, else the
// guide's picture); a show without series numbers goes straight to its episodes. Pointing at a cover shows a button in
// its top left corner: the bin deletes the show, the series or the recording (asked first; what's still to come keeps
// recording), × cancels a scheduled one and ■ stops one recording now (what's recorded stays). An episode opens its
// details. Under the shows, Series recordings: what's been set to record every episode of a show on a channel (Tvheadend's
// autorecs, set from the guide), each with what's next; × cancels one, and an episode one made offers Skip rather than
// Cancel. Across from the title is how full Tvheadend's recordings drive is, as in Settings → Live TV. Admins can switch
// to everyone's (?all=1), with who set each under its cover (their pictures and names, as
// under a request's poster), including ones Reelhouse didn't schedule. The pages are read again every minute while
// open, as recordings start and finish on their own.
import { h, icon, formatBytes, setChildren } from '../dom.js';
import { api } from '../api.js';
import { confirmDialog, emptyState, lazyImg, modal, toast, toastError } from '../components.js';
import { avatarContent } from '../avatar.js';
import { isAdmin } from '../state.js';
import { navigate } from '../router.js';
import { cancelSeries, channelLogo, dayLabel, recordingsDrive, timeOf } from './livetv.js';

const REFRESH_MS = 60 * 1000;
const MAX_FACES = 3; // pictures on a cover's line of who set it (their names all follow)

// What each state offers, and what's said once it's done.
const ACTIONS = {
  recording: { action: 'stop', label: 'Stop recording', icon: 'stop', done: 'Recording stopped' },
  scheduled: { action: 'cancel', label: 'Cancel recording', icon: 'x', done: 'Recording cancelled' },
  recorded: { action: 'delete', label: 'Delete recording', icon: 'trash', done: 'Recording deleted' },
  failed: { action: 'delete', label: 'Delete recording', icon: 'trash', done: 'Recording deleted' },
};

// What a recording offers: an episode of a series recording is skipped rather than cancelled (cancelled, it would come back).
const actionOf = (rec) => (rec.state === 'scheduled' && rec.series
  ? { action: 'cancel', label: 'Skip this episode', icon: 'x', done: 'Episode skipped' } : ACTIONS[rec.state]);

// Tvheadend's word for one that isn't going to plan ("Waiting for stream", "Time missed"), else null.
const troubleOf = (rec) => (rec.status && (rec.problem || rec.state === 'failed' || (rec.state === 'recorded' && rec.status !== 'Completed OK')) ? rec.status : null);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const query = (everyone) => (everyone ? '?all=1' : '');
const listHref = (everyone) => `/recordings${query(everyone)}`;
const showHref = (show, everyone) => `/recordings/${encodeURIComponent(show.key)}${query(everyone)}`;
const seriesKey = (season) => (season.season == null ? 'other' : String(season.season));
const seriesHref = (show, season, everyone) => `/recordings/${encodeURIComponent(show.key)}/${seriesKey(season)}${query(everyone)}`;
const seriesName = (season, show) => (season.season != null ? `Series ${season.season}`
  : show.seasons.some((s) => s.season != null) ? 'Other recordings' : 'Recordings');
// Recorded and failed ones this person may delete: what deleting a series or a show takes.
const deletable = (recs) => recs.filter((r) => r.canChange && (r.state === 'recorded' || r.state === 'failed'));
const allOf = (show) => show.seasons.flatMap((s) => s.recordings);

/** "1 recording now · 2 scheduled · 5 recorded", as much as there is. */
function countsLine(counts) {
  return [
    counts.recording && `${counts.recording} recording now`,
    counts.scheduled && `${counts.scheduled} scheduled`,
    counts.recorded && `${counts.recorded} recorded`,
    counts.failed && `${counts.failed} failed`,
  ].filter(Boolean).join(' · ');
}

/** The line a recording is known by among its series: its episode and subtitle, else its title. */
function episodeLine(rec) {
  return [rec.episode != null ? `Episode ${rec.episode}` : null, rec.subtitle].filter(Boolean).join(' · ') || rec.title;
}

/** Reads the list again every minute (and when the tab is shown again) while the page is open. */
function keepFresh(ctx, reload) {
  const again = () => {
    if (!document.hidden) void reload().catch(() => {});
  };
  const timer = setInterval(again, REFRESH_MS);
  document.addEventListener('visibilitychange', again);
  ctx.onCleanup(() => {
    document.title = 'Reelhouse';
    clearInterval(timer);
    document.removeEventListener('visibilitychange', again);
  });
}

const fetchRecordings = (ctx, everyone) => api.get(`/api/livetv/recordings${query(everyone)}`, { signal: ctx.signal });

// ---------- changing recordings ----------

/** Stop, Cancel or Delete one recording (Delete, and someone else's, asked first). True when it was done. */
async function changeOne(rec) {
  const how = actionOf(rec);
  const someoneElses = !rec.mine;
  if (how.action === 'delete' && !(await confirmDialog({
    title: 'Delete this recording?',
    message: `“${rec.title}” (${episodeLine(rec)}) will be deleted from Tvheadend’s recordings drive${someoneElses ? `, though ${rec.owner ? `${rec.owner.username} set it` : 'it wasn’t set through Reelhouse'}` : ''}. This can’t be undone.`,
    confirmLabel: 'Delete', danger: true,
  }))) return false;
  if (how.action !== 'delete' && someoneElses && !(await confirmDialog({
    title: how.action === 'stop' ? 'Stop this recording?' : rec.series ? 'Skip this episode?' : 'Cancel this recording?',
    message: `${rec.owner ? `${rec.owner.username} set` : 'Reelhouse didn’t schedule'} “${rec.title}” (${episodeLine(rec)}).`,
    confirmLabel: how.label, danger: true,
  }))) return false;
  try {
    await api.post(`/api/livetv/recordings/${rec.uuid}/${how.action}`);
    toast(how.done);
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

/** Delete a series or a show: their recorded episodes, after asking; what's still to come stays. True when done. */
async function deleteMany(what, recs) {
  const gone = deletable(recs);
  const waiting = recs.filter((r) => r.state === 'scheduled' || r.state === 'recording').length;
  const others = gone.filter((r) => !r.mine).length;
  if (!gone.length || !(await confirmDialog({
    title: `Delete ${what}?`,
    message: `${gone.length === 1 ? 'Its recording' : `All ${gone.length} of its recordings`} will be deleted from Tvheadend’s recordings drive. This can’t be undone.`
      + (others ? ` ${others === gone.length ? 'They were' : `${others} of them ${others === 1 ? 'was' : 'were'}`} set by someone else.` : '')
      + (waiting ? ` ${waiting === 1 ? 'The one still to come keeps' : `The ${waiting} still to come keep`} recording.` : ''),
    confirmLabel: 'Delete', danger: true,
  }))) return false;
  try {
    const r = await api.post('/api/livetv/recordings/delete', { uuids: gone.map((x) => x.uuid) });
    toast(`Deleted ${plural(r.deleted, 'recording')}${r.skipped.length ? ` (${r.skipped.length} couldn’t be)` : ''}`);
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

// ---------- covers ----------

/** The button in a cover's top left corner (shown while it's pointed at, always on touch screens). */
function cornerButton(label, iconName, onClick, danger = true) {
  return h(`button.cover-action${danger ? '.danger' : ''}`, {
    type: 'button', 'aria-label': label, title: label,
    onClick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      void onClick();
    },
  }, icon(iconName, 16));
}

function placeholder(title, channel) {
  return h('div.card-placeholder', channel ? channelLogo(channel, '.recording-card-logo') : icon('record', 28), h('div', title));
}

/** Who set these recordings, as under a request's poster: their pictures and names; says so when nobody here did. */
function ownerLine(recs) {
  const people = [...new Map(recs.filter((r) => r.owner).map((r) => [r.owner.id, r.owner])).values()];
  if (!people.length) return h('div.card-sub.recording-nobody', 'Not set through Reelhouse');
  const names = people.map((p) => p.username).join(', ');
  return h('div.request-by.recording-by', { title: names },
    h('span.recording-faces', people.slice(0, MAX_FACES).map((p) => h('span.avatar.avatar-xs', avatarContent(p)))),
    h('span', names));
}

/** Enter or Space on a card opens it; on the button in its corner, they press that. */
function openOnKey(e, open) {
  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    open();
  }
}

/** A show's or a series' cover: its poster, the REC mark while recording, the count of recorded ones, the bin. */
function coverCard({ href, title, sub, poster, channel, counts, bin, owners }) {
  return h('a.card', { href, title },
    h('div.card-img',
      lazyImg(poster, { width: 320, alt: '', fallback: () => placeholder(title, channel) }) || placeholder(title, channel),
      counts.recording > 0 && h('div.rec-badge', icon('record', 10), 'REC'),
      counts.recorded > 0 && h('div.badge', { title: plural(counts.recorded, 'recording') }, String(counts.recorded)),
      bin),
    h('div.card-title', title),
    h('div.card-sub', sub),
    owners);
}

/** An episode's picture (TMDB's still, else the guide's), its state, and the corner button for what it offers. */
function episodeCard(rec, { everyone, onChanged }) {
  const how = actionOf(rec);
  const length = Math.round((rec.stop - rec.start) / 60);
  const sub = [`${dayLabel(rec.start)}, ${timeOf(rec.start)}`, `${length} min`, rec.size ? formatBytes(rec.size) : null].filter(Boolean).join(' · ');
  const trouble = troubleOf(rec);
  const open = () => openEpisode(rec, { onChanged });
  return h('div.card.landscape.episode-card', {
    title: rec.description || episodeLine(rec), role: 'button', tabIndex: 0,
    onClick: open,
    onKeydown: (e) => openOnKey(e, open),
  },
  h('div.card-img',
    lazyImg(rec.still, { width: 400, alt: '', fallback: () => placeholder(episodeLine(rec), rec.channel) }) || placeholder(episodeLine(rec), rec.channel),
    rec.state === 'recording' && !trouble && h('div.rec-badge', icon('record', 10), 'REC'),
    rec.state === 'scheduled' && h('div.state-badge', 'Scheduled'),
    trouble && h('div.state-badge.bad', trouble),
    rec.canChange && cornerButton(`${how.label}: ${episodeLine(rec)}`, how.icon, async () => {
      if (await changeOne(rec)) onChanged();
    }, how.action !== 'cancel')),
  h('div.card-title', episodeLine(rec)),
  h('div.card-sub', sub),
  everyone && ownerLine([rec]));
}

/** An episode's details: channel, times, size, who set it, the description, and what it offers. */
function openEpisode(rec, { onChanged }) {
  const how = actionOf(rec);
  const trouble = troubleOf(rec);
  const state = { recording: 'Recording now', scheduled: 'Scheduled', recorded: 'Recorded', failed: 'Failed' }[rec.state];
  modal({
    title: `${rec.title}: ${episodeLine(rec)}`,
    body: h('div.programme',
      h('div.programme-meta',
        rec.channel && channelLogo(rec.channel, '.programme-logo'),
        h('div',
          rec.channel && h('div', `${rec.channel.number ? `${rec.channel.number} · ` : ''}${rec.channel.name}`),
          h('div.sub', `${dayLabel(rec.start)}, ${timeOf(rec.start)}–${timeOf(rec.stop)} · ${Math.round((rec.stop - rec.start) / 60)} min`
            + (rec.size ? ` · ${formatBytes(rec.size)}${rec.state === 'recording' ? ' so far' : ''}` : '')))),
      h('p', h(`span.status${trouble || rec.state === 'failed' ? '.bad' : rec.state === 'recorded' ? '.ok' : '.warn'}`, trouble ? `${state}: ${trouble}` : state)),
      h('p.recording-owner', rec.owner
        ? [h('span.avatar.avatar-xs', avatarContent(rec.owner)), h('span', `Set by ${rec.owner.username}`)]
        : h('span', 'Not set through Reelhouse')),
      rec.series && h('p.hint', 'From a series recording.'),
      h('p.programme-desc', rec.description || 'No description.')),
    actions: [
      rec.canChange && { label: how.label, danger: true, onClick: async () => {
        if (await changeOne(rec)) onChanged();
      } },
      { label: 'Close' },
    ].filter(Boolean),
  });
}

// ---------- series recordings ----------

/** "Next: Today, 21:00", or that it's recording now, or that the guide has nothing for it yet. */
function seriesNext(s) {
  if (s.counts.recording > 0) return 'Recording now';
  return s.next != null ? `Next: ${dayLabel(s.next)}, ${timeOf(s.next)}` : 'Nothing scheduled yet';
}

const cancelOne = (s) => cancelSeries(s.uuid, s.title, { someoneElses: !s.mine, who: s.owner?.username });

/** What a series recording does and what it has made so far, with its show's page and Cancel series recording. */
function openSeries(s, { everyone, onChanged, hasShow }) {
  modal({
    title: s.title,
    body: h('div.programme',
      h('div.programme-meta',
        s.channel && channelLogo(s.channel, '.programme-logo'),
        h('div',
          s.channel && h('div', `${s.channel.number ? `${s.channel.number} · ` : ''}${s.channel.name}`),
          h('div.sub', seriesNext(s)))),
      h('p', 'Records every episode of this show on this channel. Repeats are left out when the guide can tell.'),
      countsLine(s.counts) && h('p.hint', countsLine(s.counts)),
      h('p.recording-owner', s.owner
        ? [h('span.avatar.avatar-xs', avatarContent(s.owner)), h('span', `Set by ${s.owner.username}`)]
        : h('span', 'Not set through Reelhouse'))),
    actions: [
      hasShow && { label: 'See its episodes', onClick: () => navigate(showHref(s, everyone)) },
      s.canChange && { label: 'Cancel series recording', danger: true, onClick: async () => {
        if (await cancelOne(s)) onChanged();
      } },
      { label: 'Close' },
    ].filter(Boolean),
  });
}

/** A series recording's cover: its show's poster, what's next, who set it, and × to cancel it. */
function seriesCard(s, opts) {
  const open = () => openSeries(s, opts);
  return h('div.card', {
    title: s.title, role: 'button', tabIndex: 0,
    onClick: open,
    onKeydown: (e) => openOnKey(e, open),
  },
  h('div.card-img',
    lazyImg(s.poster, { width: 320, alt: '', fallback: () => placeholder(s.title, s.channel) }) || placeholder(s.title, s.channel),
    s.counts.recording > 0 && h('div.rec-badge', icon('record', 10), 'REC'),
    s.canChange && cornerButton(`Cancel series recording: ${s.title}`, 'x', async () => {
      if (await cancelOne(s)) opts.onChanged();
    }, false)),
  h('div.card-title', s.title),
  h('div.card-sub', seriesNext(s)),
  s.channel && h('div.card-sub', s.channel.name),
  opts.everyone && ownerLine([s]));
}

// ---------- the shows ----------

/** A titled section of show covers, a grid like a library's; none when it has no shows. */
function showSection(title, shows, card) {
  if (!shows.length) return null;
  return h('section.hub', h('div.hub-head', h('h2', title)), h('div.grid', shows.map(card)));
}

export async function recordingsView(ctx) {
  const everyone = isAdmin() && ctx.query.all === '1';
  let data = await fetchRecordings(ctx, everyone);
  document.title = 'Manage Recordings · Reelhouse';

  const grid = h('div.recordings-shows');
  const summary = h('span.recordings-counts');
  const drive = h('div.recordings-drive');
  const chip = (all, label) => h(`button.chip${all === everyone ? '.active' : ''}`, {
    onClick: () => { if (all !== everyone) navigate(listHref(all), { replace: true }); },
  }, label);

  async function reload() {
    data = await fetchRecordings(ctx, everyone);
    render();
  }

  function render() {
    drive.hidden = !data.drive;
    if (data.drive) setChildren(drive, h('div.recordings-drive-name', 'Recordings drive'), h('div', recordingsDrive(data.drive)));
    const totals = { recording: 0, scheduled: 0, recorded: 0, failed: 0 };
    for (const s of data.shows) for (const k of Object.keys(totals)) totals[k] += s.counts[k];
    summary.textContent = data.shows.length ? `${plural(data.shows.length, 'show')} · ${countsLine(totals)}` : '';
    if (!data.shows.length && !data.series?.length) {
      return setChildren(grid, emptyState(
        everyone ? 'No recordings' : 'Nothing recorded or scheduled',
        everyone ? 'Tvheadend has no recordings Reelhouse can see.' : h('span', 'Open a programme in the ', h('a', { href: '/livetv' }, 'Live TV guide'), ' and choose Record.'),
      ));
    }
    // A show is in each section it has something for (one with recorded and scheduled episodes is in both), with who
    // set the episodes in that section.
    const card = (show, states, sub, counts, bin) => coverCard({
      href: showHref(show, everyone), title: show.title, sub, poster: show.poster, channel: show.channel, counts, bin,
      owners: everyone && ownerLine(allOf(show).filter((r) => states.includes(r.state))),
    });
    const recordingNow = data.shows.filter((s) => s.recordingNow);
    const recorded = data.shows.filter((s) => s.counts.recorded + s.counts.failed > 0).sort((a, b) => b.latest - a.latest);
    const scheduled = data.shows.filter((s) => s.nextScheduled != null).sort((a, b) => a.nextScheduled - b.nextScheduled);
    setChildren(grid,
      showSection('Recording now', recordingNow, (s) => card(s, ['recording'], 'Recording now', { recording: s.counts.recording })),
      showSection('Recorded', recorded, (s) => {
        const gone = deletable(allOf(s)).length;
        return card(s, ['recorded', 'failed'], countsLine({ recorded: s.counts.recorded, failed: s.counts.failed }), { recorded: s.counts.recorded },
          gone > 0 && cornerButton(`Delete ${s.title} (${plural(gone, 'recording')})`, 'trash', async () => {
            if (await deleteMany(`“${s.title}”`, allOf(s))) await reload().catch(() => {});
          }));
      }),
      showSection('Scheduled', scheduled, (s) => card(s, ['scheduled'], `Next: ${dayLabel(s.nextScheduled)}, ${timeOf(s.nextScheduled)}`
        + (s.counts.scheduled > 1 ? ` · ${s.counts.scheduled} scheduled` : ''), {})),
      showSection('Series recordings', data.series || [], (s) => seriesCard(s, {
        everyone,
        onChanged: () => void reload().catch(() => {}),
        hasShow: data.shows.some((show) => show.key === s.key),
      })));
  }

  keepFresh(ctx, reload);
  render();
  return h('div.page.recordings-page',
    h('div.page-head',
      h('div.recordings-title',
        h('h1.page-title', 'Manage Recordings'),
        isAdmin() && h('div.recordings-whose', { role: 'group', 'aria-label': 'Whose recordings' }, chip(false, 'Mine'), chip(true, 'Everyone’s')),
        summary),
      drive),
    h('p.page-intro', everyone ? 'Everyone’s recordings by show, with who set each.' : 'What you’ve set to record from the Live TV guide, by show.'),
    grid);
}

// ---------- a show's series, and a series' episodes ----------

/** The top of a show's or a series' page: its cover, name, what it has, and a Delete button for all of it. */
function pageHead({ back, poster, channel, title, over, meta, deleteLabel, onDelete }) {
  return [
    h('a.recordings-back', { href: back.href }, icon('chevronLeft', 18), back.label),
    h('div.recording-show-head',
      h('div.card-img.recording-show-poster', lazyImg(poster, { width: 320, alt: '', fallback: () => placeholder(title, channel) }) || placeholder(title, channel)),
      h('div.recording-show-info',
        over && h('div.recording-show-over', over),
        h('h1.page-title', title),
        h('p.recording-show-meta', meta),
        onDelete && h('button.btn.btn-danger', { onClick: () => void onDelete() }, icon('trash', 16), deleteLabel))),
  ];
}

function episodesGrid(recs, opts) {
  return h('div.grid.episode-grid', recs.map((r) => episodeCard(r, opts)));
}

/** Shared by a show's and a series' pages: reads the show, draws it with `draw`, and keeps it fresh. */
async function showPage(ctx, draw) {
  const everyone = isAdmin() && ctx.query.all === '1';
  const key = ctx.params.key;
  let data = await fetchRecordings(ctx, everyone);
  const body = h('div');

  async function reload() {
    data = await fetchRecordings(ctx, everyone);
    render();
  }
  const changed = () => void reload().catch((err) => { if (err.name !== 'AbortError') console.error(err); });

  function render() {
    const show = data.shows.find((s) => s.key === key);
    if (!show) {
      document.title = 'Manage Recordings · Reelhouse';
      return setChildren(body, emptyState('Nothing recorded under this name', 'Its recordings have been deleted, or were never yours.',
        h('a.btn', { href: listHref(everyone) }, 'Back to Manage Recordings')));
    }
    setChildren(body, draw(show, { everyone, onChanged: changed }));
  }

  keepFresh(ctx, reload);
  render();
  return h('div.page.recordings-page', body);
}

export function recordingShowView(ctx) {
  return showPage(ctx, (show, opts) => {
    const { everyone, onChanged } = opts;
    document.title = `${show.title} · Manage Recordings · Reelhouse`;
    const all = allOf(show);
    const gone = deletable(all).length;
    const numbered = show.seasons.some((s) => s.season != null);
    return [
      ...pageHead({
        back: { href: listHref(everyone), label: everyone ? 'Everyone’s recordings' : 'Manage Recordings' },
        poster: show.poster,
        channel: show.channel,
        title: show.title,
        meta: [show.channel?.name, countsLine(show.counts)].filter(Boolean).join(' · '),
        deleteLabel: `Delete show (${gone})`,
        onDelete: gone > 0 && (async () => { if (await deleteMany(`“${show.title}”`, all)) onChanged(); }),
      }),
      numbered
        // Its series as covers, like a TV library's seasons.
        ? h('div.grid', show.seasons.map((s) => {
          const n = deletable(s.recordings).length;
          return coverCard({
            href: seriesHref(show, s, everyone),
            title: seriesName(s, show),
            sub: countsLine(s.counts),
            poster: s.poster,
            channel: show.channel,
            counts: s.counts,
            owners: everyone && ownerLine(s.recordings),
            bin: n > 0 && cornerButton(`Delete ${seriesName(s, show).toLowerCase()} (${plural(n, 'recording')})`, 'trash', async () => {
              const what = s.season != null ? `series ${s.season} of “${show.title}”` : `the other recordings of “${show.title}”`;
              if (await deleteMany(what, s.recordings)) onChanged();
            }),
          });
        }))
        // No series numbers from the guide: its episodes straight away.
        : episodesGrid(all, opts),
    ];
  });
}

export function recordingSeriesView(ctx) {
  return showPage(ctx, (show, opts) => {
    const { everyone, onChanged } = opts;
    const season = show.seasons.find((s) => seriesKey(s) === ctx.params.season);
    if (!season) {
      document.title = `${show.title} · Manage Recordings · Reelhouse`;
      return emptyState('Nothing recorded in this series', 'Its recordings have been deleted.',
        h('a.btn', { href: showHref(show, everyone) }, `Back to ${show.title}`));
    }
    const name = seriesName(season, show);
    document.title = `${name} · ${show.title} · Manage Recordings · Reelhouse`;
    const gone = deletable(season.recordings).length;
    return [
      ...pageHead({
        back: { href: showHref(show, everyone), label: show.title },
        poster: season.poster,
        channel: show.channel,
        over: show.title,
        title: name,
        meta: countsLine(season.counts),
        deleteLabel: `Delete series (${gone})`,
        onDelete: gone > 0 && (async () => {
          const what = season.season != null ? `series ${season.season} of “${show.title}”` : `the other recordings of “${show.title}”`;
          if (await deleteMany(what, season.recordings)) onChanged();
        }),
      }),
      episodesGrid(season.recordings, opts),
    ];
  });
}
