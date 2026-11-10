# The Reelhouse screens in Kodi (the web app's look, driven by a remote): started from the add-on's menu or when Kodi
# starts. Home is the first screen; others open over it, and the sidebar jumps back through Home to another place.
# Back on Home doesn't leave: the sidebar's Exit does.
# Playing goes through the add-on's plugin (mode=play / mode=live), so streams, subtitles and progress reports are
# the same as for Kodi's own library.
import json
import threading
from urllib.parse import urlencode

import xbmc
import xbmcgui

from .. import connection, utils
from ..api import ApiError
from . import model

RUNNING_PROPERTY = 'reelhouse.ui'
PLUGIN = 'plugin://{}/'.format(utils.ADDON_ID)
HAS_MEDIA = 'Player.HasMedia'  # as Kodi's own Now playing button (a film or channel may carry on behind the screens)


TIMESHIFT_ASKED = 'asked_timeshift'  # the add-on's hidden setting: InputStream FFmpeg Direct was offered

def plugin_url(**params):
    return PLUGIN + '?' + urlencode(dict((k, v) for k, v in params.items() if v not in (None, '')))


class App(object):
    def __init__(self):
        self.api = connection.api()
        self.me = {}
        self.libraries = []
        self.pending = None   # where the sidebar asked to go: ('library', 3), ('home',)… or ('exit',)
        self.library_views = {}  # each library's sort and filter while the screens are open
        self.screens = []        # the open screens' Kodi window ids, the top one last

    # ---------- the account ----------

    def load_account(self):
        self.me = self.api.get('/api/me')
        self.libraries = self.api.get('/api/libraries').get('libraries') or []

    def user(self):
        return (self.me or {}).get('user') or {}

    def live_tv(self):
        return (self.me or {}).get('liveTv') or {}

    def timeshift_wanted(self):
        """Live TV here, InputStream FFmpeg Direct (pausing it) not, and not offered before."""
        return bool(self.live_tv().get('available')) and not utils.setting_bool(TIMESHIFT_ASKED) and \
            not xbmc.getCondVisibility('System.HasAddon({})'.format(utils.TIMESHIFT_PLAYER))

    @staticmethod
    def showing(window_id):
        """Notes the screen on top, so Open Reelhouse can bring the screens back if Kodi shows another window."""
        xbmcgui.Window(utils.HOME).setProperty(RUNNING_PROPERTY, str(window_id))

    def closed(self, window_id):
        """A screen closed: the one under it is on top again. Kodi goes back through its own window history, so when
        its home screen was opened over the screens it lands there instead: then the screen is brought back."""
        if window_id in self.screens:
            self.screens.remove(window_id)
        if self.screens and not xbmc.Monitor().abortRequested():
            top = self.screens[-1]
            self.showing(top)
            if xbmcgui.getCurrentWindowId() != top:
                xbmc.executebuiltin('ActivateWindow({})'.format(top))

    def change_mark(self):
        return xbmcgui.Window(utils.HOME).getProperty(utils.CHANGED_PROPERTY)

    def image(self, path, width):
        """An image on Reelhouse at the width the screen shows it (Kodi fetches it, with the token, and caches it)."""
        if not path:
            return ''
        if path.startswith('http'):
            return path
        return self.api.media_url(path, w=width)

    # ---------- the sidebar ----------

    @staticmethod
    def playing():
        return bool(xbmc.getCondVisibility(HAS_MEDIA))

    def nav_items(self, playing=False):
        """The sidebar's entries, (key, label, icon, count): those from its top (Now playing while something plays, Home,
        the libraries in the web app's order, Search), and those kept at its bottom (Live TV, Radio and Manage
        Recordings, Settings, Exit)."""
        top = [('fullscreen', 'Now playing', 'fullscreen', '')] if playing else []
        top.append(('home', 'Home', 'home', ''))
        for lib in self.libraries:
            top.append(('library:{}'.format(lib['id']), lib['name'], model.library_icon(lib), str(lib.get('count') or '')))
        top.append(('search', 'Search', 'search', ''))
        bottom = []
        live = self.live_tv()
        if live.get('available'):
            bottom.append(('livetv', 'Live TV', 'tv', ''))
            if live.get('radio') is not False:
                bottom.append(('radio', 'Radio', 'radio', ''))
            if live.get('canRecord'):
                bottom.append(('recordings', 'Manage Recordings', 'record', ''))  # the recordings you set from the guide
        bottom.append(('settings', 'Settings', 'settings', ''))
        bottom.append(('exit', 'Exit', 'signOut', ''))  # back to Kodi (Back on Home doesn't leave)
        return top, bottom

    @staticmethod
    def target_for(key):
        if key.startswith('library:'):
            return ('library', int(key.split(':', 1)[1]))
        return (key,)

    # ---------- screens ----------

    def show(self, target):
        """Opens a screen over the current one; returns when it's closed."""
        from .windows import home, library, item, person, search, livetv, recordings, recording_show, recording_series
        kind = target[0]
        if kind == 'home':
            home.Home.open(self)
        elif kind == 'library':
            lib = next((l for l in self.libraries if l['id'] == target[1]), {'id': target[1], 'name': '', 'type': 'movie'})
            library.Library.open(self, library_info=lib, nav='library:{}'.format(target[1]))
        elif kind == 'item':
            item.Item.open(self, item_id=target[1])
        elif kind == 'person':
            person.Person.open(self, name=target[1], from_item=target[2] if len(target) > 2 else None)
        elif kind == 'search':
            search.Search.open(self, nav='search')
        elif kind in ('livetv', 'radio'):
            livetv.LiveTv.open(self, radio=kind == 'radio', nav=kind)
        elif kind == 'recordings':
            recordings.Recordings.open(self, nav='recordings')
        elif kind == 'recording-show':  # ('recording-show', key, title, everyone's)
            recording_show.RecordingShow.open(self, key=target[1], title=target[2], everyone=target[3], nav='recordings')
        elif kind == 'recording-series':  # ('recording-series', key, show's title, series number or None, everyone's)
            recording_series.RecordingSeries.open(self, key=target[1], title=target[2], season=target[3], everyone=target[4],
                                                  nav='recordings')

    # ---------- playing ----------

    def play(self, item_id, start=0, queue=(), title=None):
        """Plays a film or episode from `start` seconds, then the episodes in `queue` after it: [(id, what Kodi's player
        is told of it)], as episode_queue() makes them, so Kodi's "Next" line says which comes next. The one starting
        is told as it starts (plugin.play)."""
        playlist = xbmc.PlayList(xbmc.PLAYLIST_VIDEO)
        playlist.clear()
        for n, (iid, info) in enumerate([(item_id, {'title': title} if title else {})] + list(queue)):
            li = xbmcgui.ListItem(info.get('title') or '')
            li.setProperty('IsPlayable', 'true')
            if n:
                utils.set_video_info(li, info)
            playlist.add(plugin_url(mode='play', id=int(iid), start=int(start) if n == 0 and start else None,
                                    screens=1), li)
        xbmc.Player().play(playlist)

    def episode_queue(self, episode):
        """The episodes after one in its season (Kodi plays on into them)."""
        if episode.get('type') != 'episode' or not episode.get('parentId'):
            return []
        try:
            season = self.api.get('/api/items/{}'.format(int(episode['parentId'])))
        except ApiError:
            return []
        eps = season.get('children') or []
        ids = [e['id'] for e in eps]
        if episode['id'] not in ids:
            return []
        show = (season.get('show') or {}).get('title')
        return [(e['id'], model.player_info(e, show)) for e in eps[ids.index(episode['id']) + 1:]]

    def play_item(self, item, start=None):
        """Plays an item as its card or page has it: resuming unless told where to start."""
        if start is None:
            start = model.resume_point(item)
        self.play(item['id'], start, self.episode_queue(item), title=item.get('title'))

    def play_live(self, channels, index, radio):
        """Plays a channel. A TV channel plays on its own: Reelhouse's player controls (live_osd.py) change channel
        themselves, from the guide's channels left on the home window, as Kodi's playlist made Kodi quit (opening
        the next channel's item at once when one couldn't play, skipping on through the rest). Radio stations follow
        each other in Kodi's music playlist, so its next/previous change station."""
        if not radio:
            c = channels[index]
            xbmcgui.Window(utils.HOME).setProperty(utils.CHANNELS_PROPERTY, json.dumps(
                [{'uuid': ch['uuid'], 'name': ch.get('name') or ''} for ch in channels]))
            li = xbmcgui.ListItem(c.get('name') or '')
            li.setProperty('IsPlayable', 'true')
            if c.get('icon'):
                logo = self.image(c['icon'], 240)
                li.setArt({'thumb': logo, 'icon': logo})
            xbmc.Player().play(plugin_url(mode='live', channel=c['uuid']), li)
            return
        playlist = xbmc.PlayList(xbmc.PLAYLIST_MUSIC)
        playlist.clear()
        for c in channels:
            li = xbmcgui.ListItem(c.get('name') or '')
            li.setProperty('IsPlayable', 'true')
            if c.get('icon'):
                logo = self.image(c['icon'], 240)
                li.setArt({'thumb': logo, 'icon': logo})
            playlist.add(plugin_url(mode='live', channel=c['uuid'], radio='1' if radio else None), li)
        xbmc.Player().play(playlist, startpos=index)


