# The sound track and subtitles a film or episode from Reelhouse starts with, as Settings → Languages says (the same
# rule as the web app's and the Android app's). Kodi would show the track a file marks as its default, or one in
# Kodi's preferred subtitle language; here, by the server's subtitle mode:
#   off      none, forced ones too (anyone can still turn them on in Kodi's player);
#   forced   only a file's forced subtitles (the parts in another language) for the sound playing (the default);
#   foreign  the preferred language's subtitles while the sound is in another language, else as forced;
#   always   the preferred language's subtitles, else as forced.
# Moving on to the next or previous episode keeps the subtitles that were showing (or off) whatever the mode. With a
# preferred audio language, a file whose sound Kodi chose is in another language switches to a track in it. The
# service applies it as the picture starts (service.Player), and tells this module the server's choices (defaults).
import re

from . import utils

VIDEO_PLAYER = 1  # Kodi's player id for video in JSON-RPC
PROPERTIES = ['subtitleenabled', 'currentsubtitle', 'subtitles', 'currentaudiostream', 'audiostreams']
FORCED_NAME = re.compile(r'forced|foreign|signs|songs|parts|non[ -]?english|narrative', re.I)
SDH_NAME = re.compile(r'\bsdh\b|hearing[ -]impaired|\bcc\b', re.I)

# The server's defaults.audio ({language, codes}) and defaults.subtitles ({mode, language, codes}): each language with
# every code a file may use for it. Until the service has heard them, subtitles are as "forced" and the sound Kodi's.
_defaults = {'audio': {}, 'subtitles': {}}


def set_defaults(defaults):
    """Takes the server's defaults (from the event stream's hello, and its defaults event when an admin changes
    them); older servers send none of these, which keeps the behaviour from before."""
    defaults = defaults if isinstance(defaults, dict) else {}
    _defaults['audio'] = defaults.get('audio') if isinstance(defaults.get('audio'), dict) else {}
    _defaults['subtitles'] = defaults.get('subtitles') if isinstance(defaults.get('subtitles'), dict) else {}


def _plain(code):
    """A language tag as the server's codes list it: lower case, no region ("en-US" -> "en")."""
    return re.split(r'[-_]', (code or '').strip().lower())[0]


def _in(code, codes):
    return bool(_plain(code)) and _plain(code) in (codes or [])


def believed_forced(sub, subs):
    """Whether a track Kodi says is forced really is forced subtitles (only the parts in another language), as the
    server decides it (server/media/forced.js): its name says so, or it sits beside an ordinary track in the same
    language. Some releases flag their only, full track forced (The Big Bang Theory's, named "English"), which would
    otherwise come on for every episode."""
    if not sub or not sub.get('isforced'):
        return False
    if FORCED_NAME.search(sub.get('name') or ''):
        return True
    language = sub.get('language') or ''
    return any(o is not sub and o.get('index') != sub.get('index') and not o.get('isforced')
               and (o.get('language') or '') == language for o in subs)


def _subs(st):
    return [s for s in (st or {}).get('subtitles') or [] if isinstance(s, dict) and 'index' in s]


def _sdh(sub):
    return bool(sub.get('isimpaired')) or bool(SDH_NAME.search(sub.get('name') or ''))


def preferred(subs, codes):
    """The track in the preferred language to turn on: a full one (not forced) before one for the deaf and hard of
    hearing (Kodi 20's isimpaired, or SDH in its name); None when the file has none in it."""
    same = [s for s in subs if _in(s.get('language'), codes) and not believed_forced(s, subs)]
    return next((s for s in same if not _sdh(s)), None) or (same[0] if same else None)


def state():
    """What Kodi's video player has: subtitleenabled, currentsubtitle, subtitles (each with index, language, name,
    and isforced/isimpaired on Kodi 20 and later), currentaudiostream and audiostreams. None when it can't say
    (nothing playing)."""
    result = utils.rpc('Player.GetProperties', playerid=VIDEO_PLAYER, properties=PROPERTIES)
    return result if isinstance(result, dict) else None


