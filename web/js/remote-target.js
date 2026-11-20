// The phone remote (server/remote.js): the Reelhouse app on a phone on the same network can play things in this tab
// and control them. live.js opens its event stream with ?target=web while that's allowed here (Settings → Your
// account → Phone remote, kept per browser); the commands arrive on it, this does them with the player on screen,
// and answers each one so the phone can say what happened. The tabs of a browser share a sign-in, so the phone
// lists just one of them: the last to open its stream or take the focus (claim).
import { api } from './api.js';
import { navigate } from './router.js';
import { toast } from './components.js';

const KEY = 'reelhouse.remoteTarget';
const START_WITHIN_MS = 30000;

let targetId = null;
let player = null; // the film or episode player on screen (views/player.js)

/** Whether a phone may control this browser (on unless switched off here). */
export function remoteTargetOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setRemoteTargetOn(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // storage unavailable: it stays as it was for this tab
  }
  window.dispatchEvent(new Event('reelhouse:remote-target'));
}

/** The player tells this module it's on screen, and when it goes. */
export function playerOpened(p) {
  player = p;
}

export function playerClosed(p) {
  if (player === p) player = null;
}

/** The stream said who this tab is (remote-hello). */
export function remoteHello(data) {
  targetId = data?.targetId || null;
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
 * is the player that was on screen, which may be showing the same film.
 */
async function started(itemId, before) {
  const deadline = Date.now() + START_WITHIN_MS;
  while (!(player && player !== before && player.item.id === itemId)) {
    if (Date.now() > deadline) return 'timeout';
    await wait(100);
  }
  return Promise.race([player.started, wait(Math.max(0, deadline - Date.now())).then(() => 'timeout')]);
}

const PROBLEMS = {
  failed: 'It couldn’t start in the browser.',
  timeout: 'The browser didn’t start it in time.',
};

/** A command from the phone (the stream's remote event). */
export async function remoteCommand(cmd) {
  const answer = (ok, problem = null) => api.post(`/api/remote/commands/${cmd.id}/done`, { ok, problem }).catch(() => {});
  try {
    if (cmd.type === 'play') {
      toast(`Playing from ${cmd.from}`);
      const before = player;
      // Over a player that's open, in its place: stacked, Back or Stop would go back to it, and it would play again.
      const over = location.pathname.startsWith('/play/');
      navigate(`/play/${cmd.itemId}${cmd.start > 0 ? `?t=${Math.floor(cmd.start)}` : ''}`,
        over ? { replace: true, state: { internal: history.state?.internal } } : {});
      const result = await started(cmd.itemId, before);
      if (result === 'playing') {
        player?.reportNow(); // where it started, rather than the phone waiting for the next report
        return answer(true);
      }
      return answer(false, result === 'blocked' ? 'blocked' : PROBLEMS[result]);
    }
    const p = player;
    if (!p) return answer(false, 'Nothing is playing in the browser.');
    if (cmd.type === 'pause') {
      p.video.pause();
    } else if (cmd.type === 'resume') {
      p.hideBigPlay();
      try {
        await p.video.play();
      } catch (err) {
        p.showBigPlay();
        return answer(false, err.name === 'NotAllowedError' ? 'blocked' : err.message);
      }
    } else if (cmd.type === 'seek') {
      p.seekTo(cmd.position);
    } else if (cmd.type === 'skip') {
      p.seekBy(cmd.seconds);
    } else if (cmd.type === 'stop') {
      p.stop();
      return answer(true);
    } else if (cmd.type === 'next' || cmd.type === 'previous') {
      const other = cmd.type === 'next' ? p.info?.next : p.info?.prev;
      if (!other) return answer(false, cmd.type === 'next' ? 'This is the last episode.' : 'This is the first episode.');
      if (cmd.type === 'next') p.playNext();
      else p.playPrev();
      return answer(true);
    } else {
      return answer(false, 'The browser doesn’t know that one yet.');
    }
    p.reportNow();
    return answer(true);
  } catch (err) {
    return answer(false, err.message);
  }
}
