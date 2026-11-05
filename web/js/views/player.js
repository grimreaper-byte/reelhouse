import { h, icon, clear, setChildren, formatTime, languageName, codecLabel, channelsLabel, episodeLabel, imgUrl } from '../dom.js';
import { api } from '../api.js';
import { browserCaps } from '../caps.js';
import { back, navigate } from '../router.js';
import { preferredQuality, savePreferredQuality, getPrefs, setPrefs } from '../state.js';
import { toast } from '../components.js';
import { loadHls } from '../hls-loader.js';
import { usableChapters, chapterIndex, nextChapter, previousChapter, chapterTitle, chapterLabel } from '../chapters.js';

const REPORT_EVERY_MS = 10000;
const HIDE_CONTROLS_MS = 3000;
const SYNC_STEP_MS = 50;
const SYNC_APPLY_DELAY_MS = 900; // let the user finish nudging before restarting a conversion
const ITEM_PREFS_KEY = 'reelhouse.itemPrefs';
const ITEM_PREFS_MAX = 300;

// Per-item choices worth remembering between plays: the audio track and sync offsets,
// as { audio: streamIndex, audioDelay: { [streamIndex]: ms }, subDelay: { [trackId]: ms } }.
function loadItemPrefs(itemId) {
  try {
    return JSON.parse(localStorage.getItem(ITEM_PREFS_KEY))?.[itemId] || {};
  } catch {
    return {};
  }
}

function saveItemPrefs(itemId, rec) {
  try {
    const all = JSON.parse(localStorage.getItem(ITEM_PREFS_KEY)) || {};
    all[itemId] = { ...rec, t: Date.now() };
    const ids = Object.keys(all);
    if (ids.length > ITEM_PREFS_MAX) {
      ids.sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
      for (const id of ids.slice(0, ids.length - ITEM_PREFS_MAX)) delete all[id];
    }
    localStorage.setItem(ITEM_PREFS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — the choices just won't be remembered
  }
}

/** Copy of a { key: ms } map with one entry set (zero removes it). */
function withDelay(map, key, ms) {
  const next = { ...map };
  if (ms) next[key] = ms;
  else delete next[key];
  return next;
}

const clampMs = (value, max) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(-max, Math.min(max, n)) : 0;
};

// iOS keeps the volume under the hardware buttons: setting it from a page is silently ignored.
const VOLUME_SETTABLE = (() => {
  try {
    const v = document.createElement('video');
    v.volume = 0.5;
    return v.volume === 0.5;
  } catch {
    return false;
  }
})();

const formatOffset = (ms) => (ms ? `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms` : '0 ms');

export async function playerView(ctx) {
  const [data, { qualities }] = await Promise.all([
    api.get(`/api/items/${ctx.params.id}`, { signal: ctx.signal }),
    api.get('/api/qualities', { signal: ctx.signal }),
  ]);
  if (!['movie', 'episode'].includes(data.item.type)) {
    navigate(`/item/${data.item.id}`, { replace: true });
    return h('div');
  }
  const player = new Player({ ...data, qualities, startAt: Number(ctx.query.t) || 0 });
  ctx.onCleanup(() => player.destroy());
  return player.root;
}

function trackLabel(t) {
  const parts = [languageName(t.language) || (t.external ? 'External' : 'Unknown')];
  if (t.title && !/^(sdh|forced)$/i.test(t.title)) parts.push(t.title);
  if (t.forced) parts.push('Forced');
  if (/sdh/i.test(t.title || '')) parts.push('SDH');
  parts.push(codecLabel(t.codec));
  return parts.join(' · ');
}

function audioLabel(a) {
  return [languageName(a.language) || 'Unknown', a.title, `${codecLabel(a.codec)} ${channelsLabel(a.channels)}`].filter(Boolean).join(' · ');
}

class Player {
  constructor({ item, show, qualities, startAt }) {
    this.item = item;
    this.show = show;
    this.qualities = qualities;
    this.info = null;
    this.hls = null;
    // Seconds to add to the video element's clock for the film's: a copied picture's stream starts with the film's
    // first keyframe, a little after 0 in some films (the server's timelineStart).
    this.timeShift = 0;
    this.destroyed = false;
    this.restarts = 0;
    this.mediaRecoveries = 0;
    this.forceTranscode = false;
    this.subtitle = null; // selected text track
    this.subsInitialized = false;
    this.lastReport = 0;
    this.dragging = false;
    this.showRemaining = false;
    this.panel = null;
    this.startSeq = 0;
    this.resumeAt = null; // position a (re)start will resume at, while the new stream loads
    const prefs = getPrefs();
    this.itemPrefs = loadItemPrefs(item.id);
    const audioIndex = this.itemPrefs.audio ?? null;
    this.prefs = {
      quality: preferredQuality(),
      audioIndex,
      burnSubtitle: null,
      // Positive = later, negative = earlier.
      audioOffsetMs: audioIndex != null ? this.itemPrefs.audioDelay?.[audioIndex] || 0 : 0,
      subtitleOffsetMs: 0,
    };
    this.build(prefs);
    this.bind();
    void this.start(startAt);
  }

  // ---------- DOM ----------

