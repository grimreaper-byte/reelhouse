# What the Reelhouse screens show, made from the server's JSON: cards for rows and grids, the lines on an item's page,
# a guide programme's details. Pure Python (no Kodi), so it's tested on its own. The wording is the web app's (English,
# like the server's own row titles), so the screens read the same everywhere.
import re
import time
from datetime import datetime

# Image widths asked of Reelhouse (the web app's buckets), per use.
POSTER_W = 320
LOGO_W = 240
STILL_W = 480
BACKDROP_W = 1920
FACE_W = 240

LANGUAGES = {
    'eng': 'English', 'en': 'English', 'fre': 'French', 'fra': 'French', 'fr': 'French', 'ger': 'German', 'deu': 'German',
    'de': 'German', 'spa': 'Spanish', 'es': 'Spanish', 'ita': 'Italian', 'it': 'Italian', 'dut': 'Dutch', 'nld': 'Dutch',
    'nl': 'Dutch', 'jpn': 'Japanese', 'ja': 'Japanese', 'nor': 'Norwegian', 'nob': 'Norwegian', 'no': 'Norwegian',
    'swe': 'Swedish', 'sv': 'Swedish', 'dan': 'Danish', 'da': 'Danish', 'fin': 'Finnish', 'fi': 'Finnish', 'por': 'Portuguese',
    'pt': 'Portuguese', 'rus': 'Russian', 'ru': 'Russian', 'chi': 'Chinese', 'zho': 'Chinese', 'zh': 'Chinese', 'kor': 'Korean',
    'ko': 'Korean', 'pol': 'Polish', 'pl': 'Polish', 'tur': 'Turkish', 'tr': 'Turkish', 'ara': 'Arabic', 'ar': 'Arabic',
    'hin': 'Hindi', 'hi': 'Hindi', 'gle': 'Irish', 'ga': 'Irish', 'wel': 'Welsh', 'cym': 'Welsh', 'cy': 'Welsh',
}
CODECS = {
    'h264': 'H.264', 'hevc': 'HEVC', 'av1': 'AV1', 'vp9': 'VP9', 'vp8': 'VP8', 'mpeg4': 'MPEG-4', 'mpeg2video': 'MPEG-2',
    'vc1': 'VC-1', 'aac': 'AAC', 'ac3': 'Dolby Digital', 'eac3': 'Dolby Digital+', 'dts': 'DTS', 'truehd': 'TrueHD',
    'flac': 'FLAC', 'opus': 'Opus', 'mp3': 'MP3', 'vorbis': 'Vorbis', 'pcm_s16le': 'PCM', 'pcm_s24le': 'PCM',
    'subrip': 'SRT', 'ass': 'ASS', 'ssa': 'SSA', 'webvtt': 'WebVTT', 'mov_text': 'MP4 text', 'hdmv_pgs_subtitle': 'PGS',
    'dvd_subtitle': 'VobSub', 'dvb_subtitle': 'DVB', 'srt': 'SRT', 'vtt': 'WebVTT',
}


# ---------- the sidebar ----------

# The icons a library can have (server/libraries.js LIBRARY_ICONS, the web's names; build_icons.py draws them), and
# the ones with a spot of red over them (their "<name>-spot" texture).
LIBRARY_ICONS = ('film', 'tv', 'tvRecord', 'tvOld', 'tvFlat', 'tvPlay', 'clapperboard', 'movieCamera', 'trophy', 'heart')
ICON_SPOTS = ('tvRecord',)


def library_icon(lib):
    """The icon a library shows: its own, or its type's (from a server before icons, or one this add-on doesn't know)."""
    if lib.get('icon') in LIBRARY_ICONS:
        return lib['icon']
    return 'film' if lib.get('type') == 'movie' else 'tv'


def nav_position(keys, keep, lit):
    """Which of a sidebar list's entries to highlight once it's filled: the one it was on if it has the focus (`keep`),
    else the one for this screen (`lit`), else the first."""
    for key in (keep, lit):
        if key in keys:
            return keys.index(key)
    return 0


def back_step(home, on_sidebar, page_focus, on_exit):
    """What Back does. A screen over another closes (from the sidebar it goes back into the page first). Home never
    closes on Back, so the screens can't be left by accident: it goes to the sidebar, then onto Exit, then stays."""
    if not home:
        return 'page' if on_sidebar and page_focus else 'close'
    if not on_sidebar:
        return 'sidebar'
    return 'stay' if on_exit else 'exit'


