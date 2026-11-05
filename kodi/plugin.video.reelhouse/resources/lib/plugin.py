# The add-on's plugin side: its small menu, sign-in/out, and playing a synced library item.
# Anything that writes Kodi's database is handed to the background service, so there's only ever one writer.
import json
import os
import re
import shutil
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote
from urllib.request import urlopen

import xbmc
import xbmcgui
import xbmcplugin
import xbmcvfs

from . import connection, utils
from .api import Api, ApiError, PLAYS_EVERYTHING
from .syncdb import SyncDb
from .utils import string

PLUGIN = 'plugin://{}/'.format(utils.ADDON_ID)


def run(argv):
    base = argv[0]
    handle = int(argv[1]) if len(argv) > 1 and argv[1].lstrip('-').isdigit() else -1
    params = dict(parse_qsl(argv[2].lstrip('?'))) if len(argv) > 2 else {}
    mode = params.get('mode')
    if params.get('kodi_action') == 'check_exists':
        return check_exists(handle, params)
    if mode == 'play':
        return play(handle, params)
    if mode == 'live':
        return live(handle, params)
    if mode == 'ui':
        utils.open_ui()
        if handle >= 0:
            xbmcplugin.endOfDirectory(handle, succeeded=False)
        return None
    if mode == 'signin':
        return sign_in()
    if mode == 'signout':
        return sign_out()
    if mode == 'sync':
        return ask_service('sync', string(30120))
    if mode == 'remove':
        if xbmcgui.Dialog().yesno('Reelhouse', string(30111)):
            ask_service('remove')
        return None
    if mode == 'settings':
        return utils.addon().openSettings()
    if '/movies' in base or '/tvshows' in base:
        # The folders synced items live in: Kodi may list them ("Go to folder"); there's nothing to show.
        return xbmcplugin.endOfDirectory(handle, succeeded=True)
    return menu(handle)


def ask_service(action, message=None):
    if action in ('sync',) and not utils.signed_in():
        utils.notify(string(30116), error=True)
        return
    xbmc.executebuiltin('NotifyAll({}, {})'.format(utils.ADDON_ID, action))
    if message:
        utils.notify(message)


def menu(handle):
    entries = []
    if utils.signed_in():
        server = utils.setting('server_name') or Api(utils.setting('server_url')).host()
        entries.append((string(30130), 'ui'))
        entries.append((string(30106), 'sync'))
        entries.append((string(30107) % (server, utils.setting('user_name')), 'settings'))
    else:
        entries.append((string(30105), 'signin'))
    icon = utils.addon().getAddonInfo('icon')
    for label, mode in entries:
        item = xbmcgui.ListItem(label)
        item.setArt({'icon': icon, 'thumb': icon})
        xbmcplugin.addDirectoryItem(handle, '{}?mode={}'.format(PLUGIN, mode), item, isFolder=False)
    xbmcplugin.endOfDirectory(handle)


# ---------- sign-in ----------

def sign_in():
    dialog = xbmcgui.Dialog()
    url = dialog.input(string(30100), utils.setting('server_url') or 'http://')
    if not url or url == 'http://':
        return
    username = dialog.input(string(30101), utils.setting('user_name'))
    if not username:
        return
    password = dialog.input(string(30102), option=xbmcgui.ALPHANUM_HIDE_INPUT)
    if not password:
        return
    try:
        api, result = Api.sign_in(url, username, password, utils.device_name())
    except ApiError as err:
        dialog.ok(string(30104), str(err))
        return
    # Signing in again replaces this Kodi's earlier sign-in, which would otherwise stay valid for a year.
    old_url, old_token = utils.setting('server_url'), utils.setting('device_token')
    if old_token and old_token != api.token:
        try:
            Api(old_url, old_token, timeout=5).sign_out()
        except ApiError:
            pass  # already gone, or that server is out of reach: it can be signed out from Reelhouse's web app
    utils.set_setting('server_url', api.base_url)
    utils.set_setting('device_token', api.token)
    utils.set_setting('user_name', result['user']['username'])
    utils.set_setting('server_name', (result.get('server') or {}).get('name') or api.host())
    utils.notify(string(30103) % utils.setting('server_name'))
    ask_service('signedin')


def sign_out():
    if utils.setting('device_token'):
        try:
            connection.api().sign_out()
        except ApiError:
            pass  # already signed out on the server, or it's unreachable: forget the token anyway
    utils.set_setting('device_token', '')
    ask_service('signedout')
    if xbmcgui.Dialog().yesno('Reelhouse', string(30109)):
        ask_service('remove')
    utils.notify(string(30110))


# ---------- playback ----------

