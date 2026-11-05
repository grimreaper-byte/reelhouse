// The live TV player: a channel from Tvheadend, converted by the server into a live stream (server/transcode/live.js).
// It looks like the film player but has no seek bar: pausing keeps up to five minutes, the Live button jumps back to
// now, and the channel buttons (or Page Up / Page Down) change channel without leaving the player. The channel's
// logo sits in the corner of the control bar. A radio station shows its logo and programme instead of a picture,
// and its buttons change between radio stations.
import { h, icon, clear, setChildren } from '../dom.js';
import { api } from '../api.js';
import { browserCaps } from '../caps.js';
import { back } from '../router.js';
import { preferredQuality, savePreferredQuality, getPrefs, setPrefs } from '../state.js';
import { toast } from '../components.js';
import { loadHls } from '../hls-loader.js';
import { channelLogo } from './livetv.js';

const REPORT_EVERY_MS = 10000;
const HIDE_CONTROLS_MS = 3000;
const AT_LIVE_SECONDS = 10; // nearer the live edge than this counts as watching live

const timeOf = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export async function livePlayerView(ctx) {
  const [{ channels }, { qualities }] = await Promise.all([
    api.get('/api/livetv/channels', { signal: ctx.signal }),
    api.get('/api/qualities', { signal: ctx.signal }),
  ]);
  const channel = channels.find((c) => c.uuid === ctx.params.channel);
  if (!channel) {
    back(ctx.path.startsWith('/radio') ? '/radio' : '/livetv');
    return h('div');
  }
  const player = new LivePlayer({ channels, channel, qualities });
  ctx.onCleanup(() => player.destroy());
  return player.root;
}

class LivePlayer {
  constructor({ channels, channel, qualities }) {
    this.channels = channels;
    this.channel = channel;
    this.radio = !!channel.radio;
    this.qualities = qualities;
    this.quality = preferredQuality();
    this.info = null;
    this.hls = null;
    this.restarts = 0;
    this.startSeq = 0;
    this.destroyed = false;
    this.panel = null;
    this.build();
    this.bind();
    void this.start();
  }

  build() {
    const prefs = getPrefs();
    this.video = h('video', { playsinline: true, autoplay: true });
    this.video.volume = prefs.volume ?? 1;
    this.video.muted = !!prefs.muted;
    this.centerEl = h('div.player-center');
    this.msgEl = h('div.player-msg', { hidden: true });
    this.panelEl = h('div.player-panel', { hidden: true });
    this.titleEl = h('div.live-title');
    this.barLogoEl = h('div.bar-logo');
    this.radioEl = h('div.radio-card', { hidden: true });
    this.nameEl = h('div.t1');
    this.nowEl = h('div.t2');
    this.progEl = h('div.live-prog', h('div'));
    this.nextEl = h('div.live-next');
    this.playBtn = h('button.pbtn.play-main', { 'aria-label': 'Pause', title: 'Play/pause (Space)', onClick: () => this.togglePlay() }, icon('pause', 26));
    this.liveBtn = h('button.live-btn', { title: 'Back to live (L)', onClick: () => this.goLive() }, h('span.dot'), 'Live');
    this.muteBtn = h('button.pbtn', { 'aria-label': 'Mute', title: 'Mute (M)', onClick: () => this.toggleMute() }, icon(this.video.muted ? 'mute' : 'volume', 22));
    this.volumeRange = h('input.vol-range', {
      type: 'range', min: '0', max: '1', step: '0.05', value: String(this.video.muted ? 0 : this.video.volume), 'aria-label': 'Volume', 'aria-orientation': 'vertical',
      onInput: (e) => {
        this.video.volume = Number(e.target.value);
        this.video.muted = this.video.volume === 0;
      },
    });
    this.volumeEl = h('div.volume', h('div.vol-pop', h('div.vol-track', this.volumeRange)), this.muteBtn);
    const pipBtn = document.pictureInPictureEnabled
      ? h('button.pbtn.hide-sm.tv-only', { 'aria-label': 'Picture in picture', title: 'Picture in picture', onClick: () => this.togglePip() }, icon('pip', 22))
      : null;

    this.root = h('div.player.live-player',
      this.video,
      this.radioEl,
      this.centerEl,
      h('div.player-top',
        h('button.pbtn', { 'aria-label': 'Back to the guide', title: 'Back (Esc)', onClick: () => back(this.home()) }, icon('arrowLeft', 24)),
        this.titleEl,
      ),
      h('div.player-bottom',
        h('div.controls',
          h('div.ctl-info.live-info', this.barLogoEl, h('div.live-text', this.nameEl, this.nowEl, this.progEl, this.nextEl)),
          h('div.ctl-side.ctl-before',
            h('button.pbtn', { 'aria-label': 'Previous channel', title: 'Previous (Page Down)', onClick: () => this.zap(-1) }, icon('chevronDown', 24))),
          this.playBtn,
          h('div.ctl-side.ctl-after',
            h('button.pbtn', { 'aria-label': 'Next channel', title: 'Next (Page Up)', onClick: () => this.zap(1) }, icon('chevronUp', 24)),
            this.liveBtn),
          h('div.ctl-tools',
            h('button.pbtn.tv-only', { 'aria-label': 'Quality', title: 'Quality', onClick: () => this.toggleQuality() }, icon('settings', 22)),
            pipBtn,
            h('button.pbtn.tv-only', { 'aria-label': 'Fullscreen', title: 'Fullscreen (F)', onClick: () => this.toggleFullscreen() }, icon('fullscreen', 22)),
            this.volumeEl),
        ),
      ),
      this.panelEl,
      this.msgEl,
    );
    this.setRadio(this.radio);
    this.renderChannel();
    this.setSpinner(true);
  }