# ---------- wording ----------

def format_time(seconds):
    """1:02:03, or 2:04 under an hour (a resume point)."""
    seconds = max(0, int(seconds or 0))
    h, m, s = seconds // 3600, (seconds // 60) % 60, seconds % 60
    return '{}:{:02d}:{:02d}'.format(h, m, s) if h else '{}:{:02d}'.format(m, s)


def format_duration(seconds):
    """'49 min', '1 hr 49 min', '2 hr' (a length)."""
    if not seconds:
        return ''
    mins = int(round(seconds / 60.0))
    if mins < 60:
        return '{} min'.format(mins)
    return ('{} hr {}'.format(mins // 60, '{} min'.format(mins % 60) if mins % 60 else '')).strip()


def format_bytes(n):
    if not n:
        return ''
    units = ['B', 'KB', 'MB', 'GB', 'TB']
    i = 0
    n = float(n)
    while n >= 1024 and i < len(units) - 1:
        n /= 1024
        i += 1
    return '{:.{p}f} {}'.format(n, units[i], p=2 if i >= 3 else 1 if i else 0)


def format_bitrate(bps):
    if not bps:
        return ''
    return '{:.1f} Mbps'.format(bps / 1e6) if bps >= 1e6 else '{} kbps'.format(int(round(bps / 1000.0)))


def codec_label(codec):
    return CODECS.get(codec) or (codec.upper() if codec else '')


def channels_label(n):
    return {1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1'}.get(n) or ('{} ch'.format(n) if n else '')


def language_name(code):
    if not code:
        return None
    return LANGUAGES.get(code.lower()) or code.upper()


def episode_label(item):
    """'S1 · E3', 'S1 · E3–4', 'Special · E2'."""
    season = item.get('seasonNumber')
    if season is None:
        return ''
    s = 'Special' if season == 0 else 'S{}'.format(season)
    ep = item.get('episodeNumber')
    if ep is None:
        return s
    e = 'E{}–{}'.format(ep, item['episodeEnd']) if item.get('episodeEnd') else 'E{}'.format(ep)
    return '{} · {}'.format(s, e)


def time_ago(ms, now=None):
    if not ms:
        return 'never'
    s = int(round(((now if now is not None else time.time()) * 1000 - ms) / 1000.0))
    if s < 60:
        return 'just now'
    if s < 3600:
        return '{} min ago'.format(s // 60)
    if s < 86400:
        return '{} hr ago'.format(s // 3600)
    days = s // 86400
    return 'yesterday' if days == 1 else '{} days ago'.format(days)


def resume_point(item):
    """Where Play carries on from: the saved position unless it's in the last 30 seconds (the apps' rule)."""
    pos = (item.get('state') or {}).get('position') or 0
    duration = item.get('duration')
    if not duration:
        return max(0, pos)
    return pos if 0 < pos < duration - 30 else 0


def watched_by_line(item, now=None):
    """'sam · 2 days ago', 'sam and jo · …', 'sam and 2 others · …' (Home's Watched by Others)."""
    people = item.get('watchedBy') or []
    who = '{} and {} others'.format(people[0], len(people) - 1) if len(people) > 2 else ' and '.join(people)
    when = time_ago(item['watchedAt'], now) if item.get('watchedAt') else None
    return ' · '.join(p for p in (who, when) if p)


# ---------- cards (rows and grids) ----------

def default_subtitle(item):
    kind = item.get('type')
    if kind == 'episode':
        return '{} · {}'.format(episode_label(item), item.get('title')) if item.get('show') else episode_label(item)
    if kind == 'season':
        count = item.get('leafCount') or 0
        return '1 episode' if count == 1 else '{} episodes'.format(count)
    if kind == 'show':
        count = item.get('childCount') or 0
        if count > 1:
            return '{} seasons'.format(count)
        return str(item['year']) if item.get('year') else ('1 season' if count else '')
    return str(item['year']) if item.get('year') else ''


def card(item, style='poster', subtitle=None, play=False):
    """A card as the web app draws it (posterCard / landscapeCard / hubCard), as plain values for a Kodi list item:

    label/label2  the lines under the picture
    art           image paths on Reelhouse (the window makes them addresses), with the width to ask for
    watched       a tick in the corner; badge: the unwatched count of a show or season
    position/duration  the progress bar (and where Play resumes)
    play          selecting it plays (Continue Watching) rather than opening its page
    """
    images = item.get('images') or {}
    kind = item.get('type')
    show = item.get('show') or {}
    if style == 'landscape':
        is_ep = kind == 'episode'
        art = {'thumb': ((images.get('thumb') if is_ep else images.get('backdrop') or images.get('thumb')), STILL_W)}
        label = show.get('title') if is_ep and show else item.get('title')
        label2 = '{} · {}'.format(episode_label(item), item.get('title')) if is_ep else (str(item['year']) if item.get('year') else '')
        play = True
    else:
        poster = images.get('poster') or (images.get('thumb') if kind == 'movie' else None)
        art = {'poster': (poster, POSTER_W)}
        if kind == 'season' and show:
            label = show.get('title')
            label2 = item.get('title') + (' · {} new'.format(item['newCount']) if item.get('newCount') else '')
        else:
            label = show.get('title') if kind == 'episode' and show else item.get('title')
            label2 = default_subtitle(item)
    if subtitle is not None:
        label2 = subtitle
    state = item.get('state') or {}
    out = {
        'id': item.get('id'), 'type': kind, 'label': label or '', 'label2': label2 or '', 'art': art,
        'watched': False, 'badge': '', 'position': 0, 'duration': item.get('duration') or 0, 'play': play,
        'title': item.get('title') or '',
    }
    if kind in ('show', 'season'):
        unwatched = (item.get('leafCount') or 0) - (item.get('viewedLeafCount') or 0)
        if unwatched > 0:
            out['badge'] = str(unwatched)
        elif item.get('leafCount'):
            out['watched'] = True
    elif state.get('watched') and not state.get('position'):
        out['watched'] = True
    if state.get('position') and item.get('duration'):
        out['position'] = state['position']
    return out


def channel_card(item):
    """A channel in Continue Watching: its logo and name, nothing about what's on. Selecting it plays it."""
    channel = item.get('channel') or {}
    name = channel.get('name') or ''
    return {
        'id': 0, 'type': 'channel', 'uuid': channel.get('uuid'), 'label': name, 'label2': '', 'title': name,
        'art': {'logo': (channel.get('icon'), LOGO_W)},
        'watched': False, 'badge': '', 'position': 0, 'duration': 0, 'play': True,
    }


def hub_cards(hub, now=None):
    """A Home row's cards: Continue Watching plays (and resumes); Watched by Others says who and when."""
    style = hub.get('style') or 'poster'
    cards = []
    for item in hub.get('items') or []:
        if item.get('type') == 'channel':
            cards.append(channel_card(item))
        elif hub.get('id') == 'others' and style != 'landscape':
            cards.append(card(item, subtitle=watched_by_line(item, now)))
        else:
            cards.append(card(item, style, play=hub.get('id') == 'continue'))
    return cards


# ---------- an item's page ----------

def quality_labels(item):
    """One badge per copy of a film with more than one (SD and 1080p, say), best first; else its own."""
    versions = item.get('versions') or []
    if versions:
        seen = []
        for v in versions:
            if v.get('label') and v['label'] not in seen:
                seen.append(v['label'])
        return seen
    return [item['videoResolution']] if item.get('videoResolution') else []


def meta_line(details):
    """The line under the title: year, seasons or episodes, length, rating, stars (quality badges are separate)."""
    i = details['item']
    kind = i.get('type')
    parts = []
    if kind == 'episode':
        parts += [episode_label(i), i.get('airDate')]
    elif kind == 'season':
        count = i.get('leafCount')
        if count is not None:
            parts.append('1 episode' if count == 1 else '{} episodes'.format(count))
    elif kind == 'show':
        parts.append(str(i['year']) if i.get('year') else None)
        count = i.get('childCount')
        if count is not None:
            parts.append('1 season' if count == 1 else '{} seasons'.format(count))
    else:
        parts.append(str(i['year']) if i.get('year') else None)
    if kind in ('movie', 'episode'):
        parts.append(format_duration(i.get('duration')))
    parts.append(i.get('contentRating'))
    if i.get('rating'):
        parts.append('★ {:.1f}'.format(i['rating']))
    return ' · '.join(p for p in parts if p)


def play_action(details):
    """What the big Play button does on a page: (label, item id, resume from, label of 'from the start' or None)."""
    i = details['item']
    if i.get('type') in ('movie', 'episode'):
        pos = resume_point(i)
        if pos > 0:
            return 'Resume from {}'.format(format_time(pos)), i['id'], pos, 'From the start'
        return 'Play', i['id'], 0, None
    nxt = details.get('onDeck')
    if not nxt:
        return None
    pos = resume_point(nxt)
    label = '{} {}'.format('Resume' if pos > 0 else 'Play', episode_label(nxt) or nxt.get('title'))
    return label, nxt['id'], pos, None


def credits_line(item):
    rows = []
    if item.get('directors'):
        rows.append('Director: ' + ', '.join(item['directors']))
    if item.get('studio'):
        rows.append(('Network: ' if item.get('type') == 'show' else 'Studio: ') + item['studio'])
    return '    '.join(rows)


def version_details(v):
    """A copy's picture, sound, file type, size and bitrate on one line (Play version…)."""
    parts = [
        '{}×{}'.format(v['width'], v['height']) if v.get('width') and v.get('height') else None,
        codec_label(v.get('videoCodec')), codec_label(v.get('audioCodec')), (v.get('container') or '').upper(),
        format_bytes(v.get('fileSize')), format_bitrate(v.get('bitrate')),
    ]
    return ' · '.join(p for p in parts if p)


def media_info_text(media, label=None):
    """A file's details for Kodi's text viewer (Media info)."""
    if not media:
        return 'No file details.'
    lines = []
    if label:
        lines.append('[B]{}[/B]'.format(label))
    if media.get('file'):
        lines.append('File: {}'.format(media['file']))
    lines.append(' · '.join(p for p in [(media.get('container') or '').upper(), format_time(media.get('duration')),
                                         format_bytes(media.get('fileSize')), format_bitrate(media.get('bitrate'))] if p))
    v = media.get('video')
    if v:
        lines += ['', '[B]Video[/B]', ' · '.join(p for p in [
            codec_label(v.get('codec')) + (' ({})'.format(v['profile']) if v.get('profile') else ''),
            '{}×{}'.format(v.get('width'), v.get('height')), '{} fps'.format(v['fps']) if v.get('fps') else None,
            '{}-bit'.format(v['bitDepth']) if v.get('bitDepth') else None, v.get('hdr')] if p)]
    audio = media.get('audio') or []
    if audio:
        lines += ['', '[B]Audio[/B]']
        for n, a in enumerate(audio, 1):
            lines.append('Track {}: {}'.format(n, ' · '.join(p for p in [
                language_name(a.get('language')) or 'Unknown', codec_label(a.get('codec')), channels_label(a.get('channels')),
                a.get('title'), '(default)' if a.get('isDefault') else None] if p)))
    subs = (media.get('subtitles') or []) + (media.get('external') or [])
    if subs:
        lines += ['', '[B]Subtitles[/B]']
        for n, s in enumerate(subs, 1):
            lines.append('{}: {}'.format(n, ' · '.join(p for p in [
                language_name(s.get('language')) or 'Unknown', codec_label(s.get('codec') or s.get('format')),
                s.get('title'), 'forced' if s.get('forced') else None] if p)))
    return '\n'.join(lines)


def person_facts(info):
    """'Born 30 May 1971 (age 55)', 'in Queens, New York, USA', 'Died …': whatever TMDB knows (the web's wording)."""
    if not info:
        return []
    lines = []
    if info.get('birthday'):
        lines.append('Born {}{}'.format(nice_date(info['birthday']),
                                        ' (age {})'.format(info['age']) if info.get('age') is not None and not info.get('deathday') else ''))
    if info.get('birthplace'):
        lines.append(('in {}' if info.get('birthday') else 'Born in {}').format(info['birthplace']))
    if info.get('deathday'):
        lines.append('Died {}{}'.format(nice_date(info['deathday']), ' (aged {})'.format(info['age']) if info.get('age') is not None else ''))
    return lines


def here_line(items):
    """'3 movies and 1 show on this server' (a person's page)."""
    movies = len([i for i in items if i.get('type') == 'movie'])
    shows = len(items) - movies
    parts = [p for p in ['{} movie{}'.format(movies, '' if movies == 1 else 's') if movies else None,
                         '{} show{}'.format(shows, '' if shows == 1 else 's') if shows else None] if p]
    return '{} on this server'.format(' and '.join(parts)) if parts else 'No movies on this server'


def part(item):
    """'as Vincent Hanna', or 'Director'."""
    return 'as {}'.format(item['role']) if item.get('role') else 'Director' if item.get('directed') else None


def nice_date(iso):
    try:
        d = datetime.strptime(iso, '%Y-%m-%d')
    except (TypeError, ValueError):
        return iso or ''
    return '{} {} {}'.format(d.day, d.strftime('%b'), d.year)


# ---------- Live TV ----------

GENRE_COLOURS = {  # the web app's, from Kodi's Estuary (RGB)
    1: (219, 120, 23), 2: (100, 154, 100), 3: (219, 217, 23), 4: (237, 14, 40), 5: (23, 219, 194), 6: (65, 234, 77),
    7: (0, 67, 236), 8: (198, 200, 203), 9: (158, 32, 158), 10: (147, 147, 207), 11: (29, 161, 177),
}
ELEV2 = (0x22, 0x26, 0x2B)
ELEV3 = (0x2C, 0x31, 0x37)


def genre_group(event):
    """A programme's genre group (first hex digit of its ETSI content code, 1..11), or None."""
    for code in event.get('genre') or []:
        g = int(code) >> 4
        if 1 <= g <= 11:
            return g
    return None


def mix(colour, base, amount):
    return tuple(int(round(c * amount + b * (1 - amount))) for c, b in zip(colour, base))


def kodi_colour(rgb, alpha=255):
    return '{:02X}{:02X}{:02X}{:02X}'.format(alpha, *rgb)


def programme_colour(event, now):
    """A guide block's background: the genre's colour at 30% over the block's grey, as in Kodi (and the web app)."""
    airing = event['start'] <= now < event['stop']
    base = ELEV3 if airing else ELEV2
    group = genre_group(event)
    rgb = mix(GENRE_COLOURS[group], base, 0.3) if group else base
    return kodi_colour(rgb, 0x99 if event['stop'] <= now else 0xFF)


def time_of(t):
    return datetime.fromtimestamp(t).strftime('%H:%M')


def day_label(t, now=None):
    d = datetime.fromtimestamp(t).date()
    today = datetime.fromtimestamp(now if now is not None else time.time()).date()
    days = (d - today).days
    if days == 0:
        return 'Today'
    if days == 1:
        return 'Tomorrow'
    if days == -1:
        return 'Yesterday'
    return '{} {} {}'.format(datetime.fromtimestamp(t).strftime('%A'), d.day, datetime.fromtimestamp(t).strftime('%b'))


def episode_of(event):
    if event.get('season') is not None and event.get('episode') is not None:
        return 'S{} E{}'.format(event['season'], event['episode'])
    if event.get('episodeLabel'):
        return event['episodeLabel']
    return 'Episode {}'.format(event['episode']) if event.get('episode') is not None else None


def recording_label(rec):
    state = rec.get('state')
    if state == 'scheduled':
        return 'Series recording' if rec.get('series') else 'Will be recorded'
    if state == 'failed':
        return 'Recording failed'
    return 'Recording now' if state == 'recording' else 'Skipped' if state == 'skipped' else 'Recorded'


def recording_marked(rec):
    """Whether the guide marks a programme as recording: not an episode of a series recording that's been skipped, or
    one that failed."""
    return bool(rec) and rec.get('state') not in ('skipped', 'failed')


def series_action(rec, past, can_record_series):
    """What the guide offers about a programme's series recording: 'cancel' for one a series recording made (its person's
    or an admin's), 'record' for the rest if the account may set them; None when it's over, or someone else's recording
    holds it."""
    if past or (rec and rec.get('canChange') is False):
        return None
    if rec and rec.get('series'):
        return 'cancel'
    return 'record' if can_record_series else None


def show_name(title):
    """A show's own name, as Reelhouse keeps it: without the "New: " UK guides put on new episodes."""
    return re.sub(r'^\s*new\s*:\s*', '', title or '', flags=re.I)


def programme_summary(event, channel, now):
    """The highlighted programme under the guide: time line, title, details line, description."""
    day = day_label(event['start'], now)
    airing = event['start'] <= now < event['stop']
    length = ('{} min left'.format(max(1, int(round((event['stop'] - now) / 60.0)))) if airing
              else '{} min'.format(int(round((event['stop'] - event['start']) / 60.0))))
    when = '{}{}–{}'.format('' if day == 'Today' else day + ', ', time_of(event['start']), time_of(event['stop']))
    meta = ' · '.join(p for p in [(channel or {}).get('name'), episode_of(event), event.get('subtitle'), length] if p)
    return {
        'time': when, 'title': event.get('title') or '', 'meta': meta, 'genre': event.get('genreName') or '',
        'group': genre_group(event), 'rec': recording_label(event['dvr']) if event.get('dvr') else '',
        'description': event.get('description') or event.get('summary') or 'No description.',
    }


# ---------- the Recordings screen ----------

RECORDING_STATES = (('recording', 'Recording now'), ('scheduled', 'Scheduled'), ('recorded', 'Recorded'), ('failed', 'Failed'))
# What each state offers, as in the web app: (the action Reelhouse takes, the menu entry, a line of detail, what's said
# once it's done).
RECORDING_ACTIONS = {
    'recording': ('stop', 'Stop recording', 'What’s recorded so far is kept', 'Recording stopped'),
    'scheduled': ('cancel', 'Cancel recording', '', 'Recording cancelled'),
    'recorded': ('delete', 'Delete recording', 'Its file goes from Tvheadend’s recordings drive', 'Recording deleted'),
    'failed': ('delete', 'Delete recording', 'Its file goes from Tvheadend’s recordings drive', 'Recording deleted'),
}
# An episode of a series recording while scheduled: cancelled, Tvheadend would schedule it again.
SKIP_ACTION = ('cancel', 'Skip this episode', 'The series recording carries on', 'Episode skipped')


def recording_action(rec):
    """What a recording offers (see RECORDING_ACTIONS), or None when it isn't this account's to change."""
    if not rec.get('canChange'):
        return None
    return SKIP_ACTION if rec.get('state') == 'scheduled' and rec.get('series') else RECORDING_ACTIONS.get(rec.get('state'))


def counts_line(counts):
    """'1 recording now · 2 scheduled · 5 recorded', as much as there is."""
    words = (('recording', 'recording now'), ('scheduled', 'scheduled'), ('recorded', 'recorded'), ('failed', 'failed'))
    return ' · '.join('{} {}'.format(counts.get(k), word) for k, word in words if counts.get(k))


def recordings_summary(shows):
    """'3 shows · 1 recording now · 9 scheduled · 2 recorded', for the top of the Recordings screen."""
    if not shows:
        return ''
    totals = {}
    for show in shows:
        for k, n in (show.get('counts') or {}).items():
            totals[k] = totals.get(k, 0) + n
    return '{} show{} · {}'.format(len(shows), '' if len(shows) == 1 else 's', counts_line(totals))


def drive_line(drive):
    """Tvheadend's recordings drive, across from Manage Recordings' title, as the web app's Settings → Live TV shows it:
    'Recordings drive · 400.00 GB free of 2.00 TB'; what recordings take up; under 10% free or not; how full, 0 to 100.
    All empty when Reelhouse didn't say."""
    if not drive:
        return {'label': '', 'hint': '', 'low': False, 'used': 0}
    free, total, recordings = drive['free'], drive['total'], drive.get('recordings')
    low = float(free) / total < 0.1
    return {
        'label': 'Recordings drive · {} free of {}{}'.format(format_bytes(free) or '0 B', format_bytes(total), ' · Low on space' if low else ''),
        'hint': '' if recordings is None else 'Recordings take up {}'.format(format_bytes(recordings)) if recordings else 'No recordings yet',
        'low': low,
        'used': min(100.0, max(0.0, (total - free) * 100.0 / total)),
    }


SECTION_COLUMNS = 8  # covers across a Manage Recordings section


def section_height(count):
    """How tall a Manage Recordings section with this many shows is (recording-show-grid.xml): its heading and one row
    of covers, or two (more scroll inside it)."""
    return 476 if count <= SECTION_COLUMNS else 896


# A page's grids (season-grid.xml, episode-grid.xml): cards across, a row's height, and the most of it that shows.
SEASON_GRID = (8, 420, 900)
EPISODE_GRID = (4, 336, 896)
GRID_HEADING = 50


def grid_height(count, grid):
    """How tall a page's grid with this many cards is: its heading and its rows, up to two and the top of a third, which
    says there's more (it scrolls inside itself)."""
    columns, row, most = grid
    rows = max(1, (count + columns - 1) // columns)
    return GRID_HEADING + min(rows * row, most)


def show_sections(shows):
    """Manage Recordings' sections, each a grid under its heading: [(section, its shows)] for Recording now; Recorded,
    newest first; Scheduled, soonest first. A show is in each section it has something for."""
    def recorded(s):
        counts = s.get('counts') or {}
        return (counts.get('recorded') or 0) + (counts.get('failed') or 0) > 0
    return [
        ('now', [s for s in shows if s.get('recordingNow')]),
        ('recorded', sorted([s for s in shows if recorded(s)], key=lambda s: -(s.get('latest') or 0))),
        ('scheduled', sorted([s for s in shows if s.get('nextScheduled') is not None], key=lambda s: s['nextScheduled'])),
    ]


def show_card(show, section, now):
    """A show's cover in a section: its name; 'Recording now', what it has recorded, or when its next one records; the
    count of recorded ones (Recorded) and the REC mark (Recording now)."""
    counts = show.get('counts') or {}
    if section == 'now':
        label2 = 'Recording now'
    elif section == 'recorded':
        label2 = counts_line({'recorded': counts.get('recorded'), 'failed': counts.get('failed')})
    else:
        # Only when: it's what this row is for, and a cover is too narrow for more.
        t = show['nextScheduled']
        label2 = '{}, {}'.format(day_label(t, now), time_of(t))
    return {
        'label': show.get('title') or '',
        'label2': label2,
        'badge': str(counts['recorded']) if section == 'recorded' and counts.get('recorded') else '',
        'recording': section == 'now',
    }


def series_recording_next(series, now, word='Next: '):
    """What a series recording is doing: 'Recording now', when its next episode records, or that none is yet."""
    if (series.get('counts') or {}).get('recording'):
        return 'Recording now'
    if series.get('next') is not None:
        return '{}{}, {}'.format(word, day_label(series['next'], now), time_of(series['next']))
    return 'Nothing scheduled yet'


def series_recording_card(series, now):
    """A series recording's cover on Manage Recordings: its show, what's next, and its channel."""
    return {
        'label': series.get('title') or '',
        'label2': series_recording_next(series, now, word=''),  # a cover is narrow
        'channel': (series.get('channel') or {}).get('name') or '',
        'recording': bool((series.get('counts') or {}).get('recording')),
    }


def cancel_series_text(title, someone_elses=False, who=None):
    """What cancelling a series recording asks; `who` set it, when that isn't the person asking."""
    text = ('New episodes of “{}” won’t be recorded any more, and what it has scheduled is cancelled. '
            'What’s recording now or already recorded stays.').format(title)
    if someone_elses:
        text += ' {} set it.'.format(who) if who else ' It wasn’t set through Reelhouse.'
    return text


def show_recordings(show):
    """A show's recordings in the order its page lists them: series by series, as Reelhouse sorted them."""
    return [r for season in show.get('seasons') or [] for r in season.get('recordings') or []]


SECTION_STATES = {'now': ('recording',), 'recorded': ('recorded', 'failed'), 'scheduled': ('scheduled',)}


def section_recordings(show, section):
    """What a show has in a section of Manage Recordings: who set those is what its cover there says."""
    return [r for r in show_recordings(show) if r.get('state') in SECTION_STATES[section]]


def owner_line(recs):
    """Who set these recordings, for a cover on Everyone's: every name, and the first person's picture (a path, or '')
    and first letter; only words, no letter, when nobody here set it through Reelhouse."""
    people = []
    for rec in recs:
        who = rec.get('owner')
        if who and who.get('id') not in [p.get('id') for p in people]:
            people.append(who)
    if not people:
        return {'names': 'Not set through Reelhouse', 'letter': '', 'avatar': ''}
    first = people[0]
    return {'names': ', '.join(p.get('username') or '' for p in people),
            'letter': (first.get('username') or '?')[:1].upper(), 'avatar': first.get('avatar') or ''}


def set_by(rec):
    """Who set a recording, for its details: 'Set by kid' with their picture (a path, or '') and first letter; only
    words, no letter, when it wasn't set through Reelhouse."""
    line = owner_line([rec])
    return dict(line, names='Set by {}'.format(line['names'])) if line['letter'] else line


def deletable(recs):
    """Recorded and failed recordings this account may delete: what Delete series and Delete show take."""
    return [r for r in recs if r.get('canChange') and r.get('state') in ('recorded', 'failed')]


def series_to_delete(show):
    """The show's numbered series with something to delete: [(season, its recordings)]."""
    return [(s['season'], s.get('recordings') or []) for s in show.get('seasons') or []
            if s.get('season') is not None and deletable(s.get('recordings') or [])]


def delete_many_text(recs):
    """What Delete series / Delete show asks: how many go, whose, and that what's still to come keeps recording."""
    gone = deletable(recs)
    waiting = sum(1 for r in recs if r.get('state') in ('scheduled', 'recording'))
    others = sum(1 for r in gone if not r.get('mine'))
    text = '{} will be deleted from Tvheadend’s recordings drive. This can’t be undone.'.format(
        'Its recording' if len(gone) == 1 else 'All {} of its recordings'.format(len(gone)))
    if others:
        text += ' They were set by someone else.' if others == len(gone) else ' {} of them {} set by someone else.'.format(
            others, 'was' if others == 1 else 'were')
    if waiting:
        text += ' The one still to come keeps recording.' if waiting == 1 else ' The {} still to come keep recording.'.format(waiting)
    return text


def recording_episode(rec):
    """How a recording is known on its show's page: 'S1 E4', 'Episode 4', 'Series 1', or None."""
    season, episode = rec.get('season'), rec.get('episode')
    if season is not None and episode is not None:
        return 'S{} E{}'.format(season, episode)
    if episode is not None:
        return 'Episode {}'.format(episode)
    return 'Series {}'.format(season) if season is not None else None


def recording_row(rec, now):
    """A recording's lines on its show's page: its episode (else its subtitle, else its title) and subtitle; the
    channel, day and times, length and size so far; its state, with Tvheadend's word when it didn't go to plan ("Time
    missed")."""
    channel = rec.get('channel') or {}
    name = channel.get('name')
    size = format_bytes(rec.get('size'))
    meta = ' · '.join(p for p in [
        '{} · {}'.format(channel['number'], name) if name and channel.get('number') is not None else name,
        '{}, {}–{}'.format(day_label(rec['start'], now), time_of(rec['start']), time_of(rec['stop'])),
        '{} min'.format(int(round((rec['stop'] - rec['start']) / 60.0))),
        size + (' so far' if size and rec.get('state') == 'recording' else ''),
    ] if p)
    state = rec.get('state') or ''
    status = rec.get('status')
    trouble = bool(status) and bool(state == 'failed' or rec.get('problem') or (state == 'recorded' and status != 'Completed OK'))
    label = dict(RECORDING_STATES).get(state, '')
    episode = recording_episode(rec)
    return {
        'title': episode or rec.get('subtitle') or rec.get('title') or '', 'subtitle': (rec.get('subtitle') or '') if episode else '',
        'meta': meta, 'state': state, 'statelabel': '{} · {}'.format(label, status) if trouble else label, 'trouble': trouble,
        'description': rec.get('description') or '', 'initials': (name or '')[:2],
    }


def series_name(season, show):
    """A series' name: 'Series 1'; recordings without a number 'Other recordings', or 'Recordings' when none have one."""
    if season.get('season') is not None:
        return 'Series {}'.format(season['season'])
    return 'Other recordings' if any(s.get('season') is not None for s in show.get('seasons') or []) else 'Recordings'


def series_what(season, show):
    """What deleting a series is called in its question: 'series 1 of “News”', or 'the other recordings of “News”'."""
    if season.get('season') is not None:
        return 'series {} of “{}”'.format(season['season'], show.get('title') or '')
    return 'the other recordings of “{}”'.format(show.get('title') or '')


def has_series(show):
    """Whether the guide gave series numbers (else the show opens straight to its episodes)."""
    return any(s.get('season') is not None for s in show.get('seasons') or [])


def series_card(season, show):
    """A series' cover on its show's page: its name, what it has, the count of recorded ones, recording now or not."""
    counts = season.get('counts') or {}
    return {
        'label': series_name(season, show),
        'label2': counts_line(counts),
        'badge': str(counts['recorded']) if counts.get('recorded') else '',
        'recording': bool(counts.get('recording')),
    }


def episode_card(rec, now):
    """An episode's picture on its series' page: 'Episode 4 · Part 4' (else its subtitle, else its title), its day, time,
    length and size, and its state ('REC', 'Scheduled', Tvheadend's word when it didn't go to plan)."""
    title = ' · '.join(p for p in ['Episode {}'.format(rec['episode']) if rec.get('episode') is not None else None,
                                   rec.get('subtitle')] if p) or rec.get('title') or ''
    size = format_bytes(rec.get('size'))
    when = ' · '.join(p for p in ['{}, {}'.format(day_label(rec['start'], now), time_of(rec['start'])),
                                  '{} min'.format(int(round((rec['stop'] - rec['start']) / 60.0))), size] if p)
    row = recording_row(rec, now)
    state = rec.get('state') or ''
    if row['trouble']:
        tag = rec.get('status') if state == 'recording' else row['statelabel']  # the reason: it's what fits on the card
    else:
        tag = 'REC' if state == 'recording' else 'Scheduled' if state == 'scheduled' else ''
    return {'label': title, 'label2': when, 'state': state, 'tag': tag, 'trouble': row['trouble']}
