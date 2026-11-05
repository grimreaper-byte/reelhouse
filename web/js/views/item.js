import {
  h, icon, setChildren, imgUrl, formatDuration, formatTime, formatBytes, formatBitrate, formatDate, episodeLabel, languageName,
  channelsLabel, codecLabel,
} from '../dom.js';
import { api } from '../api.js';
import {
  posterCard, lazyImg, popupMenu, modal, toast, toastError, playUrl, fill, scrollButtons, hubRow,
} from '../components.js';
import { render, refresh as refreshPage } from '../router.js';
import { isAdmin, state, getPrefs, setPrefs } from '../state.js';
import { personUrl } from './person.js';
import { liveRefresh } from '../live.js';

export async function itemView(ctx) {
  let data = await api.get(`/api/items/${ctx.params.id}`, { signal: ctx.signal });
  // An old link to one copy of a film (an SD file, say, before an HD one arrived): the film's page, which lists them all.
  if (data.item.versionOf) {
    history.replaceState(history.state, '', `/item/${data.item.versionOf}`);
    data = await api.get(`/api/items/${data.item.versionOf}`, { signal: ctx.signal });
  }
  const { item } = data;
  liveRefresh(item.libraryId);
  document.title = `${item.type === 'episode' && data.show ? `${data.show.title} · ` : ''}${item.title} · Reelhouse`;
  ctx.onCleanup(() => {
    document.title = 'Reelhouse';
  });
  switch (item.type) {
    case 'movie': return withRelated(movieView(data), item, ctx);
    case 'show': return withRelated(showView(data), item, ctx);
    case 'season': return seasonView(data);
    default: return episodeView(data);
  }
}

// Related titles and "More with <actor>" rows, loaded after the page appears (a live refresh waits for
// them, so the page is full height again before its scroll position is restored).
function withRelated(page, item, ctx) {
  const host = h('div.related');
  page.querySelector('.detail-body').append(host);
  const ready = api.get(`/api/items/${item.id}/related`, { signal: ctx.signal }).then((r) => {
    const rows = [];
    if (r.similar.length) {
      rows.push(hubRow({ title: item.type === 'movie' ? 'Related movies' : 'Related shows', items: r.similar }));
    }
    for (const person of r.byCast) {
      rows.push(hubRow({
        title: `More with ${person.name}`,
        items: person.items,
        lead: h('div.hub-avatar', person.profile
          ? lazyImg(person.profile, { width: 32, fallback: () => h('span', initials(person.name)) })
          : initials(person.name)),
        subtitle: (it) => [it.year, it.role && `as ${it.role}`].filter(Boolean).join(' · '),
      }));
    }
    host.append(...rows);
  }).catch((err) => {
    if (err.name !== 'AbortError') console.warn('Related titles unavailable:', err.message);
  });
  return ctx.refresh ? ready.then(() => page) : page;
}

// ---------- shared pieces ----------

function backdrop(url) {
  const wrap = h('div.detail-backdrop');
  if (url) {
    const img = h('img', { src: imgUrl(url, 1280), alt: '', decoding: 'async' });
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    wrap.append(img);
  }
  return wrap;
}

function posterBlock(src, { landscape = false, title } = {}) {
  return h(`div.detail-poster${landscape ? '.landscape' : ''}`,
    h('div.card-img', lazyImg(src, { width: landscape ? 380 : 250, fallback: () => h('div.card-placeholder', icon('film', 28), h('div', title)) })
      || h('div.card-placeholder', icon('film', 28), h('div', title))));
}

function metaLine(parts) {
  return h('div.meta', parts.filter(Boolean));
}

function ratingEl(r) {
  return r ? h('span.star', icon('star', 15), r.toFixed(1)) : null;
}

function overviewEl(text) {
  if (!text) return null;
  const el = h('p.overview', text);
  if (text.length > 420) {
    el.classList.add('clamp');
    el.title = 'Show more';
    el.addEventListener('click', () => el.classList.toggle('clamp'));
  }
  return el;
}