  /** Where Back goes: the guide this channel belongs to. */
  home() {
    return this.radio ? '/radio' : '/livetv';
  }

  /** Radio: no picture, so the station's logo and programme fill the screen, and the controls stay. */
  setRadio(on) {
    this.radio = on;
    this.root.classList.toggle('radio-mode', on);
    this.radioEl.hidden = !on;
    if (on) this.root.classList.remove('idle');
  }

  bind() {
    const v = this.video;
    const on = (el, ev, fn, opts) => {
      el.addEventListener(ev, fn, opts);
      (this.unbinders ||= []).push(() => el.removeEventListener(ev, fn, opts));
    };
    on(v, 'playing', () => {
      this.setSpinner(false);
      this.hideMessage();
      this.updatePlayState();
      clearTimeout(this.healthyTimer);
      this.healthyTimer = setTimeout(() => { this.restarts = 0; }, 15000);
    });
    on(v, 'play', () => this.updatePlayState());
    on(v, 'pause', () => {
      this.updatePlayState();
      this.report('paused');
    });
    on(v, 'waiting', () => this.setSpinner(true));
    on(v, 'timeupdate', () => this.onTime());
    on(v, 'volumechange', () => {
      this.muteBtn.replaceChildren(icon(v.muted || v.volume === 0 ? 'mute' : 'volume', 22));
      this.volumeRange.value = String(v.muted ? 0 : v.volume);
      setPrefs({ volume: v.volume, muted: v.muted });
    });
    on(this.root, 'pointermove', () => this.poke());
    on(this.root, 'click', (e) => {
      if (e.target === this.video) this.toggleControls();
    });
    on(document, 'keydown', (e) => this.onKey(e));
    // A closed tab or a reload: Tvheadend's tuner is let go now rather than when the player goes quiet.
    on(window, 'pagehide', () => this.report('stopped', { keepalive: true }));
    this.reportTimer = setInterval(() => this.report(this.video.paused ? 'paused' : 'playing'), REPORT_EVERY_MS);
    // Paused, the picture sends no time updates, but live TV carries on: the Live button says how far behind it is.
    this.behindTimer = setInterval(() => {
      if (this.video.paused) this.onTime();
    }, 2000);
    this.poke();
  }

