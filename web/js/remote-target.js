// The phone remote (server/remote.js): the Reelhouse app on a phone on the same network can play things in this tab
// and control them. live.js opens its event stream with ?target=web while that's allowed here (Settings → Your
// account → Phone remote, kept per browser), and with &shared=1 when anyone at home may use it; the commands arrive
// on it, this does them with the player on screen (a film or episode, or a live channel), and answers each one so the
// phone can say what happened. The player tells the phone what it offers (audio and subtitle tracks, the volume:
// controlsChanged). The tabs of a browser share a sign-in, so the phone lists just one of them: the last to open its
// stream or take the focus (claim).
import { api } from './api.js';
import { navigate } from './router.js';
import { toast } from './components.js';

const KEY = 'reelhouse.remoteTarget';
const SHARED_KEY = 'reelhouse.remoteShared';
const START_WITHIN_MS = 30000;
const CONTROLS_AFTER_MS = 300;

let targetId = null;
// The player on screen: a film or episode (views/player.js) or a channel (views/live-player.js). Both have `video`,
// `started`, reportNow(), stop(), showBigPlay()/hideBigPlay() and remoteControls().
let player = null;
let controlsTimer = null;

const stored = (key, fallback) => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === 'on';
  } catch {
    return fallback;
  }
};

const store = (key, on) => {
  try {
    localStorage.setItem(key, on ? 'on' : 'off');
  } catch {
    // storage unavailable: it stays as it was for this tab
  }
  window.dispatchEvent(new Event('reelhouse:remote-target'));
};

/** Whether a phone may control this browser (on unless switched off here). */
export const remoteTargetOn = () => stored(KEY, true);
export const setRemoteTargetOn = (on) => store(KEY, on);

/** Whether anyone at home (other accounts' phones too) may use this browser; off unless switched on here. */
export const remoteSharedOn = () => stored(SHARED_KEY, false);
export const setRemoteSharedOn = (on) => store(SHARED_KEY, on);

/** The event stream's address, as these switches say. */
export function eventsUrl() {
  if (!remoteTargetOn()) return '/api/events';
  return remoteSharedOn() ? '/api/events?target=web&shared=1' : '/api/events?target=web';
}

/** The player tells this module it's on screen, and when it goes. */
export function playerOpened(p) {
  player = p;
}

export function playerClosed(p) {
  if (player !== p) return;
  player = null;
  controlsChanged();
}

/**
 * What the player offers the phone changed (it started, a track or the volume changed, it closed): told to Reelhouse
 * a moment later, once for a burst of changes.
 */
export function controlsChanged() {
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => {
    if (!targetId) return;
    const controls = player?.remoteControls?.() || {};
    api.post('/api/remote/status', { targetId, ...controls }).catch(() => {});
  }, CONTROLS_AFTER_MS);
}

/** The stream said who this tab is (remote-hello). */
export function remoteHello(data) {
  targetId = data?.targetId || null;
  if (player) controlsChanged(); // a new stream: tell it again
}

/** The stream closed: the next one gets a new id. */
export function remoteGone() {
  targetId = null;
}