function playButtons(item, { label } = {}) {
  const pos = item.state?.position || 0;
  const buttons = [];
  if (pos > 0) {
    buttons.push(h('a.btn.btn-primary.btn-lg', { href: `/play/${item.id}?t=${Math.floor(pos)}` }, icon('play', 20), `Resume from ${formatTime(pos)}`));
    buttons.push(h('a.btn.btn-lg', { href: `/play/${item.id}` }, 'Play from start'));
  } else {
    buttons.push(h('a.btn.btn-primary.btn-lg', { href: `/play/${item.id}` }, icon('play', 20), label || 'Play'));
  }
  return buttons;
}

function watchedButton(item) {
  const watched = item.state?.watched;
  return h('button.btn.btn-lg.btn-icon', {
    title: watched ? 'Mark as unwatched' : 'Mark as watched',
    'aria-label': watched ? 'Mark as unwatched' : 'Mark as watched',
    style: watched ? { color: 'var(--accent)' } : undefined,
    onClick: async () => {
      try {
        await api.post(`/api/items/${item.id}/watched`, { watched: !watched });
        render();
      } catch (err) {
        toastError(err);
      }
    },
  }, icon('check', 20));
}

function moreButton(item, media) {
  return h('button.btn.btn-lg.btn-icon', {
    'aria-label': 'More actions',
    onClick: (e) => popupMenu(e.currentTarget, [
      item.versions?.length > 1 && { label: 'Play version…', icon: 'play', onClick: () => versionsModal(item) },
      media && { label: 'Media info', icon: 'info', onClick: () => mediaInfoModal(media, item.versions) },
      media && state.me?.defaults?.allowDownloads && { label: 'Download file', icon: 'download', onClick: () => download(item) },
      isAdmin() && '-',
      isAdmin() && ['movie', 'show'].includes(item.type) && { label: 'Fix match…', icon: 'link', onClick: () => matchModal(item) },
      isAdmin() && { label: 'Refresh metadata', icon: 'refresh', onClick: () => refresh(item) },
    ]),
  }, icon('more', 20));
}

// ---------- artwork editor (admins) ----------

const ART_LABELS = { poster: 'Poster', backdrop: 'Background', thumb: 'Thumbnail' };

function editButton(item) {
  return h('button.btn.btn-lg.btn-icon', {
    'aria-label': 'Edit artwork', title: 'Edit artwork', onClick: () => artworkModal(item),
  }, icon('edit', 20));
}

