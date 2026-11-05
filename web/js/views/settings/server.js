// General, Transcoder and Metadata settings tabs.
import { h, icon } from '../../dom.js';
import { api } from '../../api.js';
import { toast, statusPill } from '../../components.js';
import { refreshLibraries } from '../../app.js';
import { state } from '../../state.js';
import { render } from '../../router.js';
import { panel, textField, selectField, checkField, saveButton, actionButton, loadSettings } from './form.js';

export async function generalTab(ctx) {
  const { settings: s } = await loadSettings(ctx.signal);
  const name = textField('Server name', s.serverName, { hint: 'Shown on the sign-in page.' });
  const port = textField('Port', s.port, { type: 'number', min: 1, max: 65535, hint: 'The web address will change to the new port right after saving.' });
  const downloads = checkField('Allow downloads', s.allowDownloads, { hint: 'Lets signed-in users download the original files.' });
  const interval = textField('Scan libraries every (minutes)', s.scanIntervalMinutes, { type: 'number', min: 0, hint: '0 turns periodic scanning off.' });
  const watch = checkField('Watch library folders for changes', s.watchFolders, { hint: 'New files appear within a minute without waiting for the next scan.' });
  const trustProxy = checkField('Behind a reverse proxy', s.trustProxy, { hint: 'Only enable if you run Caddy/nginx in front of Reelhouse. Takes effect after a restart.' });
  // The masked key (or nothing): finding films to ask for needs one, so without it Requests is off and the box says so.
  const noKey = !s.tmdbApiKey;
  const requests = checkField('Let people request movies', s.requestsEnabled && !noKey, {
    disabled: noKey,
    hint: 'Adds Requests to the sidebar, where anyone signed in can ask for a movie that isn’t on the server and see what others asked for. Turned off, it’s hidden for everyone and the list is kept.',
  });
  const requestsLimit = textField('Most requests waiting per person', s.requestsLimit || 0, {
    type: 'number', min: 0, max: 1000,
    hint: '0 for no limit. Admins aren’t limited. A request stops counting once its film arrives or it’s removed.',
  });

  return h('div',
    h('h2', 'General'),
    h('p.lead', 'Basic server settings.'),
    panel('Server', null, name.el, port.el, downloads.el,
      h('div.panel-actions', saveButton('Save', () => ({ serverName: name.value, port: port.value, allowDownloads: downloads.value }), {
        after: (res) => {
          // The tab's title shows the name: follow a rename (other open tabs and apps pick it up when they next load).
          if (res.changed.includes('serverName')) {
            state.server.name = res.settings.serverName;
            document.title = `Reelhouse · ${state.server.name}`;
          }
          if (res.changed.includes('port')) {
            toast(`Moving to port ${port.value}…`);
            setTimeout(() => {
              location.href = `${location.protocol}//${location.hostname}:${port.value}/settings/general`;
            }, 1500);
          }
        },
      }))),
    panel('Requests',
      h('span', 'Requests uses TMDB to find movies, which needs a free TMDB API key: get one from ',
        h('a', { href: 'https://www.themoviedb.org/settings/api', target: '_blank', rel: 'noopener' }, 'themoviedb.org'),
        ' and add it in ', h('a', { href: '/settings/metadata' }, 'Settings → Metadata'), '.'),
      noKey && h('div.callout', h('strong', 'No TMDB API key yet,'), ' so Requests is off. ',
        s.requestsEnabled ? 'Once a key is added it turns on by itself, and you can turn it off here.' : 'Once a key is added you can turn it on here.'),
      requests.el, requestsLimit.el,
      // Without a key the box isn't a choice: what's saved stays for when one is added.
      h('div.panel-actions', saveButton('Save', () => ({ ...(noKey ? {} : { requestsEnabled: requests.value }), requestsLimit: requestsLimit.value })))),
    panel('Library scanning', null, interval.el, watch.el,
      h('div.panel-actions', saveButton('Save', () => ({ scanIntervalMinutes: interval.value, watchFolders: watch.value }), {
        after: () => refreshLibraries(),
      }))),
    panel('Advanced', null, trustProxy.el,
      h('div.panel-actions', saveButton('Save', () => ({ trustProxy: trustProxy.value })))),
  );
}

