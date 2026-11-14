# Subtitles start off when a film or episode from Reelhouse plays, as in the web app and the Android app. Kodi
# would show the track a file marks as its default, or one in Kodi's preferred subtitle language. A file's forced
# subtitles (the parts in another language) still show, and moving on to the next or previous episode keeps the
# subtitles that were showing. The service applies it as the picture starts (service.Player).
from . import utils

VIDEO_PLAYER = 1  # Kodi's player id for video in JSON-RPC
PROPERTIES = ['subtitleenabled', 'currentsubtitle', 'subtitles', 'currentaudiostream']


def state():
    """What Kodi's video player has: subtitleenabled, currentsubtitle, subtitles (each with index, language, name,
    and isforced on Kodi 20 and later) and currentaudiostream. None when it can't say (nothing playing)."""
    result = utils.rpc('Player.GetProperties', playerid=VIDEO_PLAYER, properties=PROPERTIES)
    return result if isinstance(result, dict) else None


def shown(st):
    """The subtitles on screen, to carry on to the episode Kodi moves to: {'language'}, or None when they're off or
    are a file's forced ones only."""
    if not st or not st.get('subtitleenabled'):
        return None
    current = st.get('currentsubtitle') or {}
    if not current or current.get('isforced'):
        return None
    return {'language': current.get('language') or ''}


def choose(st, carried=None):
    """The subtitle track to start with (its index), or None for off: those carried from the episode before
    (`carried`, as shown() gave), else a forced track: the one Kodi picked, one in the audio's language, or one the
    file marks as its default."""
    subs = [s for s in (st or {}).get('subtitles') or [] if isinstance(s, dict) and 'index' in s]
    if carried:
        language = carried.get('language') or ''
        same = [s for s in subs if (s.get('language') or '') == language]
        pick = next((s for s in same if not s.get('isforced')), None) or (same[0] if same else None)
        if pick is None and not language:
            pick = next((s for s in subs if not s.get('isforced')), None)
        if pick is not None:
            return pick['index']
    forced = [s for s in subs if s.get('isforced')]
    current = (st or {}).get('currentsubtitle') or {}
    if (st or {}).get('subtitleenabled') and current.get('isforced') and \
            any(s['index'] == current.get('index') for s in forced):
        return current['index']
    audio = ((st or {}).get('currentaudiostream') or {}).get('language') or ''
    pick = next((s for s in forced if audio and s.get('language') == audio), None) or \
        next((s for s in forced if s.get('isdefault')), None)
    return pick['index'] if pick is not None else None


def start(carried=None):
    """Sets the subtitles of what just started playing (see choose). Returns the index shown, or None (off)."""
    st = state()
    if st is None:
        return None
    index = choose(st, carried)
    current = st.get('currentsubtitle') or {}
    if index is None:
        if st.get('subtitleenabled'):
            utils.rpc('Player.SetSubtitle', playerid=VIDEO_PLAYER, subtitle='off')
    elif not (st.get('subtitleenabled') and current.get('index') == index):
        utils.rpc('Player.SetSubtitle', playerid=VIDEO_PLAYER, subtitle=index, enable=True)
    return index