function artworkModal(item) {
  const body = h('div.art-editor');
  const dlg = modal({ title: `Artwork · ${item.title}`, wide: true, body });
  let data = null;
  let kind = null;

  const caption = (o) => {
    if (o.source === 'local') return [h('strong', 'Your file'), ` · ${o.name}`];
    const bits = ['TMDB', o.language ? languageName(o.language) || o.language.toUpperCase() : 'No text'];
    if (o.width && o.height) bits.push(`${o.width}×${o.height}`);
    return [bits.join(' · '), o.rating ? h('span.art-rating', icon('star', 12), o.rating.toFixed(1)) : null];
  };

  const choose = async (tile, ref) => {
    if (tile.classList.contains('busy')) return;
    tile.classList.add('busy');
    try {
      await api.post(`/api/items/${item.id}/artwork`, { kind, ref });
      data.current[kind] = ref ?? data.current[kind];
      data.picked[kind] = ref != null;
      toast(ref == null ? `${ART_LABELS[kind]} set back to automatic` : `${ART_LABELS[kind]} updated`);
      if (ref == null) data = await api.get(`/api/items/${item.id}/artwork`); // see what "automatic" chose
      show();
      void refreshPage(); // the page behind the dialog
    } catch (err) {
      toastError(err);
    } finally {
      tile.classList.remove('busy');
    }
  };

  const show = () => {
    const options = data.options[kind];
    const shape = kind === 'poster' ? '.portrait' : '.landscape';
    const auto = h(`button.art-tile.art-auto${shape}${data.picked[kind] ? '' : '.selected'}`, {
      type: 'button', title: 'Let Reelhouse choose (your files first, then TMDB)', onClick: (e) => data.picked[kind] && choose(e.currentTarget, null),
    },
    h('div.art-img', h('div.art-auto-label', icon('refresh', 22), h('span', 'Automatic'))),
    h('div.art-cap', data.picked[kind] ? 'Go back to automatic' : 'Chosen automatically'));
    const tiles = options.map((o) => {
      const selected = data.picked[kind] && o.ref === data.current[kind];
      return h(`button.art-tile${shape}${selected ? '.selected' : ''}`, {
        type: 'button', title: o.source === 'local' ? o.name : 'Use this image', onClick: (e) => !selected && choose(e.currentTarget, o.ref),
      },
      h('div.art-img', lazyImg(o.preview, { width: kind === 'poster' ? 160 : 300, alt: '' }), selected && h('div.art-check', icon('check', 16))),
      h('div.art-cap', caption(o)));
    });
    const notes = [];
    if (!data.tmdb.configured) notes.push('Add a TMDB API key in Settings → Metadata to also choose from TMDB’s artwork.');
    else if (data.tmdb.error) notes.push(`TMDB’s artwork couldn’t be loaded: ${data.tmdb.error}`);
    else if (!data.tmdb.matched) notes.push('This title isn’t matched on TMDB, so only images from its folder are shown. Use “Fix match…” first.');
    setChildren(body,
      data.kinds.length > 1 && h('div.art-tabs', { role: 'tablist' }, data.kinds.map((k) => h(`button${k === kind ? '.active' : ''}`, {
        type: 'button', role: 'tab', 'aria-selected': String(k === kind), onClick: () => { kind = k; show(); },
      }, ART_LABELS[k], h('span.count', String(data.options[k].length))))),
      h('p.hint', 'Your pick stays even when metadata is refreshed. Images from the title’s own folder are listed first.'),
      h(`div.art-grid${shape}`, auto, tiles),
      !options.length && h('p.hint', 'No other images were found.'),
      notes.map((n) => h('p.hint.art-note', n)),
    );
  };

  setChildren(body, h('div.art-loading', h('div.spinner'), h('span', 'Looking for artwork…')));
  api.get(`/api/items/${item.id}/artwork`).then((d) => {
    data = d;
    kind = d.kinds[0];
    show();
  }).catch((err) => setChildren(body, h('div.form-error', err.message)));
  return dlg;
}

/** A film's copies (SD and HD, say), best first: play (or resume) any of them, or download it. */
function versionsModal(item) {
  const pos = Math.floor(item.state?.position || 0);
  const downloads = state.me?.defaults?.allowDownloads;
  const go = () => dlg.close();
  const dlg = modal({
    title: 'Play version',
    body: h('div.list', item.versions.map((v, i) => h('div.list-row',
      h('div.grow',
        h('div.title', v.label, i === 0 && h('span.version-default', 'Plays by default')),
        h('div.sub', versionDetails(v))),
      pos > 0 && h('a.btn.btn-sm.btn-primary', { href: `/play/${v.id}?t=${pos}`, onClick: go }, icon('play', 16), `Resume from ${formatTime(pos)}`),
      h(`a.btn.btn-sm${pos > 0 ? '' : '.btn-primary'}`, { href: `/play/${v.id}`, onClick: go }, pos > 0 ? 'From start' : [icon('play', 16), 'Play']),
      downloads && h('button.btn.btn-sm.btn-icon', { 'aria-label': `Download the ${v.label} file`, title: 'Download this file', onClick: () => download(v) }, icon('download', 16)),
    ))),
  });
}

const versionDetails = (v) => [
  v.width && v.height && `${v.width}×${v.height}`, v.videoCodec && codecLabel(v.videoCodec), v.audioCodec && codecLabel(v.audioCodec),
  v.container?.toUpperCase(), formatBytes(v.fileSize), formatBitrate(v.bitrate),
].filter(Boolean).join(' · ');