export async function transcoderTab(ctx) {
  const [{ settings: s, options }, status] = await Promise.all([
    loadSettings(ctx.signal),
    api.get('/api/admin/status', { signal: ctx.signal }),
  ]);
  const ff = status.ffmpeg || {};
  const encoder = selectField('Video encoder', options.encoders.map((e) => ({
    id: e.id,
    label: `${e.label}${ff.encoders && ff.encoders[e.id] === false ? ' — not available' : ff.encoders?.[e.id] ? ' ✓' : ''}`,
  })), s.encoder, { hint: 'Hardware encoders convert video much faster and use less CPU. Only working encoders are marked ✓.' });
  const vaapi = status.os === 'linux'
    ? textField('VAAPI device', s.vaapiDevice, { mono: true, hint: 'Render node used by the VAAPI encoder (Intel/AMD GPUs). In Docker, pass it through with “devices: /dev/dri:/dev/dri”.' })
    : null;
  const preset = selectField('Software encoder speed', ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].map((p) => ({ id: p, label: p })), s.x264Preset, { hint: 'Faster = less CPU, slightly lower quality. Applies to libx264 only.' });
  const max = textField('Maximum simultaneous conversions', s.maxTranscodes, { type: 'number', min: 0, hint: '0 = unlimited.' });
  const tonemap = checkField('Convert HDR to SDR when transcoding', s.tonemapHdr, { hint: ff.filters?.zscale ? 'Keeps colors correct for HDR movies on normal screens.' : 'Your ffmpeg build lacks the zscale filter, so this has no effect.' });
  const remoteQuality = selectField('Default quality outside your home network', options.qualities.map((q) => ({ id: q.id, label: q.label })), s.remoteQuality, { hint: 'Remote viewers start at this quality (they can change it in the player). Pick something your upload speed can sustain.' });
  const dir = textField('Temporary folder for conversions', s.transcodeDir, { placeholder: 'Default (inside the data folder)', hint: 'A fast SSD helps. Reelhouse works in a “reelhouse-transcode” subfolder and cleans it up automatically.' });
  const ffmpegPath = textField('ffmpeg path', s.ffmpegPath, { placeholder: 'ffmpeg (from PATH)', mono: true });
  const ffprobePath = textField('ffprobe path', s.ffprobePath, { placeholder: 'ffprobe (from PATH)', mono: true });
  const capsBox = h('dl.kv',
    h('dt', 'ffmpeg'), h('dd', ff.error ? statusPill(false, ff.error) : ff.ffmpeg || '—'),
    h('dt', 'Encoders'), h('dd', Object.entries(ff.encoders || {}).filter(([, ok]) => ok).map(([k]) => k).join(', ') || '—'),
    h('dt', 'HDR tone mapping'), h('dd', ff.filters?.zscale && ff.filters?.tonemap ? 'Supported' : 'Not supported'),
  );
  const detectAgain = actionButton('Detect again', async () => {
    await api.post('/api/admin/ffmpeg/detect');
    toast('Detection finished');
    render();
  }, { icon: icon('refresh', 16) });
  return h('div',
    h('h2', 'Transcoder'),
    h('p.lead', 'When a device can’t play a file as-is, Reelhouse converts it on the fly with ffmpeg.'),
    gpuPanel(ff.gpu, status.container, detectAgain),
    panel('Conversion', null, encoder.el, vaapi?.el, preset.el, max.el, tonemap.el, remoteQuality.el, dir.el,
      h('div.panel-actions', saveButton('Save', () => ({
        encoder: encoder.value,
        ...(vaapi ? { vaapiDevice: vaapi.value } : {}),
        x264Preset: preset.value,
        maxTranscodes: max.value,
        tonemapHdr: tonemap.value,
        remoteQuality: remoteQuality.value,
        transcodeDir: dir.value,
      })))),
    panel('ffmpeg', 'Reelhouse needs ffmpeg and ffprobe. Leave the paths empty to use the ones on your PATH.',
      capsBox, h('div', { style: { height: '16px' } }), ffmpegPath.el, ffprobePath.el,
      h('div.panel-actions',
        saveButton('Save', () => ({ ffmpegPath: ffmpegPath.value, ffprobePath: ffprobePath.value })),
      )),
  );
}

const LEVEL_PILL = {
  ok: () => statusPill(true, 'Working'),
  warn: () => statusPill('warn', 'Needs attention'),
  info: () => statusPill(null, 'Note'),
};

