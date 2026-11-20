# The phone remote (server/remote.js): the Reelhouse app on a phone on the same network plays films and episodes in
# Kodi and pauses, skips or stops them. The service's live event stream brings the commands (it opens the stream as
# a target while "Let your phone control Kodi" is on); each is done here with Kodi's player and answered, so the
# phone can say what happened. Live TV and radio don't take the phone's commands yet.
import time
from urllib.parse import quote

import xbmc

from . import connection, utils
from .api import ApiError
from .ui import app
from .utils import string

SETTING = 'remote_control'
NOTHING = 'Nothing from Reelhouse is playing in Kodi.'
# While Kodi opens an item it shows a busy dialog; opening another then makes Kodi quit ("two concurrent busydialogs",
# a known Kodi issue), as the phone's Next pressed twice did. So a play waits for the one before to have started.
BUSY = 'Window.IsActive(busydialog) | Window.IsActive(busydialognocancel)'
SETTLE_WITHIN = 30   # seconds to wait for Kodi to finish opening something
QUIET_FOR = 1.5      # seconds without a busy dialog after one that count as done
NEVER_BUSY = 5       # seconds: a play that neither shows a busy dialog nor starts in this long didn't happen
STEP = 0.1


def events_query():
    """What the live stream is opened with: as a target while the phone may control Kodi."""
    return {'target': 'kodi'} if utils.setting_bool(SETTING) else None


def handle(player, command):
    """Does one command (the stream's remote event: {'id', 'type', …}) and answers it."""
    try:
        problem = run(player, command)
    except (ApiError, KeyError, TypeError, ValueError, RuntimeError) as err:
        utils.log('remote: {} failed: {}'.format(command.get('type'), err), xbmc.LOGWARNING)
        problem = str(err) or 'Kodi couldn’t do that.'
    answer(command.get('id'), problem)


def answer(command_id, problem):
    if not command_id:
        return
    try:
        connection.api().post('/api/remote/commands/{}/done'.format(quote(str(command_id))),
                              {'ok': problem is None, 'problem': problem}, timeout=5)
    except ApiError as err:
        utils.log('remote: the answer wasn\'t sent ({})'.format(err), xbmc.LOGDEBUG)


def _aborted():
    return xbmc.Monitor().abortRequested()


def settle(player=None, item_id=None):
    """Waits while Kodi is opening something (its busy dialog, then a moment without it). Given [item_id], waits
    for the player to start that item instead: True once it has. At most SETTLE_WITHIN seconds, and not while
    Kodi is closing."""
    end = time.time() + SETTLE_WITHIN
    seen_busy = False
    quiet_since = time.time()
    while time.time() < end and not _aborted():
        if item_id is not None and (player.current or {}).get('id') == item_id:
            return True
        if xbmc.getCondVisibility(BUSY):
            seen_busy = True
            quiet_since = time.time()
        elif item_id is None and not seen_busy:
            return True  # nothing being opened
        elif time.time() - quiet_since >= (QUIET_FOR if seen_busy else NEVER_BUSY):
            return item_id is None
        time.sleep(STEP)
    return False


def play(item_id, start, player=None):
    """As the Reelhouse screens play it: full screen, the episodes after it queued for Kodi's Next. Waits for what
    Kodi is opening first, then for this one to start, so the next command can't open another on top of it."""
    api = connection.api()
    details = api.get('/api/items/{}'.format(int(item_id)), timeout=10)
    item = details.get('item') or {}
    settle()
    app.play(int(item_id), start, app.episode_queue(api, item), title=item.get('title'))
    return settle(player, int(item_id)) if player is not None else True


def run(player, command):
    """Does a command: None when it's done, else what went wrong (for the phone)."""
    kind = command.get('type')
    if kind in ('play', 'next', 'previous'):
        if kind == 'play' and command.get('from'):
            utils.notify(string(30143) % command['from'])
        if not play(command['itemId'], max(0.0, float(command.get('start') or 0)), player):
            return 'Kodi didn’t start it.'
        return None
    settle()  # not while Kodi is opening something
    if not player.current:
        return NOTHING
    paused = xbmc.getCondVisibility('Player.Paused')
    if kind == 'pause':
        if not paused:
            player.pause()  # toggles; Kodi's onPlayBackPaused reports it
    elif kind == 'resume':
        if paused:
            player.pause()
    elif kind in ('seek', 'skip'):
        to = float(command['position']) if kind == 'seek' else player._time() + float(command['seconds'])
        to = max(0.0, to)
        player.seekTime(to)
        player.position = to
        player.report('paused' if paused else 'playing')
    elif kind == 'stop':
        player.stop()
    else:
        return 'Kodi doesn’t know that one yet.'
    return None