function download(item) {
  // Same-origin link: the session cookie authorizes it.
  const a = h('a', { href: `/api/stream/${item.id}?download=1`, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function refresh(item) {
  try {
    const r = await api.post(`/api/items/${item.id}/refresh`);
    toast(r.matched ? 'Metadata refreshed' : 'No match found online');
    render();
  } catch (err) {
    toastError(err);
  }
}

/** The cast row; each person opens their page (`fromId` is the movie or show they're listed on). */
function castSection(cast, fromId) {
  if (!cast?.length) return null;
  const row = h('div.cast-row', cast.map((c) => h('a.person', { href: personUrl(c.name, fromId), title: `More with ${c.name}` },
    h('div.face', c.profile ? lazyImg(c.profile, { width: 128, alt: c.name, fallback: () => h('span', initials(c.name)) }) : initials(c.name)),
    h('div.name', c.name),
    c.role && h('div.role', c.role),
  )));
  row.dataset.scrollKey = 'cast';
  return h('div.section', h('div.hub-head', h('h2', 'Cast'), scrollButtons(row)), row);
}

const initials = (name) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('');

function credits(item) {
  const rows = [];
  if (item.directors?.length) rows.push(['Director', item.directors.join(', ')]);
  if (item.studio) rows.push([item.type === 'show' ? 'Network' : 'Studio', item.studio]);
  if (item.originalTitle) rows.push(['Original title', item.originalTitle]);
  if (!rows.length) return null;
  return h('dl.credits', rows.map(([k, v]) => [h('dt', k), h('dd', v)]));
}

function mediaChips(media, item) {
  if (!media) return null;
  const chips = [];
  if (media.video) {
    chips.push(`${item.videoResolution || `${media.video.height}p`} ${codecLabel(media.video.codec)}${media.video.hdr ? ` ${media.video.hdr}` : ''}`);
  }
  const audio = media.audio?.find((a) => a.isDefault) || media.audio?.[0];
  if (audio) chips.push(`${languageName(audio.language) || 'Audio'} · ${codecLabel(audio.codec)} ${channelsLabel(audio.channels)}`);
  if (media.audio?.length > 1) chips.push(`${media.audio.length} audio tracks`);
  const subs = (media.subtitles?.length || 0) + (media.external?.length || 0);
  if (subs) chips.push(`${subs} subtitle${subs > 1 ? 's' : ''}`);
  return h('div.media-chips', chips.map((c) => h('span.chip', c)));
}

/** A file's details; a film with more than one copy has a tab for each (best first). */
function mediaInfoModal(media, versions) {
  if (versions?.length > 1) {
    const tabs = h('div.art-tabs', { role: 'tablist' });
    const pane = h('div');
    const show = (i) => {
      setChildren(tabs, versions.map((v, j) => h(`button${j === i ? '.active' : ''}`, {
        type: 'button', role: 'tab', 'aria-selected': String(j === i), onClick: () => show(j),
      }, v.label)));
      setChildren(pane, mediaInfoBody(versions[i].media || {}));
    };
    show(0);
    modal({ title: 'Media info', body: h('div', tabs, pane), wide: true });
    return;
  }
  modal({ title: 'Media info', body: mediaInfoBody(media), wide: true });
}

function mediaInfoBody(media) {
  const row = (k, v) => (v ? [h('dt', k), h('dd', v)] : null);
  return h('div',
    h('dl.kv',
      row('File', media.file),
      row('Container', media.container?.toUpperCase()),
      row('Duration', formatTime(media.duration)),
      row('Size', formatBytes(media.fileSize)),
      row('Bitrate', formatBitrate(media.bitrate)),
    ),
    media.video && h('div.section', { style: { marginTop: '22px' } }, h('h3', 'Video'), h('dl.kv',
      row('Codec', `${codecLabel(media.video.codec)}${media.video.profile ? ` (${media.video.profile})` : ''}`),
      row('Resolution', `${media.video.width}×${media.video.height}`),
      row('Frame rate', media.video.fps ? `${media.video.fps} fps` : null),
      row('Bit depth', `${media.video.bitDepth}-bit`),
      row('HDR', media.video.hdr),
    )),
    media.audio?.length && h('div.section', { style: { marginTop: '22px' } }, h('h3', 'Audio'), h('dl.kv',
      media.audio.map((a, i) => row(`Track ${i + 1}`, [languageName(a.language) || 'Unknown', codecLabel(a.codec), channelsLabel(a.channels), a.title, a.isDefault && '(default)'].filter(Boolean).join(' · '))),
    )),
    (media.subtitles?.length || media.external?.length) ? h('div.section', { style: { marginTop: '22px' } }, h('h3', 'Subtitles'), h('dl.kv',
      media.subtitles.map((s, i) => row(`Embedded ${i + 1}`, [languageName(s.language) || 'Unknown', codecLabel(s.codec), s.title, s.forced && 'forced', !s.text && 'image-based'].filter(Boolean).join(' · '))),
      media.external.map((s, i) => row(`External ${i + 1}`, [languageName(s.language) || 'Unknown', codecLabel(s.format), s.forced && 'forced', s.sdh && 'SDH'].filter(Boolean).join(' · '))),
    )) : null,
  );
}

function matchModal(item) {
  const q = h('input.input', { value: item.title, placeholder: 'Title' });
  const year = h('input.input', { value: item.year || '', placeholder: 'Year', style: { maxWidth: '100px' }, inputmode: 'numeric' });
  const results = h('div', { style: { marginTop: '16px' } });
  const search = () => fill(results, async () => {
    const r = await api.get(`/api/items/${item.id}/match?q=${encodeURIComponent(q.value)}&year=${encodeURIComponent(year.value)}`);
    if (!r.results.length) return h('p.hint', 'No results. Try a different title or remove the year.');
    return h('div.list', r.results.map((m) => h('div.list-row',
      h('div', { style: { width: '54px', flex: 'none' } }, m.poster ? h('img', { src: m.poster, alt: '', style: { width: '54px', borderRadius: '4px' } }) : null),
      h('div.grow', h('div.title', `${m.title}${m.year ? ` (${m.year})` : ''}`), h('div.sub', (m.overview || '').slice(0, 160))),
      h('button.btn.btn-sm', {
        onClick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api.post(`/api/items/${item.id}/match`, { tmdbId: m.tmdbId });
            dlg.close();
            toast('Match updated');
            render();
          } catch (err) {
            toastError(err);
            e.currentTarget.disabled = false;
          }
        },
      }, 'Choose'),
    )));
  });
  const dlg = modal({
    title: 'Fix match',
    wide: true,
    body: h('div',
      h('form', { onSubmit: (e) => { e.preventDefault(); search(); } },
        h('div.input-row', q, year, h('button.btn.btn-primary', { type: 'submit' }, icon('search', 18), 'Search'))),
      results),
  });
  search();
}

// ---------- movie ----------

function movieView({ item }) {
  const media = item.media;
  return h('div.detail',
    // No fanart? A frame from the movie still beats an empty header.
    backdrop(item.images.backdrop || item.images.thumb),
    h('div.detail-body',
      h('div.detail-top',
        posterBlock(item.images.poster || item.images.thumb, { title: item.title }),
        h('div.detail-info',
          h('h1', item.title),
          metaLine([
            item.year && h('span', String(item.year)),
            item.contentRating && h('span.pill', item.contentRating),
            item.duration && h('span', formatDuration(item.duration)),
            ...qualityPills(item),
            ratingEl(item.rating),
          ]),
          item.genres?.length ? h('div.genres', item.genres.join(' · ')) : null,
          h('div.detail-actions', playButtons(item), watchedButton(item), isAdmin() && editButton(item), moreButton(item, media)),
          item.tagline && h('div.tagline', item.tagline),
          overviewEl(item.overview),
          credits(item),
          mediaChips(media, item),
        ),
      ),
      castSection(item.cast, item.id),
    ),
  );
}

/** The film's picture quality; one badge per copy when there's more than one (SD and 1080p, say), best first. */
function qualityPills(item) {
  const labels = item.versions?.length ? [...new Set(item.versions.map((v) => v.label))] : [item.videoResolution];
  return labels.filter(Boolean).map((l) => h('span.pill', l));
}

// ---------- show ----------

function showView({ item, children, onDeck }) {
  const seasonsCount = children.length;
  const unwatched = (item.leafCount || 0) - (item.viewedLeafCount || 0);
  const playLabel = onDeck ? `${onDeck.state?.position ? 'Resume' : 'Play'} ${episodeLabel(onDeck)}` : 'Play';
  return h('div.detail',
    backdrop(item.images.backdrop),
    h('div.detail-body',
      h('div.detail-top',
        posterBlock(item.images.poster, { title: item.title }),
        h('div.detail-info',
          h('h1', item.title),
          metaLine([
            item.year && h('span', String(item.year)),
            item.contentRating && h('span.pill', item.contentRating),
            h('span', `${seasonsCount} season${seasonsCount === 1 ? '' : 's'}`),
            h('span', `${item.leafCount} episode${item.leafCount === 1 ? '' : 's'}${unwatched && unwatched !== item.leafCount ? ` · ${unwatched} unwatched` : ''}`),
            ratingEl(item.rating),
          ]),
          item.genres?.length ? h('div.genres', item.genres.join(' · ')) : null,
          h('div.detail-actions',
            onDeck && h('a.btn.btn-primary.btn-lg', { href: playUrl(onDeck) }, icon('play', 20), playLabel),
            watchedButton(item),
            isAdmin() && editButton(item),
            moreButton(item, null),
          ),
          item.tagline && h('div.tagline', item.tagline),
          overviewEl(item.overview),
          credits(item),
        ),
      ),
      h('div.section', h('h3', 'Seasons'), h('div.grid', children.map((s) => posterCard(s)))),
      castSection(item.cast, item.id),
    ),
  );
}

// ---------- season ----------

/** Episode still that plays on click, with watched / progress badges. */
function episodeThumb(ep, width) {
  const pos = ep.state?.position;
  return h('a.card', { href: playUrl(ep), title: `Play ${ep.title}` },
    h('div.card-img',
      lazyImg(ep.images.thumb, { width, fallback: () => h('div.card-placeholder', icon('tv', 24)) }),
      h('div.card-overlay', h('div.play-circle', icon('play', 22))),
      ep.state?.watched && !pos ? h('div.watched-flag', icon('check', 14)) : null,
      pos && ep.duration ? h('div.progress', h('div', { style: { width: `${Math.min(100, (pos / ep.duration) * 100)}%` } })) : null,
    ));
}

const episodeTitle = (ep) => h('a', { href: `/item/${ep.id}`, title: ep.title }, `${ep.episodeNumber != null ? `${ep.episodeNumber}. ` : ''}${ep.title}`);
const episodeMeta = (ep) => [formatDuration(ep.duration), ep.airDate && formatDate(ep.airDate), ep.videoResolution].filter(Boolean).join(' · ');

function episodeRow(ep) {
  return h('div.episode-row',
    episodeThumb(ep, 240),
    h('div.episode-info',
      h('div.ep-title', episodeTitle(ep)),
      h('div.ep-meta', episodeMeta(ep)),
      ep.overview && h('div.ep-overview', ep.overview),
    ),
  );
}

function episodeTile(ep) {
  return h('div.episode-tile',
    episodeThumb(ep, 400),
    h('div.ep-title', episodeTitle(ep)),
    h('div.ep-meta', episodeMeta(ep)),
  );
}

const EPISODE_LAYOUTS = [
  { id: 'list', label: 'List', icon: 'list' },
  { id: 'grid', label: 'Grid', icon: 'grid' },
];

/** Episodes as a detailed list or a grid of stills; the choice is remembered for every season. */
function episodesBlock(episodes) {
  const host = h('div');
  const buttons = EPISODE_LAYOUTS.map((l) => h('button', {
    type: 'button', title: `${l.label} view`, 'aria-label': `${l.label} view`, onClick: () => show(l.id, true),
  }, icon(l.icon, 18)));
  const show = (layout, save) => {
    if (save) setPrefs({ episodeLayout: layout });
    buttons.forEach((b, i) => {
      const on = EPISODE_LAYOUTS[i].id === layout;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    setChildren(host, layout === 'grid'
      ? h('div.episode-grid', episodes.map(episodeTile))
      : h('div.episode-list', episodes.map(episodeRow)));
  };
  show(getPrefs().episodeLayout === 'grid' ? 'grid' : 'list', false);
  return { toggle: h('div.view-toggle', { role: 'group', 'aria-label': 'Episode layout' }, buttons), list: host };
}

function seasonView({ item, children, show, seasons, onDeck }) {
  const episodes = episodesBlock(children);
  return h('div.detail',
    backdrop(item.images.backdrop),
    h('div.detail-body',
      h('div.detail-top',
        posterBlock(item.images.poster, { title: item.title }),
        h('div.detail-info',
          show && h('a.crumb', { href: `/item/${show.id}` }, show.title),
          h('h1', item.title),
          metaLine([
            item.year && h('span', String(item.year)),
            h('span', `${item.leafCount} episode${item.leafCount === 1 ? '' : 's'}`),
          ]),
          h('div.detail-actions',
            onDeck && h('a.btn.btn-primary.btn-lg', { href: playUrl(onDeck) }, icon('play', 20), `${onDeck.state?.position ? 'Resume' : 'Play'} ${episodeLabel(onDeck)}`),
            watchedButton(item),
            isAdmin() && editButton(item),
            moreButton(item, null),
          ),
          overviewEl(item.overview),
        ),
      ),
      h('div.section',
        h('div.season-bar',
          seasons?.length > 1 && h('div.season-tabs', seasons.map((s) => h(`a${s.id === item.id ? '.active' : ''}`, { href: `/item/${s.id}` }, s.title))),
          children.length > 0 && episodes.toggle),
        episodes.list,
      ),
      // Seasons have no cast of their own in the metadata: show the series cast under the episodes.
      castSection(show?.cast, show?.id),
    ),
  );
}

// ---------- episode ----------

function episodeView({ item, show, season, prev, next }) {
  const media = item.media;
  return h('div.detail',
    backdrop(item.images.backdrop),
    h('div.detail-body',
      h('div.detail-top',
        posterBlock(item.images.thumb, { landscape: true, title: item.title }),
        h('div.detail-info',
          show && h('a.crumb', { href: `/item/${show.id}` }, show.title),
          h('h1', item.title),
          h('h2.sub', [season && h('a', { href: `/item/${season.id}` }, season.title), item.episodeNumber != null && ` · Episode ${item.episodeNumber}${item.episodeEnd ? `–${item.episodeEnd}` : ''}`]),
          metaLine([
            item.airDate && h('span', formatDate(item.airDate)),
            item.duration && h('span', formatDuration(item.duration)),
            item.videoResolution && h('span.pill', item.videoResolution),
            ratingEl(item.rating),
          ]),
          h('div.detail-actions', playButtons(item), watchedButton(item), isAdmin() && editButton(item), moreButton(item, media)),
          overviewEl(item.overview),
          mediaChips(media, item),
          h('div.episode-nav',
            prev && h('a.btn', { href: `/item/${prev.id}` }, icon('chevronLeft', 18), `Previous: ${episodeLabel(prev)}`),
            next && h('a.btn', { href: `/item/${next.id}` }, `Next: ${episodeLabel(next)}`, icon('chevronRight', 18)),
          ),
        ),
      ),
    ),
  );
}