const IGPU_LABEL = { true: 'has integrated graphics', false: 'no integrated graphics', null: '' };

function gpuPanel(gpu, container, detectAgain) {
  const gpus = gpu?.gpus || [];
  const findings = gpu?.findings || [];
  const cpu = gpu?.cpu;
  return panel('Hardware acceleration',
    container
      ? 'Graphics chips this container can use for converting video. GPUs must be passed in from the host.'
      : 'Graphics chips Reelhouse can use for converting video.',
    h('dl.kv', { style: { marginBottom: '14px' } },
      cpu && [h('dt', 'Processor'), h('dd', [cpu.name, IGPU_LABEL[cpu.integratedGraphics]].filter(Boolean).join(' · '))],
      gpus.map((g) => [h('dt', g.vendor ? `${g.vendor} GPU` : 'GPU'), h('dd', `${g.name}${g.driver ? ` · driver ${g.driver}` : ''}`)]),
      !gpus.length && [h('dt', 'GPU'), h('dd', container ? 'None visible inside the container' : 'None detected')],
    ),
    h('div.list', findings.map((f) => h('div.list-row',
      LEVEL_PILL[f.level]?.() || null,
      h('div.grow', h('div.title', f.text), f.hint && h('div.hint', f.hint)),
    ))),
    h('p.hint', { style: { marginTop: '12px' } }, 'Setup guides for Docker, Proxmox, TrueNAS, OpenMediaVault and Windows are in ', h('code', 'docs/gpu.md'), ' in the Reelhouse folder.'),
    h('div.panel-actions', detectAgain),
  );
}

export async function metadataTab(ctx) {
  const [{ settings: s }, { libraries }] = await Promise.all([
    loadSettings(ctx.signal),
    api.get('/api/libraries', { signal: ctx.signal }),
  ]);
  const key = textField('TMDB API key', s.tmdbApiKey, { secret: true, hint: 'Either the "API Key" or the "API Read Access Token" from your TMDB account settings.' });
  const lang = textField('Metadata language', s.metadataLanguage, { placeholder: 'en-US', hint: 'Language and region code, e.g. en-US, de-DE, fr-FR, es-MX.' });
  const local = checkField('Prefer local artwork', s.preferLocalArtwork, { hint: 'Use poster.jpg / fanart.jpg next to your files instead of downloaded images.' });
  return h('div',
    h('h2', 'Metadata'),
    h('p.lead', 'Posters, descriptions, cast and ratings come from The Movie Database (TMDB). It’s free — you only need an API key.'),
    panel('The Movie Database',
      null,
      h('ol.steps',
        h('li', 'Create a free account at ', h('a', { href: 'https://www.themoviedb.org/signup', target: '_blank', rel: 'noopener', style: { color: 'var(--accent)' } }, 'themoviedb.org'), '.'),
        h('li', 'Open ', h('a', { href: 'https://www.themoviedb.org/settings/api', target: '_blank', rel: 'noopener', style: { color: 'var(--accent)' } }, 'Settings → API'), ' and request a developer key (personal use).'),
        h('li', 'Paste the key below and save. Your libraries refresh automatically.'),
      ),
      key.el, lang.el, local.el,
      h('div.panel-actions',
        saveButton('Save', () => ({ tmdbApiKey: key.input.value.trim(), metadataLanguage: lang.value || 'en-US', preferLocalArtwork: local.value })),
        actionButton('Test key', async () => {
          await api.post('/api/admin/tmdb/test');
          toast('The key works');
        }),
      )),
    libraries.length ? panel('Refresh', 'Re-download metadata for every item in a library (keeps your watch history).',
      h('div.list', libraries.map((l) => h('div.list-row',
        h('div.grow', h('div.title', l.name), h('div.sub', `${l.count} items`)),
        actionButton('Refresh all', async () => {
          await api.post(`/api/libraries/${l.id}/refresh-metadata`);
          toast(`Refreshing ${l.name}`);
        }),
      )))) : null,
    panel('Without an API key', null, h('p.hint', { style: { margin: 0 } },
      'Reelhouse still works: titles and years come from your file names, and it reads Kodi-style .nfo files and poster.jpg/fanart.jpg next to your media. Name files like ',
      h('code', 'Movies/Heat (1995)/Heat (1995).mkv'), ' and ', h('code', 'TV/Show Name/Season 01/Show Name - S01E01.mkv'), '.')),
  );
}