  build(prefs) {
    this.video = h('video', { playsinline: true, preload: 'auto', 'webkit-playsinline': true });
    this.video.volume = prefs.volume ?? 1;
    this.video.muted = !!prefs.muted;

    this.subsEl = h('div.subs', { 'aria-live': 'off' });
    this.centerEl = h('div.player-center');
    const isEp = this.item.type === 'episode';
    const t1 = isEp && this.show ? this.show.title : this.item.title;
    const t2 = isEp ? `${episodeLabel(this.item)} — ${this.item.title}` : this.item.year || '';

    this.playBtn = h('button.pbtn.play-main', { 'aria-label': 'Play', title: 'Play/pause (Space)', onClick: () => this.togglePlay() }, icon('play', 26));
    // Volume: a vertical slider that pops up above the speaker button (hover with a mouse, tap on
    // touch screens), so it needs no room in the bar. iOS ignores page volume, so it only gets mute.
    const touch = matchMedia('(pointer: coarse)').matches;
    this.muteBtn = h('button.pbtn', {
      'aria-label': 'Mute', title: 'Mute (M)',
      onClick: () => (touch && VOLUME_SETTABLE ? this.toggleVolumePopup() : this.toggleMute()),
    }, icon(this.video.muted ? 'mute' : 'volume', 22));
    const level = this.video.muted ? 0 : this.video.volume;
    this.volumeRange = h('input.vol-range', {
      type: 'range', min: '0', max: '1', step: '0.05', value: String(level),
      'aria-label': 'Volume', 'aria-orientation': 'vertical',
      onInput: (e) => {
        this.video.volume = Number(e.target.value);
        this.video.muted = this.video.volume === 0;
      },
    });
    this.volumeLabel = h('div.vol-label', String(Math.round(level * 100)));
    this.volumeEl = h('div.volume',
      VOLUME_SETTABLE && h('div.vol-pop', this.volumeLabel, h('div.vol-track', this.volumeRange)),
      this.muteBtn);
    this.timeNow = h('span', '0:00');
    this.timeTotal = h('span', ' / 0:00');
    this.timeEl = h('div.time', { title: 'Show time remaining', onClick: () => { this.showRemaining = !this.showRemaining; this.updateTime(); } }, this.timeNow, this.timeTotal);
    this.prevBtn = h('button.pbtn', { 'aria-label': 'Previous episode', title: 'Previous episode (P)', hidden: true, onClick: () => this.playPrev() }, icon('skipPrev', 22));
    this.nextBtn = h('button.pbtn', { 'aria-label': 'Next episode', title: 'Next episode (N)', hidden: true, onClick: () => this.playNext() }, icon('skipNext', 22));
    // Films (or episodes) with chapters in the file: jump between them.
    this.prevChapterBtn = h('button.pbtn', { 'aria-label': 'Previous chapter', title: 'Previous chapter (Page Up)', hidden: true, onClick: () => this.skipChapter(-1) }, icon('chapterPrev', 22));
    this.nextChapterBtn = h('button.pbtn', { 'aria-label': 'Next chapter', title: 'Next chapter (Page Down)', hidden: true, onClick: () => this.skipChapter(1) }, icon('chapterNext', 22));
    this.subsBtn = h('button.pbtn', { 'aria-label': 'Audio and subtitles', title: 'Audio & subtitles', onClick: () => this.togglePanel('av') }, icon('subtitles', 22));
    this.settingsBtn = h('button.pbtn', { 'aria-label': 'Playback settings', title: 'Settings', onClick: () => this.togglePanel('settings') }, icon('settings', 22));
    this.fsBtn = h('button.pbtn', { 'aria-label': 'Fullscreen', title: 'Fullscreen (F)', onClick: () => this.toggleFullscreen() }, icon('fullscreen', 22));
    const pipBtn = document.pictureInPictureEnabled
      ? h('button.pbtn.hide-sm', { 'aria-label': 'Picture in picture', title: 'Picture in picture', onClick: () => this.togglePip() }, icon('pip', 22))
      : null;

    this.seekBuffer = h('div.seek-buffer');
    this.seekFill = h('div.seek-fill');
    this.seekThumb = h('div.seek-thumb');
    this.seekTip = h('div.seek-tip');
    this.chapterMarks = h('div');
    this.seekTrack = h('div.seek-track', this.seekBuffer, this.chapterMarks, this.seekFill, this.seekThumb);
    this.seekEl = h('div.seek', { role: 'slider', 'aria-label': 'Seek', tabindex: '0' }, this.seekTrack, this.seekTip);

    this.panelEl = h('div.player-panel', { hidden: true });
    this.msgEl = h('div.player-msg', { hidden: true });
    this.upNextEl = h('div.up-next', { hidden: true });

    this.root = h('div.player',
      this.video,
      this.subsEl,
      this.centerEl,
      h('div.player-top',
        h('button.pbtn', { 'aria-label': 'Back', title: 'Back (Esc)', onClick: () => this.exit() }, icon('arrowLeft', 24)),
      ),
      this.bottomEl = h('div.player-bottom',
        this.seekEl,
        // Three zones: what's playing on the left, transport in the middle (play sits exactly in the
        // centre of the bar), and the other tools on the right.
        this.controlsEl = h('div.controls',
          h('div.ctl-info', h('div.t1', { title: t1 }, t1), t2 && h('div.t2', { title: String(t2) }, t2), this.timeEl),
          this.beforeEl = h('div.ctl-side.ctl-before',
            this.prevBtn,
            this.prevChapterBtn,
            h('button.pbtn', { 'aria-label': 'Back 10 seconds', title: 'Back 10s (←)', onClick: () => this.seekBy(-10) }, icon('back10', 22)),
          ),
          this.playBtn,
          this.afterEl = h('div.ctl-side.ctl-after',
            h('button.pbtn', { 'aria-label': 'Forward 30 seconds', title: 'Forward 30s (→)', onClick: () => this.seekBy(30) }, icon('fwd30', 22)),
            this.nextChapterBtn,
            this.nextBtn,
            h('button.pbtn.ctl-stop', { 'aria-label': 'Stop', title: 'Stop (X)', onClick: () => this.stop() }, icon('stop', 20)),
          ),
          h('div.ctl-tools',
            this.subsBtn,
            this.settingsBtn,
            pipBtn,
            this.fsBtn,
            this.volumeEl,
          ),
        ),
      ),
      this.panelEl,
      this.upNextEl,
      this.msgEl,
    );
    this.setSpinner(true);
  }