  renderChannel() {
    const c = this.channel;
    setChildren(this.titleEl, `${c.number ? `${c.number} · ` : ''}${c.name}`);
    setChildren(this.barLogoEl, channelLogo(c));
    this.nameEl.textContent = this.info?.now?.title || c.name;
    this.renderNow();
  }

  renderNow() {
    const now = this.info?.now;
    const next = this.info?.next;
    const t = Date.now() / 1000;
    this.nameEl.textContent = now?.title || this.channel.name;
    this.nowEl.textContent = now ? `${this.channel.name} · ${timeOf(now.start)}–${timeOf(now.stop)}${now.subtitle ? ` · ${now.subtitle}` : ''}` : 'No guide information';
    this.progEl.hidden = !now;
    if (now) this.progEl.firstChild.style.width = `${Math.min(100, Math.max(0, ((t - now.start) / (now.stop - now.start)) * 100))}%`;
    this.nextEl.textContent = next ? `Next: ${timeOf(next.start)} ${next.title}` : '';
    document.title = `${now?.title ? `${now.title} · ` : ''}${this.channel.name} · ${this.radio ? 'Radio' : 'Live TV'}`;
    if (this.radio) {
      const pct = now ? Math.min(100, Math.max(0, ((t - now.start) / (now.stop - now.start)) * 100)) : 0;
      setChildren(this.radioEl,
        h('div.radio-logo', channelLogo(this.channel)),
        h('div.radio-station', `${this.channel.number ? `${this.channel.number} · ` : ''}${this.channel.name}`),
        now ? [
          h('div.radio-now', now.title),
          h('div.radio-time', `${timeOf(now.start)}–${timeOf(now.stop)}${now.subtitle ? ` · ${now.subtitle}` : ''}`),
          h('div.radio-prog', h('div', { style: { width: `${pct}%` } })),
          (now.description || now.summary) && h('p.radio-desc', now.description || now.summary),
        ] : h('div.radio-time', 'No guide information'),
        next && h('div.radio-next', `Next: ${timeOf(next.start)} ${next.title}`));
    }
  }