// The tab taken to the front becomes the one the phone sees.
window.addEventListener('focus', () => {
  if (targetId) api.post(`/api/remote/targets/${targetId}/claim`).catch(() => {});
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * After a play command: 'playing', 'blocked' (the browser wanted a press of Play), 'failed' or 'timeout'. `before`
 * is the player that was on screen, which may be showing the same thing; [shows](player) says it's the one asked for.
 */
async function started(shows, before) {
  const deadline = Date.now() + START_WITHIN_MS;
  while (!(player && player !== before && shows(player))) {
    if (Date.now() > deadline) return 'timeout';
    await wait(100);
  }
  return Promise.race([player.started, wait(Math.max(0, deadline - Date.now())).then(() => 'timeout')]);
}

const PROBLEMS = {
  failed: 'It couldn’t start in the browser.',
  timeout: 'The browser didn’t start it in time.',
};

const isLive = (p) => !!p?.channel;
const playerPage = () => /^\/(play|livetv\/watch|radio\/listen)\//.test(location.pathname);

/** Opens [url] for a play from the phone: over a player that's open, in its place (stacked, Back or Stop would go back to it, and it would play again). */
function openPlayer(url) {
  navigate(url, playerPage() ? { replace: true, state: { internal: history.state?.internal } } : {});
}

/** A play from the phone: a film or episode ({ itemId, start }) or a channel ({ channel, radio, zap }). */
async function play(cmd) {
  const before = player;
  if (cmd.channel) {
    // Channel up/down (zap) in the channel player already open: the channel changes there.
    if (cmd.zap && isLive(player) && player.switchTo(cmd.channel)) {
      const p = player;
      return Promise.race([p.started, wait(START_WITHIN_MS).then(() => 'timeout')]);
    }
    openPlayer(cmd.radio ? `/radio/listen/${cmd.channel}` : `/livetv/watch/${cmd.channel}`);
    return started((p) => p.channel?.uuid === cmd.channel, before);
  }
  openPlayer(`/play/${cmd.itemId}${cmd.start > 0 ? `?t=${Math.floor(cmd.start)}` : ''}`);
  return started((p) => p.item?.id === cmd.itemId, before);
}

/** A command from the phone (the stream's remote event). */
export async function remoteCommand(cmd) {
  const answer = (ok, problem = null) => api.post(`/api/remote/commands/${cmd.id}/done`, { ok, problem }).catch(() => {});
  try {
    if (cmd.type === 'play') {
      if (!cmd.zap) toast(`Playing from ${cmd.from}`);
      const result = await play(cmd);
      if (result === 'playing') {
        player?.reportNow(); // where it started, rather than the phone waiting for the next report
        return answer(true);
      }
      return answer(false, result === 'blocked' ? 'blocked' : PROBLEMS[result]);
    }
    const p = player;
    if (!p) return answer(false, 'Nothing is playing in the browser.');
    const v = p.video;
    if (cmd.type === 'pause') {
      v.pause();
    } else if (cmd.type === 'resume') {
      p.hideBigPlay();
      try {
        await v.play();
      } catch (err) {
        p.showBigPlay();
        return answer(false, err.name === 'NotAllowedError' ? 'blocked' : err.message);
      }
    } else if (cmd.type === 'seek' || cmd.type === 'skip') {
      if (isLive(p)) return answer(false, 'A channel can’t be wound on or back from the phone.');
      if (cmd.type === 'seek') p.seekTo(cmd.position);
      else p.seekBy(cmd.seconds);
    } else if (cmd.type === 'stop') {
      p.stop();
      return answer(true);
    } else if (cmd.type === 'next' || cmd.type === 'previous') {
      const other = cmd.type === 'next' ? p.info?.next : p.info?.prev;
      if (isLive(p) || !other) return answer(false, cmd.type === 'next' ? 'This is the last episode.' : 'This is the first episode.');
      if (cmd.type === 'next') p.playNext();
      else p.playPrev();
      return answer(true);
    } else if (cmd.type === 'audio') {
      if (!p.remoteAudio?.(cmd.track)) return answer(false, 'That sound track isn’t there any more.');
      return answer(true); // the player starts again with it, and reports then
    } else if (cmd.type === 'subtitle') {
      if (!p.remoteSubtitle?.(cmd.track)) return answer(false, 'Those subtitles aren’t there any more.');
    } else if (cmd.type === 'volume') {
      v.volume = Math.min(1, Math.max(0, cmd.level / 100));
      v.muted = cmd.level === 0;
    } else if (cmd.type === 'mute') {
      v.muted = !!cmd.muted;
      if (!v.muted && v.volume === 0) v.volume = 0.5;
    } else {
      return answer(false, 'The browser doesn’t know that one yet.');
    }
    p.reportNow();
    controlsChanged();
    return answer(true);
  } catch (err) {
    return answer(false, err.message);
  }
}