def shown(st):
    """The subtitles on screen, to carry on to the episode Kodi moves to: {'language'}; {'off': True} when they're off
    though the file has forced ones (turned off, which stays off); or None (off, or a file's forced ones only, which
    the next episode finds for itself)."""
    if not st:
        return None
    subs = _subs(st)
    if not st.get('subtitleenabled'):
        return {'off': True} if any(believed_forced(s, subs) for s in subs) else None
    current = st.get('currentsubtitle') or {}
    if not current:
        return None
    listed = next((s for s in subs if s.get('index') == current.get('index')), current)
    if believed_forced(listed, subs):
        return None
    return {'language': current.get('language') or ''}


def choose_audio(st):
    """The sound track to switch to (its index), or None to keep Kodi's: one in the preferred audio language when
    the one playing isn't in it."""
    codes = (_defaults['audio'] or {}).get('codes') or []
    if not codes or not st:
        return None
    current = st.get('currentaudiostream') or {}
    if _in(current.get('language'), codes):
        return None
    streams = [a for a in st.get('audiostreams') or [] if isinstance(a, dict) and 'index' in a]
    pick = next((a for a in streams if _in(a.get('language'), codes)), None)
    return pick['index'] if pick is not None and pick['index'] != current.get('index') else None


def choose(st, carried=None):
    """The subtitle track to start with (its index), or None for off: those carried from the episode before
    (`carried`, as shown() gave), else as the server's subtitle mode says (see the top), with a file's forced ones
    found as before: the one Kodi picked, one in the sound's language, or one the file marks as its default."""
    subs = _subs(st)
    if carried and carried.get('off'):
        return None  # turned off in the episode before: off here too
    if carried:
        language = carried.get('language') or ''
        same = [s for s in subs if (s.get('language') or '') == language]
        pick = next((s for s in same if not s.get('isforced')), None) or (same[0] if same else None)
        if pick is None and not language:
            pick = next((s for s in subs if not s.get('isforced')), None)
        if pick is not None:
            return pick['index']
    prefs = _defaults['subtitles'] or {}
    mode = prefs.get('mode') or 'forced'
    if mode == 'off':
        return None
    audio = ((st or {}).get('currentaudiostream') or {}).get('language') or ''
    known = _plain(audio) not in ('', 'und')
    if mode == 'always' or (mode == 'foreign' and known and not _in(audio, prefs.get('codes'))):
        pick = preferred(subs, prefs.get('codes'))
        if pick is not None:
            return pick['index']
    forced = [s for s in subs if believed_forced(s, subs)]
    current = (st or {}).get('currentsubtitle') or {}
    if (st or {}).get('subtitleenabled') and current.get('isforced') and \
            any(s['index'] == current.get('index') for s in forced):
        return current['index']
    pick = next((s for s in forced if audio and s.get('language') == audio), None) or \
        next((s for s in forced if s.get('isdefault')), None)
    return pick['index'] if pick is not None else None


def start(carried=None):
    """Sets the sound track and the subtitles of what just started playing (see choose_audio and choose). Returns the
    subtitle index shown, or None (off)."""
    st = state()
    if st is None:
        return None
    audio = choose_audio(st)
    if audio is not None:
        utils.rpc('Player.SetAudioStream', playerid=VIDEO_PLAYER, stream=audio)
        picked = next((a for a in st.get('audiostreams') or [] if isinstance(a, dict) and a.get('index') == audio), None)
        if picked is not None:
            st = dict(st, currentaudiostream=picked)  # the subtitles follow the sound now playing
    index = choose(st, carried)
    current = st.get('currentsubtitle') or {}
    if index is None:
        if st.get('subtitleenabled'):
            utils.rpc('Player.SetSubtitle', playerid=VIDEO_PLAYER, subtitle='off')
    elif not (st.get('subtitleenabled') and current.get('index') == index):
        utils.rpc('Player.SetSubtitle', playerid=VIDEO_PLAYER, subtitle=index, enable=True)
    return index