  async start() {
    const seq = ++this.startSeq;
    const stale = () => this.destroyed || seq !== this.startSeq;
    this.setSpinner(true);
    this.hideMessage();
    const previousSession = this.info?.playId;
    this.teardownMedia();
    let info;
    try {
      info = await api.post(`/api/livetv/play/${this.channel.uuid}`, { caps: browserCaps(), quality: this.quality, previousSession });
    } catch (err) {
      if (stale()) return;
      this.info = null;
      this.showMessage('Can’t play this channel', err.message, [{ label: 'Try again', primary: true, onClick: () => this.start() }]);
      return;
    }
    if (stale()) {
      api.del(`/api/live/${info.playId}`).catch(() => {});
      return;
    }
    this.info = info;
    // Found to be radio as it started (Tvheadend hadn't said): show it as a station.
    if (!!info.radio !== this.radio) this.setRadio(!!info.radio);
    this.renderNow();
    this.scheduleNowRefresh();
    const caps = browserCaps();
    const Hls = caps.mse ? await loadHls().catch(() => null) : null;
    if (stale()) return;
    if (Hls?.isSupported()) {
      this.attachHls(Hls, info.url);
    } else if (caps.nativeHls) {
      this.video.src = info.url;
    } else {
      this.showMessage('Unsupported browser', 'This browser can’t play live streams.', []);
      return;
    }
    try {
      await this.video.play();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        this.setSpinner(false);
        this.centerEl.replaceChildren(h('button.big-play', { 'aria-label': 'Play', onClick: () => this.togglePlay() }, icon('play', 36)));
      }
    }
  }

  attachHls(Hls, url) {
    const hls = new Hls({
      // A few segments behind the newest, so short hiccups don't stall; up to five minutes kept for pausing.
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 12,
      maxBufferLength: 30,
      backBufferLength: 300,
      manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 20000, maxLoadTimeMs: 30000, timeoutRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 }, errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 } } },
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (this.hls !== hls || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.mediaRecovered) {
        this.mediaRecovered = true;
        hls.recoverMediaError();
        return;
      }
      console.warn('[live] stream error:', data.type, data.details, data.response?.code || '');
      this.retryOrFail();
    });
    hls.loadSource(url);
    hls.attachMedia(this.video);
    this.hls = hls;
    this.mediaRecovered = false;
  }

  /** The stream broke (the server ended it, or the connection dropped): start the channel again, a few times. */
  retryOrFail() {
    if (this.restarts < 3) {
      this.restarts++;
      void this.start();
    } else {
      this.showMessage(this.radio ? 'Radio stopped' : 'Live TV stopped', 'The stream failed repeatedly.', [{ label: 'Try again', primary: true, onClick: () => { this.restarts = 0; this.start(); } }]);
    }
  }

  /** What's on now and next, again once the current programme ends. */
  scheduleNowRefresh() {
    clearTimeout(this.nowTimer);
    const stop = this.info?.now?.stop;
    const wait = stop ? Math.max(5000, stop * 1000 - Date.now() + 2000) : 5 * 60 * 1000;
    this.nowTimer = setTimeout(async () => {
      try {
        const fresh = await api.get(`/api/livetv/channels/${this.channel.uuid}/now`);
        if (this.info) Object.assign(this.info, fresh);
        this.renderNow();
      } catch {
        // keep what's shown
      }
      this.scheduleNowRefresh();
    }, Math.min(wait, 30 * 60 * 1000));
    clearInterval(this.progTimer);
    this.progTimer = setInterval(() => this.renderNow(), 30000);
  }

  /** The next or previous channel of the same kind: TV channels skip radio stations, and the other way round. */
  zap(step) {
    const list = this.channels.filter((c) => !!c.radio === this.radio || c.uuid === this.channel.uuid);
    const i = list.findIndex((c) => c.uuid === this.channel.uuid);
    const next = list[(i + step + list.length) % list.length];
    if (!next || next.uuid === this.channel.uuid) return;
    this.channel = next;
    history.replaceState(history.state, '', this.radio ? `/radio/listen/${next.uuid}` : `/livetv/watch/${next.uuid}`);
    this.info = { ...this.info, now: null, next: null };
    this.renderChannel();
    this.osd(`${next.number ? `${next.number} ` : ''}${next.name}`);
    this.restarts = 0;
    void this.start();
  }

  liveEdge() {
    return this.hls?.liveSyncPosition ?? (this.video.seekable.length ? this.video.seekable.end(this.video.seekable.length - 1) : null);
  }

  goLive() {
    const edge = this.liveEdge();
    if (edge != null) this.video.currentTime = edge;
    if (this.video.paused) void this.video.play().catch(() => {});
  }

  onTime() {
    const edge = this.liveEdge();
    const behind = edge != null ? edge - this.video.currentTime : 0;
    this.liveBtn.classList.toggle('behind', behind > AT_LIVE_SECONDS);
    this.liveBtn.title = behind > AT_LIVE_SECONDS ? `${Math.round(behind / 60) || '<1'} min behind — back to live (L)` : 'Live';
  }

  togglePlay() {
    if (this.video.paused) {
      this.centerEl.querySelector('.big-play')?.remove();
      void this.video.play().catch(() => {});
    } else {
      this.video.pause();
    }
  }

  updatePlayState() {
    const paused = this.video.paused;
    this.playBtn.replaceChildren(icon(paused ? 'play' : 'pause', 26));
    this.playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    this.poke();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    if (!this.video.muted && this.video.volume === 0) this.video.volume = 0.5;
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (this.root.requestFullscreen) await this.root.requestFullscreen();
      else this.video.webkitEnterFullscreen?.();
    } catch {
      this.video.webkitEnterFullscreen?.();
    }
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  toggleQuality() {
    if (this.panel) return this.closePanel();
    this.panel = 'quality';
    this.panelEl.hidden = false;
    // What this channel offers (the server leaves out presets above it) and what it's converted at, which is the
    // original when the preferred quality is above this channel; the preference itself is kept for the next one.
    const offered = this.info?.qualities;
    const current = this.info?.quality || this.quality;
    setChildren(this.panelEl,
      h('div.pp-head', 'Quality'),
      this.qualities.filter((q) => !offered || offered.includes(q.id)).map((q) => h('button.pp-item', {
        'aria-pressed': String(q.id === current),
        onClick: () => {
          this.closePanel();
          if (q.id === current) return;
          this.quality = q.id;
          savePreferredQuality(q.id);
          void this.start();
        },
      }, h('span.tick', q.id === current ? icon('check', 18) : null), h('span', q.label))),
      h('div.pp-note', 'Live TV is always converted for the browser. Lower qualities suit slow connections.'));
    this.poke();
  }

  closePanel() {
    this.panel = null;
    this.panelEl.hidden = true;
    this.poke();
  }

  onKey(e) {
    if (e.target.closest?.('input, select, textarea') && e.target.type !== 'range') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const handled = () => {
      e.preventDefault();
      this.poke();
    };
    switch (e.key) {
      case ' ': case 'k': case 'K': handled(); this.togglePlay(); break;
      case 'f': case 'F': handled(); void this.toggleFullscreen(); break;
      case 'm': case 'M': handled(); this.toggleMute(); break;
      case 'l': case 'L': handled(); this.goLive(); break;
      case 'PageUp': case '.': handled(); this.zap(1); break;
      case 'PageDown': case ',': handled(); this.zap(-1); break;
      case 'ArrowUp': handled(); this.video.volume = Math.min(1, this.video.volume + 0.05); this.video.muted = false; break;
      case 'ArrowDown': handled(); this.video.volume = Math.max(0, this.video.volume - 0.05); break;
      case 'Escape':
        if (this.panel) {
          handled();
          this.closePanel();
        } else if (!document.fullscreenElement) {
          handled();
          back(this.home());
        }
        break;
      default:
    }
  }

  report(state, { keepalive = false } = {}) {
    if (!this.info?.playId) return;
    api.post('/api/livetv/progress', { playId: this.info.playId, state }, { keepalive }).catch(() => {});
  }

  setSpinner(on) {
    if (on) {
      if (!this.centerEl.querySelector('.spinner') && !this.centerEl.querySelector('.big-play')) this.centerEl.replaceChildren(h('div.spinner'));
    } else if (this.centerEl.querySelector('.spinner')) {
      clear(this.centerEl);
    }
  }

  showMessage(title, text, actions) {
    this.setSpinner(false);
    this.msgEl.replaceChildren(
      h('h3', title),
      h('p', text),
      h('div.btn-row', { style: { justifyContent: 'center' } },
        actions.map((a) => h(`button.btn${a.primary ? '.btn-primary' : ''}`, { onClick: a.onClick }, a.label)),
        h('button.btn', { onClick: () => back(this.home()) }, this.radio ? 'Back to Radio' : 'Back to the guide')),
    );
    this.msgEl.hidden = false;
  }

  hideMessage() {
    this.msgEl.hidden = true;
  }

  osd(text) {
    this.osdEl?.remove();
    this.osdEl = h('div.osd', text);
    this.root.append(this.osdEl);
    const el = this.osdEl;
    setTimeout(() => el.remove(), 1200);
  }

  poke() {
    this.root.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // Radio has no picture to keep clear: its controls stay.
      if (!this.video.paused && !this.panel && !this.radio) this.root.classList.add('idle');
    }, HIDE_CONTROLS_MS);
  }

  toggleControls() {
    if (this.root.classList.contains('idle')) this.poke();
    else if (!this.video.paused) this.root.classList.add('idle');
  }

  teardownMedia() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute('src');
    this.video.load();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    // Stopping frees Tvheadend's tuner straight away.
    this.report('stopped', { keepalive: true });
    clearInterval(this.reportTimer);
    clearInterval(this.behindTimer);
    clearInterval(this.progTimer);
    clearTimeout(this.nowTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.healthyTimer);
    for (const fn of this.unbinders || []) fn();
    this.teardownMedia();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    document.title = 'Reelhouse';
  }
}