  bind() {
    const v = this.video;
    const on = (el, ev, fn, opts) => {
      el.addEventListener(ev, fn, opts);
      (this.unbinders ||= []).push(() => el.removeEventListener(ev, fn, opts));
    };
    on(v, 'play', () => this.updatePlayState());
    on(v, 'pause', () => {
      this.updatePlayState();
      this.report('paused');
    });
    on(v, 'playing', () => {
      this.resumeAt = null;
      this.setSpinner(false);
      this.hideMessage();
      this.updatePlayState();
      clearTimeout(this.healthyTimer);
      this.healthyTimer = setTimeout(() => {
        this.restarts = 0;
        this.mediaRecoveries = 0;
      }, 15000);
    });
    on(v, 'waiting', () => this.setSpinner(true));
    on(v, 'seeking', () => this.setSpinner(true));
    on(v, 'canplay', () => {
      this.setSpinner(false);
      if (this.resumeAt != null && Math.abs(v.currentTime + this.timeShift - this.resumeAt) < 3) this.resumeAt = null;
    });
    on(v, 'timeupdate', () => this.onTime());
    on(v, 'progress', () => this.updateBuffer());
    on(v, 'durationchange', () => this.updateTime());
    on(v, 'ended', () => this.onEnded());
    on(v, 'error', () => this.onVideoError());
    on(v, 'volumechange', () => {
      this.muteBtn.replaceChildren(icon(v.muted || v.volume === 0 ? 'mute' : 'volume', 22));
      this.muteBtn.setAttribute('aria-label', v.muted ? 'Unmute' : 'Mute');
      this.volumeRange.value = String(v.muted ? 0 : v.volume);
      this.volumeLabel.textContent = String(v.muted ? 0 : Math.round(v.volume * 100));
      setPrefs({ volume: v.volume, muted: v.muted });
    });
    // A tap outside the (touch-opened) volume slider closes it, without also acting on the video.
    on(document, 'pointerdown', (e) => {
      if (!this.volumeOpen || this.volumeEl.contains(e.target)) return;
      this.toggleVolumePopup(false);
      if (e.target === v) this.swallowClick = true;
    }, true);
    on(v, 'click', () => {
      if (this.swallowClick) this.swallowClick = false;
      else if (this.panel) this.closePanel();
      else if (matchMedia('(pointer: coarse)').matches) this.toggleControls();
      else this.togglePlay();
    });
    on(v, 'dblclick', () => this.toggleFullscreen());
    // iOS native fullscreen hides our custom subtitle layer; hand rendering to the browser meanwhile.
    on(v, 'webkitbeginfullscreen', () => {
      if (this.trackEl) this.trackEl.track.mode = 'showing';
    });
    on(v, 'webkitendfullscreen', () => {
      if (this.trackEl) this.trackEl.track.mode = 'hidden';
    });

    // Subtitles, panels and Up Next sit just above the control bar, which is taller on phones (two rows).
    if ('ResizeObserver' in window) {
      const measure = () => {
        const padTop = parseFloat(getComputedStyle(this.bottomEl).paddingTop) || 0;
        this.root.style.setProperty('--bar-h', `${Math.round(this.bottomEl.offsetHeight - padTop)}px`);
      };
      const ro = new ResizeObserver(measure);
      ro.observe(this.bottomEl);
      (this.unbinders ||= []).push(() => ro.disconnect());
    }

    on(this.root, 'mousemove', () => this.poke());
    on(this.root, 'touchstart', () => this.poke(), { passive: true });
    on(document, 'keydown', (e) => this.onKey(e));
    on(document, 'fullscreenchange', () => {
      this.fsBtn.replaceChildren(icon(document.fullscreenElement ? 'exitFullscreen' : 'fullscreen', 22));
    });
    on(window, 'pagehide', () => this.report('stopped', { keepalive: true }));

    // Seek bar
    const posFromEvent = (e) => {
      const r = this.seekTrack.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
      return { ratio: r.width ? x / r.width : 0, x };
    };
    on(this.seekEl, 'pointermove', (e) => {
      const { ratio, x } = posFromEvent(e);
      this.seekTip.style.left = `${x}px`;
      const at = ratio * this.duration();
      const chapter = this.chapters?.[chapterIndex(this.chapters, at)];
      this.seekTip.textContent = chapter && chapterTitle(chapter) ? `${formatTime(at)} · ${chapterTitle(chapter)}` : formatTime(at);
      if (this.dragging) this.renderProgress(ratio * this.duration());
    });
    on(this.seekEl, 'pointerdown', (e) => {
      this.dragging = true;
      this.seekEl.classList.add('dragging');
      this.seekEl.setPointerCapture(e.pointerId);
      const { ratio } = posFromEvent(e);
      this.renderProgress(ratio * this.duration());
    });
    const endDrag = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.seekEl.classList.remove('dragging');
      const { ratio } = posFromEvent(e);
      this.seekTo(ratio * this.duration());
    };
    on(this.seekEl, 'pointerup', endDrag);
    on(this.seekEl, 'pointercancel', () => {
      this.dragging = false;
      this.seekEl.classList.remove('dragging');
    });
    on(this.seekEl, 'keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
      if (e.key === 'ArrowLeft') this.seekBy(-10);
      if (e.key === 'ArrowRight') this.seekBy(10);
    });

    this.reportTimer = setInterval(() => {
      if (!this.video.paused) this.report('playing');
    }, REPORT_EVERY_MS);
  }

  // ---------- playback ----------

  async start(at, { forceTranscode = false } = {}) {
    // A newer start (e.g. another sync nudge) supersedes this one.
    const seq = ++this.startSeq;
    const stale = () => this.destroyed || seq !== this.startSeq;
    this.setSpinner(true);
    this.hideMessage();
    const previousSession = this.info?.sessionId;
    this.resumeAt = at;
    this.teardownMedia();
    if (forceTranscode) this.forceTranscode = true;
    let info;
    try {
      info = await api.post(`/api/playback/${this.item.id}`, {
        caps: browserCaps(),
        quality: this.prefs.quality,
        audioIndex: this.prefs.audioIndex,
        burnSubtitle: this.prefs.burnSubtitle,
        audioOffsetMs: this.prefs.audioOffsetMs,
        subtitleOffsetMs: this.prefs.subtitleOffsetMs,
        forceTranscode: this.forceTranscode,
        previousSession,
      });
    } catch (err) {
      if (stale()) return;
      this.showMessage('Can’t play this right now', err.message, [{ label: 'Try again', primary: true, onClick: () => this.start(at) }]);
      return;
    }
    if (stale()) {
      if (info.sessionId && info.sessionId !== this.info?.sessionId) api.del(`/api/hls/${info.sessionId}`).catch(() => {});
      return;
    }
    this.info = info;
    this.timeShift = info.mode === 'hls' ? info.timelineStart || 0 : 0;
    this.shiftCues();
    // The server falls back to the default track if a remembered one no longer exists.
    if (this.prefs.audioIndex != null && info.audioIndex !== this.prefs.audioIndex) {
      this.prefs.audioIndex = info.audioIndex;
      this.prefs.audioOffsetMs = info.audioOffsetMs || 0;
    }
    this.nextBtn.hidden = !info.next;
    this.prevBtn.hidden = !info.prev;
    this.chapters = usableChapters(info.chapters);
    this.prevChapterBtn.hidden = this.nextChapterBtn.hidden = !this.chapters.length;
    // Four buttons beside play (an episode with chapters): the sides make room, both alike so play stays centred.
    const shown = (el) => [...el.children].filter((b) => !b.hidden).length;
    this.controlsEl.classList.toggle('four', Math.max(shown(this.beforeEl), shown(this.afterEl)) > 3);
    this.renderChapters();
    this.updateMediaSession();
    if (!this.subsInitialized) {
      this.subsInitialized = true;
      this.pickDefaultSubtitle();
    }

    const caps = browserCaps();
    // Direct play can "work" with sound but no picture when the browser accepts the file but can't
    // decode its video; watch the first seconds and convert if no frames come out. Same for a copied picture.
    this.pictureWatch = (info.mode === 'direct' || info.videoCopy) && info.video ? { from: null } : null;
    if (info.mode === 'direct') {
      this.video.src = info.url;
      this.seekOnLoad(at);
    } else {
      const Hls = caps.mse ? await loadHls().catch(() => null) : null;
      if (stale()) return;
      if (Hls?.isSupported()) {
        this.attachHls(Hls, info.url, at);
      } else if (caps.nativeHls) {
        this.video.src = info.url;
        this.seekOnLoad(at);
      } else {
        this.showMessage('Unsupported browser', 'This browser can’t play converted video streams.', []);
        return;
      }
    }
    this.applySubtitle();
    this.refreshPanel();
    try {
      await this.video.play();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        this.setSpinner(false);
        this.showBigPlay();
      }
    }
  }

  attachHls(Hls, url, at) {
    const hls = new Hls({
      startPosition: at > 0 ? Math.max(0, at - this.timeShift) : -1,
      maxBufferLength: 30,
      maxMaxBufferLength: 120,
      backBufferLength: 30,
      fragLoadPolicy: {
        default: {
          // Converting can take a while to produce the first segment after a seek.
          maxTimeToFirstByteMs: 90000,
          maxLoadTimeMs: 180000,
          timeoutRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 2000 },
          errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
        },
      },
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (this.hls !== hls) return;
      // 404 = the server dropped this session (e.g. after a long pause). Re-requesting the same
      // URL can't help, so start a fresh session at the current position right away.
      if (data.response?.code === 404) {
        this.retryOrFail('session expired');
        return;
      }
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.mediaRecoveries < 2) {
        this.mediaRecoveries++;
        hls.recoverMediaError();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.info?.videoCopy) {
        // The browser couldn't take the picture copied as it is: convert it too.
        console.warn('[player] copied picture failed:', data.details, data.error?.message || data.reason || '');
        toast('This browser can’t show this file’s picture as it is — converting it instead');
        void this.start(this.currentTime(), { forceTranscode: true });
        return;
      }
      // Network errors (e.g. the server dropped an idle session) or unrecoverable media errors:
      // start a fresh session at the current position.
      // The browser's own reason (e.g. why a buffer append failed) only goes to the console.
      console.warn('[player] stream error:', data.type, data.details, data.error?.message || data.reason || '');
      this.retryOrFail(`${data.type}: ${data.details}`);
    });
    hls.loadSource(url);
    hls.attachMedia(this.video);
    this.hls = hls;
  }

  retryOrFail(detail) {
    const at = this.currentTime();
    if (this.restarts < 3) {
      this.restarts++;
      void this.start(at);
    } else {
      this.showMessage('Playback stopped', `The stream failed repeatedly (${detail}).`, [
        { label: 'Retry', primary: true, onClick: () => { this.restarts = 0; this.start(at); } },
        { label: 'Back', onClick: () => this.exit() },
      ]);
    }
  }

  onVideoError() {
    if (this.hls || !this.info) return; // hls.js reports its own errors
    const code = this.video.error?.code;
    if (this.info.mode === 'direct' && !this.forceTranscode) {
      // The browser claimed it could play the file but couldn't — fall back to converting.
      toast('Direct play failed — converting the video instead');
      void this.start(this.currentTime(), { forceTranscode: true });
      return;
    }
    this.retryOrFail(`media error ${code}`);
  }

  seekOnLoad(at) {
    if (!(at > 0)) return;
    const go = () => {
      this.video.currentTime = Math.max(0, at - this.timeShift);
    };
    if (this.video.readyState >= 1) go();
    else this.video.addEventListener('loadedmetadata', go, { once: true });
  }

  teardownMedia() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute('src');
    this.video.load();
  }

  restartWithSameTime() {
    const at = this.currentTime();
    const wasPaused = this.video.paused;
    void this.start(at).then(() => {
      if (wasPaused) this.video.pause();
    });
  }

  currentTime() {
    // While a restart loads, the element is empty (time 0); report where playback will resume.
    if (this.resumeAt != null) return this.resumeAt;
    return (this.video.currentTime || 0) + this.timeShift;
  }

  duration() {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d + this.timeShift : this.info?.duration || this.item.duration || 0;
  }

  togglePlay() {
    if (this.video.paused) {
      this.hideBigPlay();
      this.video.play().catch(() => this.showBigPlay());
    } else {
      this.video.pause();
    }
  }

  seekTo(t) {
    const d = this.duration();
    this.resumeAt = null;
    this.video.currentTime = Math.max(0, Math.min(Math.max(t, 0), Math.max(d - 1, 0)) - this.timeShift);
    this.renderProgress(this.currentTime());
    this.poke();
  }

  seekBy(delta) {
    this.seekTo(this.currentTime() + delta);
    this.osd(`${delta > 0 ? '+' : '−'}${Math.abs(delta)}s`);
  }

  /** To the next chapter (by > 0), or back to this one's start (the one before, just after a start). */
  skipChapter(by) {
    if (!this.chapters?.length) return;
    const target = by > 0 ? nextChapter(this.chapters, this.currentTime()) : previousChapter(this.chapters, this.currentTime());
    if (!target) {
      this.osd('This is the last chapter');
      return;
    }
    this.seekTo(target.start);
    this.osd(chapterLabel(this.chapters, target.index));
  }

  toggleVolumePopup(open = !this.volumeOpen) {
    this.volumeOpen = open;
    this.volumeEl.classList.toggle('open', open);
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
      else if (this.video.webkitEnterFullscreen) this.video.webkitEnterFullscreen();
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

  exit() {
    back(`/item/${this.item.id}`);
  }

  /** Stop playback and leave the player; the position is saved, so Resume continues from here. */
  stop() {
    clearTimeout(this.applyTimer);
    this.video.pause();
    this.exit();
  }

  playPrev() {
    if (this.info?.prev) navigate(`/play/${this.info.prev.id}`, { replace: true });
  }

  playNext() {
    if (this.info?.next) navigate(`/play/${this.info.next.id}`, { replace: true });
  }

  // ---------- progress & UI updates ----------

  report(state, { keepalive = false } = {}) {
    if (!this.info || this.stoppedReported) return;
    if (state === 'playing' && Date.now() - this.lastReport < REPORT_EVERY_MS - 500) return;
    if (state === 'stopped') this.stoppedReported = true;
    const t = this.currentTime();
    this.lastReport = Date.now();
    api.post('/api/progress', {
      itemId: this.item.id,
      position: t,
      duration: this.duration(),
      state,
      playId: this.info.playId,
      mode: this.info.mode,
      quality: this.info.quality,
    }, { keepalive }).catch(() => {});
  }

  onTime() {
    if (!this.dragging) this.renderProgress(this.currentTime());
    this.updateTime();
    this.updateBuffer();
    this.checkPicture();
  }

  checkPicture() {
    const w = this.pictureWatch;
    if (!w || this.video.paused || this.video.seeking) return;
    // Background tabs may skip decoding video on purpose: only judge while the page is visible.
    if (document.hidden) {
      w.from = null;
      return;
    }
    const t = this.video.currentTime;
    if (w.from == null || t < w.from) {
      w.from = t;
      return;
    }
    if (t - w.from < 3) return;
    this.pictureWatch = null;
    const frames = this.video.getVideoPlaybackQuality?.().totalVideoFrames;
    if (this.video.videoWidth === 0 || frames === 0) {
      toast('This browser can’t show this file’s picture — converting it instead');
      void this.start(this.currentTime(), { forceTranscode: true });
    }
  }

  renderProgress(t) {
    const d = this.duration();
    const pct = d ? Math.min(100, (t / d) * 100) : 0;
    this.seekFill.style.width = `${pct}%`;
    this.seekThumb.style.left = `${pct}%`;
    this.seekEl.setAttribute('aria-valuenow', String(Math.round(t)));
  }

  updateBuffer() {
    const b = this.video.buffered;
    const t = this.currentTime();
    const d = this.duration();
    if (!d) return;
    for (let i = 0; i < b.length; i++) {
      const [start, end] = [b.start(i) + this.timeShift, b.end(i) + this.timeShift];
      if (start <= t + 0.5 && end >= t) {
        this.seekBuffer.style.left = `${(start / d) * 100}%`;
        this.seekBuffer.style.width = `${((end - start) / d) * 100}%`;
        return;
      }
    }
    this.seekBuffer.style.width = '0';
  }

  updateTime() {
    const t = this.currentTime();
    const d = this.duration();
    this.timeNow.textContent = this.showRemaining ? `-${formatTime(d - t)}` : formatTime(t);
    this.timeTotal.textContent = ` / ${formatTime(d)}`;
  }

  updatePlayState() {
    const paused = this.video.paused;
    this.playBtn.replaceChildren(icon(paused ? 'play' : 'pause', 26));
    this.playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    if (!paused) this.hideBigPlay();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
    this.poke();
  }

  renderChapters() {
    clear(this.chapterMarks);
    const d = this.info?.duration;
    const chapters = this.chapters || [];
    if (!d || !chapters.length) return;
    for (const c of chapters.slice(1)) {
      this.chapterMarks.append(h('div.chapter-mark', { style: { left: `${(c.start / d) * 100}%` }, title: c.title || '' }));
    }
  }

  setSpinner(on) {
    if (on) {
      if (!this.centerEl.querySelector('.spinner') && !this.centerEl.querySelector('.big-play')) {
        this.centerEl.replaceChildren(h('div.spinner'));
      }
    } else if (this.centerEl.querySelector('.spinner')) {
      clear(this.centerEl);
    }
  }

  showBigPlay() {
    this.centerEl.replaceChildren(h('button.big-play', { 'aria-label': 'Play', onClick: () => this.togglePlay() }, icon('play', 36)));
  }

  hideBigPlay() {
    if (this.centerEl.querySelector('.big-play')) clear(this.centerEl);
  }

  showMessage(title, text, actions) {
    this.setSpinner(false);
    this.msgEl.replaceChildren(
      h('h3', title),
      h('p', text),
      h('div.btn-row', { style: { justifyContent: 'center' } },
        actions.map((a) => h(`button.btn${a.primary ? '.btn-primary' : ''}`, { onClick: a.onClick }, a.label)),
        !actions.some((a) => a.label === 'Back') && h('button.btn', { onClick: () => this.exit() }, 'Back')),
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
    setTimeout(() => el.remove(), 700);
  }

  // Controls auto-hide while playing.
  poke() {
    this.root.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.video.paused && !this.panel && !this.dragging && !this.volumeOpen) this.root.classList.add('idle');
    }, HIDE_CONTROLS_MS);
  }

  toggleControls() {
    if (this.root.classList.contains('idle')) this.poke();
    else if (!this.video.paused) this.root.classList.add('idle');
  }

  onKey(e) {
    if (e.target.closest?.('input, select, textarea') && e.target.type !== 'range') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      this.poke();
    };
    if (k === ' ' || k === 'k') { handled(); this.togglePlay(); }
    else if (k === 'ArrowLeft' || k === 'j') { handled(); this.seekBy(-10); }
    else if (k === 'ArrowRight' || k === 'l') { handled(); this.seekBy(k === 'l' ? 10 : 30); }
    else if (k === 'ArrowUp') { handled(); this.video.volume = Math.min(1, this.video.volume + 0.1); this.video.muted = false; this.osd(`Volume ${Math.round(this.video.volume * 100)}%`); }
    else if (k === 'ArrowDown') { handled(); this.video.volume = Math.max(0, this.video.volume - 0.1); this.osd(`Volume ${Math.round(this.video.volume * 100)}%`); }
    else if (k === 'f') { handled(); this.toggleFullscreen(); }
    else if (k === 'x') { handled(); this.stop(); }
    else if (k === 'm') { handled(); this.toggleMute(); }
    else if (k === 'c') { handled(); this.cycleSubtitles(); }
    else if (k === 'g' || k === 'h') { handled(); this.nudgeSubtitles(k === 'h' ? SYNC_STEP_MS : -SYNC_STEP_MS); }
    else if (k === 'n' && this.info?.next) { handled(); this.playNext(); }
    else if (k === 'p' && this.info?.prev) { handled(); this.playPrev(); }
    else if ((k === 'PageUp' || k === 'PageDown') && this.chapters?.length) { handled(); this.skipChapter(k === 'PageDown' ? 1 : -1); }
    else if (k === 'Escape') {
      if (this.panel) { handled(); this.closePanel(); }
      else if (!document.fullscreenElement) { handled(); this.exit(); }
    }
  }

  // ---------- audio & subtitle tracks ----------

  textTracks() {
    return (this.info?.subtitleTracks || []).filter((t) => t.kind === 'text');
  }

  currentAudioIndex() {
    return this.prefs.audioIndex ?? this.info?.audioIndex ?? null;
  }

  /** The subtitle track on screen: a text track, or an image track burned in by the server. */
  currentSubtitleTrack() {
    if (this.subtitle) return this.subtitle;
    if (this.prefs.burnSubtitle == null) return null;
    return this.info?.subtitleTracks?.find((t) => t.streamIndex === this.prefs.burnSubtitle) || null;
  }

  rememberItemPrefs(patch) {
    this.itemPrefs = { ...this.itemPrefs, ...patch };
    saveItemPrefs(this.item.id, this.itemPrefs);
  }

  offsetLimits() {
    return this.info?.offsetLimits || { audioMs: 10000, subtitleMs: 600000 };
  }

  selectAudio(a) {
    if (a.index === this.currentAudioIndex()) return;
    this.prefs.audioIndex = a.index;
    // Each track keeps its own sync offset (a dub can be out of sync differently).
    this.prefs.audioOffsetMs = this.itemPrefs.audioDelay?.[a.index] || 0;
    this.rememberItemPrefs({ audio: a.index });
    this.refreshPanel();
    this.restartWithSameTime();
  }

  pickDefaultSubtitle() {
    const tracks = this.info?.subtitleTracks || [];
    const lang = getPrefs().subtitleLanguage;
    let pick = null;
    if (lang) {
      pick = tracks.find((t) => t.kind === 'text' && t.language === lang && !t.forced) || tracks.find((t) => t.kind === 'text' && t.language === lang);
    }
    if (!pick) pick = tracks.find((t) => t.kind === 'text' && t.forced && t.isDefault) || null;
    this.subtitle = pick;
    this.prefs.subtitleOffsetMs = (pick && this.itemPrefs.subDelay?.[pick.id]) || 0;
  }

  selectSubtitle(track) {
    this.prefs.subtitleOffsetMs = (track && this.itemPrefs.subDelay?.[track.id]) || 0;
    // Image subtitles (PGS/VobSub) must be burned into the video by the server.
    if (track?.kind === 'image') {
      this.subtitle = null;
      this.prefs.burnSubtitle = track.streamIndex;
      setPrefs({ subtitleLanguage: track.language || null });
      this.refreshPanel();
      this.restartWithSameTime();
      return;
    }
    const wasBurning = this.prefs.burnSubtitle != null;
    this.prefs.burnSubtitle = null;
    this.subtitle = track;
    setPrefs({ subtitleLanguage: track?.language || null });
    if (wasBurning) this.restartWithSameTime();
    else this.applySubtitle();
    this.refreshPanel();
  }

  cycleSubtitles() {
    const tracks = this.textTracks();
    if (!tracks.length) return;
    const i = this.subtitle ? tracks.findIndex((t) => t.id === this.subtitle.id) : -1;
    const next = i + 1 < tracks.length ? tracks[i + 1] : null;
    this.selectSubtitle(next);
    this.osd(next ? `Subtitles: ${trackLabel(next)}` : 'Subtitles off');
  }

  applySubtitle() {
    this.trackEl?.remove();
    this.trackEl = null;
    clear(this.subsEl);
    this.subsBtn.classList.toggle('active', !!this.subtitle || this.prefs.burnSubtitle != null);
    const t = this.subtitle;
    if (!t) return;
    const el = h('track', { kind: 'subtitles', src: t.url, srclang: t.language || 'und', label: trackLabel(t) });
    this.video.append(el);
    el.track.mode = 'hidden';
    this.cueTimes = new WeakMap();
    el.addEventListener('load', () => this.shiftCues());
    el.addEventListener('error', () => toast('Could not load subtitles', { error: true }));
    // Render cues ourselves so they can move above the controls.
    el.track.addEventListener('cuechange', () => this.renderCues());
    this.trackEl = el;
  }

  renderCues() {
    clear(this.subsEl);
    for (const cue of Array.from(this.trackEl?.track.activeCues || [])) {
      const span = h('span.cue');
      span.append(typeof cue.getCueAsHTML === 'function' ? cue.getCueAsHTML() : document.createTextNode(cue.text));
      this.subsEl.append(span, h('br'));
    }
  }

  /**
   * Text subtitles are synced in the browser: every cue moves by the offset from its original time (and onto the video
   * element's clock, see timeShift).
   */
  shiftCues() {
    const cues = this.trackEl?.track.cues;
    if (!cues) return; // not loaded yet — the load handler calls this again
    const offset = this.prefs.subtitleOffsetMs / 1000 - this.timeShift;
    for (const cue of Array.from(cues)) {
      let orig = this.cueTimes.get(cue);
      if (!orig) this.cueTimes.set(cue, (orig = [cue.startTime, cue.endTime]));
      cue.startTime = Math.max(0, orig[0] + offset);
      cue.endTime = Math.max(0, orig[1] + offset);
    }
  }

  // ---------- sync offsets (positive = later, negative = earlier) ----------

  setAudioOffset(value) {
    const index = this.currentAudioIndex();
    if (index == null) return 0;
    const ms = clampMs(value, this.offsetLimits().audioMs);
    if (ms !== this.prefs.audioOffsetMs) {
      this.prefs.audioOffsetMs = ms;
      this.rememberItemPrefs({ audio: index, audioDelay: withDelay(this.itemPrefs.audioDelay, index, ms) });
      // Browsers can't shift audio against the picture, so the server re-converts with the offset.
      this.scheduleRestart();
    }
    this.updateSyncControls();
    return ms;
  }

  setSubtitleOffset(value) {
    const track = this.currentSubtitleTrack();
    if (!track) return 0;
    const ms = clampMs(value, this.offsetLimits().subtitleMs);
    if (ms !== this.prefs.subtitleOffsetMs) {
      this.prefs.subtitleOffsetMs = ms;
      this.rememberItemPrefs({ subDelay: withDelay(this.itemPrefs.subDelay, track.id, ms) });
      if (this.subtitle) this.shiftCues();
      else this.scheduleRestart(); // burned-in subtitles are shifted by the server
    }
    this.updateSyncControls();
    return ms;
  }

  nudgeSubtitles(delta) {
    if (!this.currentSubtitleTrack()) {
      this.osd('Subtitles are off');
      return;
    }
    this.osd(`Subtitle delay ${formatOffset(this.setSubtitleOffset(this.prefs.subtitleOffsetMs + delta))}`);
  }

  scheduleRestart() {
    clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => {
      this.applyTimer = null;
      this.restartWithSameTime();
    }, SYNC_APPLY_DELAY_MS);
  }

  updateSyncControls() {
    this.syncControls?.audio?.set(this.prefs.audioOffsetMs);
    this.syncControls?.subs?.set(this.currentSubtitleTrack() ? this.prefs.subtitleOffsetMs : 0);
  }

  /** "Delay" row: −/+ buttons around a millisecond field that takes negative and positive values. */
  syncRow({ key, label, noun, verb, limit, value, disabled, disabledHint, onChange }) {
    const input = h('input.pp-ms', {
      type: 'number', step: String(SYNC_STEP_MS), min: String(-limit), max: String(limit),
      value: String(value), disabled, 'data-k': `${key}-ms`, 'aria-label': `${label} delay in milliseconds`,
      onChange: () => set(onChange(input.value === '' ? current : input.value)),
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') input.blur();
      },
    });
    const hint = h('div.pp-sync-hint');
    const reset = h('button.pp-reset', { 'data-k': `${key}-reset`, disabled, onClick: () => set(onChange(0)) }, 'Reset');
    let current = value;
    const set = (ms) => {
      current = ms;
      input.value = String(ms);
      reset.hidden = !ms;
      hint.textContent = disabled ? disabledHint : ms ? `${noun} ${verb} ${Math.abs(ms)} ms ${ms > 0 ? 'later' : 'earlier'}` : 'No delay';
    };
    const step = (sign) => h('button.pp-step', {
      'data-k': `${key}-${sign > 0 ? 'plus' : 'minus'}`,
      'aria-label': `${label} ${SYNC_STEP_MS} ms ${sign > 0 ? 'later' : 'earlier'}`,
      title: `${sign > 0 ? '+' : '−'}${SYNC_STEP_MS} ms (${sign > 0 ? 'later' : 'earlier'})`,
      disabled,
      onClick: () => set(onChange(current + sign * SYNC_STEP_MS)),
    }, icon(sign > 0 ? 'plus' : 'minus', 16));
    set(value);
    const el = h('div.pp-sync',
      h('div.pp-sync-row', h('span.pp-sync-label', label), step(-1), input, h('span.pp-unit', 'ms'), step(1), reset),
      hint);
    return { el, set };
  }

  // ---------- panels ----------

  togglePanel(name) {
    if (this.panel === name) this.closePanel();
    else this.openPanel(name);
  }

  closePanel() {
    this.panel = null;
    this.panelSub = null;
    this.syncControls = null;
    this.panelEl.hidden = true;
    this.poke();
  }

  /** Re-render the open panel (e.g. after a restart) without losing keyboard focus or a half-typed value. */
  refreshPanel() {
    if (!this.panel) return;
    const focused = this.panelEl.contains(document.activeElement) ? document.activeElement : null;
    if (focused?.matches('input')) return;
    const key = focused?.closest('[data-k]')?.dataset.k;
    this.openPanel(this.panel, this.panelSub);
    if (key) this.panelEl.querySelector(`[data-k="${CSS.escape(key)}"]`)?.focus();
  }

  openPanel(name, sub) {
    this.panel = name;
    this.panelSub = sub || null;
    this.syncControls = null;
    this.panelEl.hidden = false;
    this.panelEl.classList.remove('wide');
    clear(this.panelEl);
    const item = (label, { value, selected, onClick, chevron, key } = {}) => h('button.pp-item', { onClick, 'data-k': key, 'aria-pressed': selected == null ? null : String(!!selected) },
      h('span.tick', selected ? icon('check', 18) : null),
      h('span', label),
      value != null && h('span.val', value),
      chevron && icon('chevronRight', 16));
    const head = (title, backTo) => h('div.pp-head',
      backTo && h('button', { 'aria-label': 'Back', onClick: () => this.openPanel(backTo) }, icon('chevronLeft', 18)),
      title);

    if (name === 'av') {
      const audioTracks = this.info?.audioTracks || [];
      const subTracks = (this.info?.subtitleTracks || []).filter((t) => t.kind !== 'unsupported');
      const audioIndex = this.currentAudioIndex();
      const subTrack = this.currentSubtitleTrack();
      const audioCol = audioTracks.length > 1 && h('div.pp-col',
        h('div.pp-section', 'Audio'),
        audioTracks.map((a) => item(audioLabel(a), { key: `a${a.index}`, selected: a.index === audioIndex, onClick: () => this.selectAudio(a) })));
      const subCol = h('div.pp-col',
        h('div.pp-section', 'Subtitles'),
        item('Off', { key: 'soff', selected: !subTrack, onClick: () => this.selectSubtitle(null) }),
        subTracks.map((t) => item(trackLabel(t), { key: `s${t.id}`, selected: subTrack?.id === t.id, onClick: () => this.selectSubtitle(t) })),
        !subTracks.length && h('div.pp-empty', 'This video has no subtitles.'));
      const limits = this.offsetLimits();
      this.syncControls = {
        audio: audioTracks.length ? this.syncRow({
          key: 'ad', label: 'Audio', noun: 'Audio', verb: 'plays', limit: limits.audioMs,
          value: this.prefs.audioOffsetMs, onChange: (ms) => this.setAudioOffset(ms),
        }) : null,
        subs: this.syncRow({
          key: 'sd', label: 'Subtitles', noun: 'Subtitles', verb: 'show', limit: limits.subtitleMs,
          value: subTrack ? this.prefs.subtitleOffsetMs : 0, disabled: !subTrack, disabledHint: 'Turn on subtitles to adjust their timing.',
          onChange: (ms) => this.setSubtitleOffset(ms),
        }),
      };
      this.panelEl.classList.toggle('wide', !!audioCol);
      setChildren(this.panelEl,
        head('Audio & subtitles'),
        h(`div.pp-cols${audioCol ? '.two' : ''}`, audioCol, subCol),
        h('div.pp-section.pp-rule', 'Sync'),
        this.syncControls.audio?.el,
        this.syncControls.subs.el,
        h('div.pp-note',
          'Out of sync? Positive values play it later, negative values earlier (G / H nudge subtitles by 50 ms).',
          audioTracks.length > 0 && ' Changing the audio delay converts the video while it’s set.',
          subTracks.some((t) => t.kind === 'image') && ' Image-based subtitles (PGS/VobSub) are burned into the picture, which also needs converting.'),
      );
      return;
    }

    if (name === 'settings' && !sub) {
      const q = this.qualities.find((x) => x.id === (this.info?.quality || this.prefs.quality));
      const audio = this.info?.audioTracks?.find((a) => a.index === this.info.audioIndex);
      const reasons = this.info?.reasons || [];
      setChildren(this.panelEl,
        head('Playback'),
        item('Quality', { value: q?.label || 'Original', chevron: true, onClick: () => this.openPanel('settings', 'quality') }),
        item('Audio & subtitles', { value: audio ? languageName(audio.language) || 'Track' : null, chevron: true, onClick: () => this.openPanel('av') }),
        h('div.pp-note', this.info?.mode === 'direct'
          ? 'Direct Play — streaming the original file.'
          : `Converting (${reasons.join(', ') || 'requested'})${this.info?.videoCopy ? ' — the picture is copied as it is' : ''}.`),
      );
      return;
    }
    if (sub === 'quality') {
      // Only the original and presets below it (the server's list for this file); what's playing is ticked.
      const offered = this.info?.qualities;
      const current = this.info?.quality || this.prefs.quality;
      setChildren(this.panelEl, head('Quality', 'settings'), this.qualities.filter((q) => !offered || offered.includes(q.id)).map((q) => item(q.label, {
        selected: q.id === current,
        onClick: () => {
          this.prefs.quality = q.id;
          savePreferredQuality(q.id);
          this.forceTranscode = false;
          this.closePanel();
          this.restartWithSameTime();
        },
      })));
    }
  }

  // ---------- end of playback ----------

  onEnded() {
    this.report('ended');
    const next = this.info?.next;
    if (!next) {
      setTimeout(() => {
        if (!this.destroyed) this.exit();
      }, 1500);
      return;
    }
    let remaining = 10;
    const countdown = h('span', String(remaining));
    setChildren(this.upNextEl,
      next.images.thumb ? h('img', { src: imgUrl(next.images.thumb, 340), alt: '' }) : null,
      h('div.un-body',
        h('div.un-label', 'Up next'),
        h('div.un-title', `${episodeLabel(next)} — ${next.title}`),
        h('div.btn-row',
          h('button.btn.btn-primary', { onClick: () => this.playNext() }, icon('play', 18), h('span', 'Play now (', countdown, ')')),
          h('button.btn', { onClick: () => { clearInterval(this.countdownTimer); this.upNextEl.hidden = true; } }, 'Cancel'),
        ),
      ),
    );
    this.upNextEl.hidden = false;
    this.poke();
    this.countdownTimer = setInterval(() => {
      remaining--;
      countdown.textContent = String(remaining);
      if (remaining <= 0) {
        clearInterval(this.countdownTimer);
        this.playNext();
      }
    }, 1000);
  }

  updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const isEp = this.item.type === 'episode';
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.item.title,
        artist: isEp ? `${this.show?.title || ''} · ${episodeLabel(this.item)}` : String(this.item.year || ''),
        artwork: this.item.images.poster ? [{ src: imgUrl(this.item.images.poster, 320), sizes: '320x480', type: 'image/jpeg' }] : [],
      });
      navigator.mediaSession.setActionHandler('seekbackward', () => this.seekBy(-10));
      navigator.mediaSession.setActionHandler('seekforward', () => this.seekBy(30));
      // A keyboard's or headset's next/previous: the next episode, or else the next chapter.
      const chapters = this.chapters?.length;
      navigator.mediaSession.setActionHandler('nexttrack', this.info?.next ? () => this.playNext() : chapters ? () => this.skipChapter(1) : null);
      navigator.mediaSession.setActionHandler('previoustrack', this.info?.prev ? () => this.playPrev() : chapters ? () => this.skipChapter(-1) : null);
    } catch {
      // older browsers
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.report('stopped', { keepalive: true });
    this.destroyed = true;
    clearInterval(this.reportTimer);
    clearInterval(this.countdownTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.healthyTimer);
    clearTimeout(this.applyTimer);
    for (const fn of this.unbinders || []) fn();
    if (this.info?.sessionId) api.del(`/api/hls/${this.info.sessionId}`, { keepalive: true }).catch(() => {});
    this.teardownMedia();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  }
}
