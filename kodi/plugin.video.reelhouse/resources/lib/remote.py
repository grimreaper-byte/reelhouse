# The phone remote (server/remote.js): the Reelhouse app on a phone on the same network plays films, episodes and
# live channels in Kodi, pauses, skips or stops them, and picks their sound, subtitles and Kodi's volume. The
# service's live event stream brings the commands (it opens the stream as a target while "Let your phone control
# Kodi" is on, and shared with anyone at home while that's on too); each is done here with Kodi's player and
# answered, so the phone can say what happened. What Kodi offers the phone (its audio and subtitle streams, its
# volume) is reported as it changes (report_controls).
import json
import threading
import time
from urllib.parse import quote

import xbmc

from . import connection, utils
from .api import ApiError
from .ui import app
from .utils import string

SETTING = 'remote_control'
SHARED_SETTING = 'remote_shared'
NOTHING = 'Nothing from Reelhouse is playing in Kodi.'
# While Kodi opens an item it shows a busy dialog; opening another then makes Kodi quit ("two concurrent busydialogs",
# a known Kodi issue), as the phone's Next pressed twice did. So a play waits for the one before to have started.
BUSY = 'Window.IsActive(busydialog) | Window.IsActive(busydialognocancel)'
SETTLE_WITHIN = 30   # seconds to wait for Kodi to finish opening something
QUIET_FOR = 1.5      # seconds without a busy dialog after one that count as done
NEVER_BUSY = 5       # seconds: a play that neither shows a busy dialog nor starts in this long didn't happen
STEP = 0.1
VIDEO_PLAYER = 1     # Kodi's player id for video in JSON-RPC
TRACKS_SETTLE = 0.8  # seconds before reporting again after a sound track or subtitles were changed
STREAM_PROPERTIES = ['audiostreams', 'currentaudiostream', 'subtitles', 'currentsubtitle', 'subtitleenabled']

_reported = {'last': None}
_reported_lock = threading.Lock()


def events_query():
    """What the live stream is opened with: as a target while the phone may control Kodi (shared with anyone at
    home while that's on too)."""
    if not utils.setting_bool(SETTING):
        return None
    return {'target': 'kodi', 'shared': '1'} if utils.setting_bool(SHARED_SETTING) else {'target': 'kodi'}


def handle(player, command):
    """Does one command (the stream's remote event: {'id', 'type', …}) and answers it."""
    try:
        problem = run(player, command)
    except (ApiError, KeyError, TypeError, ValueError, RuntimeError) as err:
        utils.log('remote: {} failed: {}'.format(command.get('type'), err), xbmc.LOGWARNING)
        problem = str(err) or 'Kodi couldn’t do that.'
    answer(command.get('id'), problem)
    if command.get('type') in ('audio', 'subtitle', 'volume', 'mute'):
        report_controls(player)
        if command.get('type') in ('audio', 'subtitle') and TRACKS_SETTLE:
            # Kodi takes a moment to show a stream it was asked for (and says nothing when subtitles change): look
            # again, so the phone shows what's on.
            xbmc.Monitor().waitForAbort(TRACKS_SETTLE)
            report_controls(player)


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


def settle(player=None, item_id=None, playing=None):
    """Waits while Kodi is opening something (its busy dialog, then a moment without it). Given [item_id] (or a test
    of the player, [playing]), waits for the player to start that instead: True once it has. At most SETTLE_WITHIN
    seconds, and not while Kodi is closing."""
    if item_id is not None and playing is None:
        def playing(p):
            return (p.current or {}).get('id') == item_id
    end = time.time() + SETTLE_WITHIN
    seen_busy = False
    quiet_since = time.time()
    while time.time() < end and not _aborted():
        if playing is not None and playing(player):
            return True
        if xbmc.getCondVisibility(BUSY):
            seen_busy = True
            quiet_since = time.time()
        elif playing is None and not seen_busy:
            return True  # nothing being opened
        elif time.time() - quiet_since >= (QUIET_FOR if seen_busy else NEVER_BUSY):
            return playing is None
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


def play_channel(uuid, player=None):
    """A live channel or radio station, full screen, as Reelhouse's own live TV controls change channel: started at
    Reelhouse first (the one playing goes on meanwhile and is let go once this one runs), then its stream handed to
    Kodi. Waits for what Kodi is opening first, then for this channel to play."""
    from . import plugin
    settle()
    item = plugin.start_channel(uuid)  # says why when it can't
    if item is None:
        return False
    utils.ask_full_screen()
    xbmc.Player().play(item.getPath(), item)
    if player is None:
        return True
    return settle(player, playing=lambda p: (p.live or {}).get('uuid') == uuid)


