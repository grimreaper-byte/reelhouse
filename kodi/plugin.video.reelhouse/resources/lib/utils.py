# Small helpers shared by the plugin and the service: settings, logging, strings, notifications.
import json
import os
import time

import xbmc
import xbmcaddon
import xbmcgui
import xbmcvfs

ADDON_ID = 'plugin.video.reelhouse'
# Window(10000) is Kodi's home window: properties set there are visible to every add-on process.
HOME = 10000
PLAYING_PROPERTY = 'reelhouse.playing'
LIVE_PROPERTY = 'reelhouse.live'        # the live TV session playing (its id), for heartbeats and channel changes
CHANNELS_PROPERTY = 'reelhouse.channels'  # the guide's channels in order, for the live player controls' changes
# Kodi's official add-on that can pause a live stream (plugin.start_channel uses it when it's installed).
TIMESHIFT_PLAYER = 'inputstream.ffmpegdirect'
CHANGED_PROPERTY = 'reelhouse.changed'  # bumped when Reelhouse announces changes; the Reelhouse screens re-read
# Set by the Reelhouse screens when they start something while something else plays behind them (when it was asked):
# the service shows it full screen once its picture starts (Kodi only does that itself when nothing was playing).
FULLSCREEN_PROPERTY = 'reelhouse.fullscreen'


def ask_full_screen():
    """The Reelhouse screens are about to start something. While something else plays behind them (Back from the
    player), Kodi would leave the new item behind them too, so the service is asked to show it full screen."""
    if xbmc.getCondVisibility('Player.HasMedia'):
        xbmcgui.Window(HOME).setProperty(FULLSCREEN_PROPERTY, str(time.time()))


def rpc(method, **params):
    """Calls Kodi's JSON-RPC in this process: its result, or None when Kodi refused (it's logged)."""
    request = {'jsonrpc': '2.0', 'id': 1, 'method': method}
    if params:
        request['params'] = params
    try:
        reply = json.loads(xbmc.executeJSONRPC(json.dumps(request)))
    except (TypeError, ValueError, RuntimeError):
        return None
    if 'error' in reply:
        log('{} refused: {}'.format(method, reply['error']), xbmc.LOGWARNING)
    return reply.get('result')


def addon():
    # A fresh object each time, so settings changed in another process are seen.
    return xbmcaddon.Addon(ADDON_ID)


def setting(key):
    return addon().getSetting(key)


def set_setting(key, value):
    addon().setSetting(key, value)


def setting_bool(key):
    return setting(key).lower() == 'true'


def setting_int(key, default=0):
    try:
        return int(setting(key))
    except ValueError:
        return default


def string(string_id):
    return addon().getLocalizedString(string_id)


def log(message, level=xbmc.LOGINFO):
    xbmc.log('[{}] {}'.format(ADDON_ID, message), level)


def log_error(message):
    log(message, xbmc.LOGERROR)


# ListItem.setInfo's keys (Kodi 19) and InfoTagVideo's setters (Kodi 20 on).
VIDEO_SETTERS = (('mediatype', 'setMediaType'), ('title', 'setTitle'), ('tvshowtitle', 'setTvShowTitle'),
                 ('year', 'setYear'), ('plot', 'setPlot'))


def set_video_info(item, info):
    """Puts a film's or episode's details (ui.model.player_info) on a ListItem."""
    try:
        tag = item.getVideoInfoTag()
    except AttributeError:  # Kodi 19
        item.setInfo('video', info)
        return
    for key, setter in VIDEO_SETTERS:
        if key in info:
            getattr(tag, setter)(info[key])


def notify(message, error=False, time_ms=5000):
    icon = xbmcgui.NOTIFICATION_ERROR if error else os.path.join(addon().getAddonInfo('path'), 'resources', 'icon.png')
    xbmcgui.Dialog().notification('Reelhouse', message, icon, time_ms)


def profile_dir():
    path = xbmcvfs.translatePath(addon().getAddonInfo('profile'))
    if not xbmcvfs.exists(path):
        xbmcvfs.mkdirs(path)
    return path


def signed_in():
    return bool(setting('server_url') and setting('device_token'))


def ui_script():
    """The Reelhouse screens' entry script, for RunScript()."""
    return os.path.join(addon().getAddonInfo('path'), 'ui.py')


def open_ui():
    xbmc.executebuiltin('RunScript({})'.format(ui_script()))


def device_name():
    name = xbmc.getInfoLabel('System.FriendlyName') or 'Kodi'
    return name if 'kodi' in name.lower() else 'Kodi ({})'.format(name)
