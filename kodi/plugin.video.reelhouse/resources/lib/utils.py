# Small helpers shared by the plugin and the service: settings, logging, strings, notifications.
import os

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