def run(player, command):
    """Does a command: None when it's done, else what went wrong (for the phone)."""
    kind = command.get('type')
    if kind == 'play' and command.get('channel'):
        if command.get('from') and not command.get('zap'):
            utils.notify(string(30143) % command['from'])
        if not play_channel(command['channel'], player):
            return 'Kodi didn’t start the channel.'
        return None
    if kind in ('play', 'next', 'previous'):
        if kind == 'play' and command.get('from'):
            utils.notify(string(30143) % command['from'])
        if not play(command['itemId'], max(0.0, float(command.get('start') or 0)), player):
            return 'Kodi didn’t start it.'
        return None
    if kind == 'volume':
        level = max(0, min(100, int(command['level'])))
        utils.rpc('Application.SetVolume', volume=level)
        if level > 0:
            utils.rpc('Application.SetMute', mute=False)
        return None
    if kind == 'mute':
        utils.rpc('Application.SetMute', mute=bool(command.get('muted')))
        return None
    settle()  # not while Kodi is opening something
    if not player.current and not player.live:
        return NOTHING
    paused = xbmc.getCondVisibility('Player.Paused')
    if kind == 'pause':
        if not paused:
            player.pause()  # toggles; Kodi's onPlayBackPaused reports it
    elif kind == 'resume':
        if paused:
            player.pause()
    elif kind in ('seek', 'skip'):
        if player.live:
            return 'A channel can’t be wound on or back from the phone.'
        to = float(command['position']) if kind == 'seek' else player._time() + float(command['seconds'])
        to = max(0.0, to)
        player.seekTime(to)
        player.position = to
        player.report('paused' if paused else 'playing')
    elif kind == 'stop':
        player.stop()
    elif kind == 'audio':
        if utils.rpc('Player.SetAudioStream', playerid=VIDEO_PLAYER, stream=int(command['track'])) is None:
            return 'Kodi couldn’t change the sound track.'
    elif kind == 'subtitle':
        track = command.get('track')
        if track is None:
            utils.rpc('Player.SetSubtitle', playerid=VIDEO_PLAYER, subtitle='off')
        elif utils.rpc('Player.SetSubtitle', playerid=VIDEO_PLAYER, subtitle=int(track), enable=True) is None:
            return 'Kodi couldn’t change the subtitles.'
    else:
        return 'Kodi doesn’t know that one yet.'
    return None


# ---------- what Kodi offers the phone ----------

def _language(code):
    if not code:
        return ''
    try:
        return xbmc.convertLanguage(code, xbmc.ENGLISH_NAME) or code
    except (RuntimeError, TypeError, AttributeError):
        return code


def audio_label(stream):
    """'English · AC3 · 5.1', as far as Kodi says."""
    channels = stream.get('channels') or 0
    layout = {1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1'}.get(channels, '{} channels'.format(channels) if channels else '')
    parts = [stream.get('name') or _language(stream.get('language')) or 'Track {}'.format(stream.get('index', 0) + 1),
             (stream.get('codec') or '').upper(), layout]
    return ' · '.join(dict.fromkeys(p for p in parts if p))


def subtitle_label(stream):
    """'English (forced)', as far as Kodi says."""
    name = stream.get('name') or _language(stream.get('language')) or 'Subtitles {}'.format(stream.get('index', 0) + 1)
    return name + (' (forced)' if stream.get('isforced') else '')


def controls_now(player):
    """What the phone may change here ({audio, audioId, subtitles, subtitleId, volume, muted, canPause}), or {} when
    nothing from Reelhouse plays."""
    if not player.current and not player.live:
        return {}
    st = utils.rpc('Player.GetProperties', playerid=VIDEO_PLAYER, properties=STREAM_PROPERTIES) or {}
    sound = utils.rpc('Application.GetProperties', properties=['volume', 'muted']) or {}
    audio = [s for s in st.get('audiostreams') or [] if isinstance(s, dict) and 'index' in s]
    subs = [s for s in st.get('subtitles') or [] if isinstance(s, dict) and 'index' in s]
    current_audio = (st.get('currentaudiostream') or {}).get('index')
    current_sub = (st.get('currentsubtitle') or {}).get('index') if st.get('subtitleenabled') else None
    live = player.live or {}
    # A channel pauses only with InputStream FFmpeg Direct (plugin.start_channel uses it when it's there); radio never.
    can_pause = bool(player.current) or (not live.get('radio')
                                         and xbmc.getCondVisibility('System.AddonIsEnabled({})'.format(utils.TIMESHIFT_PLAYER)))
    return {
        'audio': [{'id': str(s['index']), 'label': audio_label(s)} for s in audio],
        'audioId': str(current_audio) if current_audio is not None and current_audio >= 0 else None,
        'subtitles': [{'id': str(s['index']), 'label': subtitle_label(s)} for s in subs],
        'subtitleId': str(current_sub) if current_sub is not None and current_sub >= 0 else None,
        'volume': int(sound['volume']) if isinstance(sound.get('volume'), (int, float)) else None,
        'muted': bool(sound.get('muted')),
        'canPause': can_pause,
    }


def forget_controls():
    """A new stream: the next report goes out even if nothing changed."""
    with _reported_lock:
        _reported['last'] = None


def report_controls(player):
    """Tells Reelhouse what the phone may change now (the service sends it in order with the progress reports), when
    it has changed since the last time and Kodi takes the phone's commands."""
    if events_query() is None:
        return
    try:
        body = controls_now(player)
    except RuntimeError:
        return
    text = json.dumps(body, sort_keys=True)
    with _reported_lock:
        if text == _reported['last']:
            return
        _reported['last'] = text
    player.service.send('controls', body)