def play(handle, params):
    try:
        item_id = int(params.get('id'))
    except (TypeError, ValueError):
        return xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
    if not utils.signed_in():
        utils.notify(string(30116), error=True)
        return xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
    api = connection.api()
    try:
        info = api.playback(item_id)
    except ApiError as err:
        utils.notify(string(30119) if err.status == 401 else string(30117) % err, error=True)
        return xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
    item = xbmcgui.ListItem(path=api.stream_url(item_id))
    # Sidecar subtitle files aren't inside the stream; embedded ones are, and Kodi finds those itself.
    subtitles = sidecar_subtitles(api, item_id, [t for t in info.get('subtitleTracks') or []
                                                 if t.get('external') and t.get('kind') == 'text'])
    if subtitles:
        item.setSubtitles(subtitles)
    # Tells the service which Reelhouse item is starting, for progress reporting, and where to start it (the
    # Reelhouse screens' Resume; Kodi's own library resumes by itself).
    try:
        start = max(0.0, float(params.get('start') or 0))
    except ValueError:
        start = 0.0
    xbmcgui.Window(utils.HOME).setProperty(utils.PLAYING_PROPERTY, json.dumps({
        'id': item_id, 'playId': info.get('playId'), 'duration': info.get('duration'), 'start': start,
    }))
    xbmcplugin.setResolvedUrl(handle, True, item)


def live(handle, params):
    """A live TV channel or radio station (from the Reelhouse screens' guide): Reelhouse converts it while it plays.

    A channel change (Kodi's next/previous in the guide's playlist) passes the session playing, which Reelhouse stops
    first, freeing its tuner.
    """
    uuid = params.get('channel')
    if not uuid or not utils.signed_in():
        return xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
    home = xbmcgui.Window(utils.HOME)
    try:
        previous = json.loads(home.getProperty(utils.LIVE_PROPERTY) or '{}').get('playId')
    except ValueError:
        previous = None
    api = connection.api()
    try:
        info = api.post('/api/livetv/play/{}'.format(quote(uuid)), {
            'quality': 'original', 'caps': PLAYS_EVERYTHING, 'previousSession': previous,
        })
    except ApiError as err:
        utils.notify(string(30119) if err.status == 401 else string(30136) % err, error=True)
        return xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
    url = api.base_url + info['url']
    if not wait_for_playlist(url):
        utils.notify(string(30136) % string(30137), error=True)
        return xbmcplugin.setResolvedUrl(handle, False, xbmcgui.ListItem())
    channel = info.get('channel') or {}
    now = info.get('now') or {}
    item = xbmcgui.ListItem(channel.get('name') or '', path=url)
    item.setMimeType('application/vnd.apple.mpegurl')
    item.setContentLookup(False)
    title = ' · '.join(p for p in (channel.get('name'), now.get('title')) if p)
    try:
        tag = item.getMusicInfoTag() if info.get('radio') else item.getVideoInfoTag()
        tag.setTitle(title)
    except AttributeError:  # Kodi 19
        item.setInfo('music' if info.get('radio') else 'video', {'title': title})
    if channel.get('icon'):
        logo = api.media_url(channel['icon'], w=240)
        item.setArt({'thumb': logo, 'icon': logo})
    home.setProperty(utils.LIVE_PROPERTY, json.dumps({'playId': info['playId'], 'channel': channel.get('name')}))
    xbmcplugin.setResolvedUrl(handle, True, item)


def wait_for_playlist(url, timeout=25):
    """Reelhouse answers "Not ready" until the conversion's first piece is written (a few seconds)."""
    monitor = xbmc.Monitor()
    waited = 0.0
    while waited < timeout:
        try:
            with urlopen(url, timeout=5) as res:
                if res.status == 200:
                    return True
        except HTTPError as err:
            if err.code != 404:
                return False  # 410: the conversion failed
        except (URLError, OSError):
            return False
        if monitor.waitForAbort(0.5):
            return False
        waited += 0.5
    return False


def sidecar_subtitles(api, item_id, tracks):
    """Saves the tracks to Kodi's temp folder and returns their paths.

    Kodi names an external subtitle after its filename (e.g. 'SDH.en.forced.vtt' -> English, forced, "SDH"),
    so each track gets its own folder and a name made of its title and language. A track that can't be
    downloaded is passed as a URL instead, which plays but shows up unnamed.
    """
    root = os.path.join(xbmcvfs.translatePath('special://temp/'), 'reelhouse-subtitles')
    shutil.rmtree(root, ignore_errors=True)
    paths = []
    for n, track in enumerate(tracks):
        parts = [re.sub(r'[^\w ]+', ' ', track.get('title') or '').strip(), track.get('language') or '',
                 'forced' if track.get('forced') else '']
        name = '.'.join(p for p in parts if p) or 'subtitle'
        try:
            data = api.subtitle(item_id, track['id'])
            os.makedirs(os.path.join(root, str(n)), exist_ok=True)
            path = os.path.join(root, str(n), name + '.vtt')
            with open(path, 'wb') as f:
                f.write(data)
            paths.append(path)
        except (ApiError, OSError) as err:
            utils.log_error('subtitle {} of item {} not saved: {}'.format(track.get('id'), item_id, err))
            paths.append(api.subtitle_url(item_id, track['id']))
    return paths


def check_exists(handle, params):
    # Kodi's "Clean library" asks plugins whether an item still exists.
    exists = False
    try:
        records = SyncDb(connection.records_path())
        try:
            exists = records.get(int(params.get('id'))) is not None
        finally:
            records.close()
    except Exception as err:
        utils.log_error('check_exists failed: {}'.format(err))
        exists = True  # when unsure, keep the item
    xbmcplugin.setResolvedUrl(handle, exists, xbmcgui.ListItem())