def run():
    home = xbmcgui.Window(utils.HOME)
    running = home.getProperty(RUNNING_PROPERTY)
    if running:
        # Already open, but Kodi shows something else (its home screen): back to the screen on top.
        if running.isdigit() and int(running) != xbmcgui.getCurrentWindowId():
            xbmc.executebuiltin('ActivateWindow({})'.format(running))
        return
    if not utils.signed_in():
        from .. import plugin
        plugin.sign_in()
        if not utils.signed_in():
            return
    home.setProperty(RUNNING_PROPERTY, 'starting')  # no window to go back to yet (a number would be taken for one)
    try:
        app = App()
        try:
            app.load_account()
        except ApiError as err:
            xbmcgui.Dialog().ok('Reelhouse', utils.string(30119) if err.status == 401 else str(err))
            return
        if app.timeshift_wanted():
            # Once, a moment after Home shows: Kodi asks whether to install it, from its own add-on repository (the
            # add-on's settings install it later). Not a dependency: Kodi would then refuse to install Reelhouse where
            # it can't get it (Kodi on desktop Linux, from the distribution's packages).
            utils.set_setting(TIMESHIFT_ASKED, 'true')
            offer = threading.Timer(2.0, xbmc.executebuiltin, ['InstallAddon({})'.format(utils.TIMESHIFT_PLAYER)])
            offer.daemon = True
            offer.start()
        app.show(('home',))
    finally:
        home.clearProperty(RUNNING_PROPERTY)
