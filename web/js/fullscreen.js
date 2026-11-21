// Full screen for the players (views/player.js, views/live-player.js). The whole page goes full screen, not the
// player's own element: going on to the next episode (or the phone remote's next film or channel) puts a new player on
// the page, and full screen on the old one's element would end with it, leaving the browser window maximised. The
// player fills the window either way (position: fixed). Leaving the players for another page ends full screen.

const PLAYER_PAGES = /^\/(play|livetv\/watch|radio\/listen)\//;

/** Full screen on or off; on an iPhone, the video's own full screen (its page can't go full screen). */
export async function toggleFullscreen(video) {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else video.webkitEnterFullscreen?.();
  } catch {
    video.webkitEnterFullscreen?.();
  }
}

/**
 * A player closed: full screen ends, unless another player is taking its place (the router has already moved to the
 * page it's going to).
 */
export function playerLeft() {
  if (document.fullscreenElement && !PLAYER_PAGES.test(location.pathname)) document.exitFullscreen().catch(() => {});
}
