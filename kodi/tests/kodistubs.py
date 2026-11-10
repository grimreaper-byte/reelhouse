# Minimal stand-ins for Kodi's Python modules (xbmc, xbmcgui, ...), enough to import and drive the service and
# plugin code outside Kodi. Settings live in SETTINGS; log lines and notifications are collected.
import sys
import threading
import types

SETTINGS = {}
LOG = []
NOTIFICATIONS = []
PROPERTIES = {}
PLAYED = []          # what Player was asked to do: 'pause', 'stop'
BUILTINS = []        # Kodi's built-in commands run (xbmc.executebuiltin)
PLAYLIST = []        # the labels in Kodi's video playlist
PLAYLIST_AT = [0]    # the one playing
PLAYLIST_ITEMS = []  # what went into it: (address, ListItem)
ABORT = threading.Event()


def install():
    if 'xbmc' in sys.modules:
        return
    xbmc = types.ModuleType('xbmc')
    xbmc.LOGDEBUG, xbmc.LOGINFO, xbmc.LOGWARNING, xbmc.LOGERROR = 0, 1, 2, 3
    xbmc.log = lambda message, level=1: LOG.append((level, message))
    xbmc.getCondVisibility = lambda condition: condition.startswith('Control.IsVisible')
    xbmc.getInfoLabel = lambda label: '1' if label == 'System.CurrentControlId' else ''  # something has the focus
    xbmc.executebuiltin = lambda command, wait=False: BUILTINS.append(command)
    xbmc.sleep = lambda ms: None

    class Monitor(object):
        def abortRequested(self):
            return ABORT.is_set()

        def waitForAbort(self, timeout=None):
            return ABORT.wait(timeout)

    class Player(object):
        playing_file = ''

        def getPlayingFile(self):
            return self.playing_file

        def getTime(self):
            return 0.0

        def getTotalTime(self):
            return 0.0

        def isPlayingVideo(self):
            return True

        def seekTime(self, seconds):
            self.seeked = seconds
            PLAYED.append(('seek', seconds))

        def playselected(self, index):
            PLAYED.append(index)

        def pause(self):
            PLAYED.append('pause')

        def stop(self):
            PLAYED.append('stop')

        def play(self, item=None, listitem=None, windowed=False, startpos=-1):
            PLAYED.append(('play', item if isinstance(item, str) else startpos))

    class Entry(object):
        """A playlist entry as Kodi gives it back: its label, and the add-on's address it plays."""
        def __init__(self, n):
            self.n = n

        def getLabel(self):
            return PLAYLIST[self.n]

        def getPath(self):
            return 'plugin://plugin.video.reelhouse/?mode=live&channel=c{}'.format(self.n)

        def getArt(self, kind):
            return ''

    class PlayList(object):
        """Kodi's video playlist: PLAYLIST (labels) and PLAYLIST_AT (the item playing); put in again, the labels go in
        PLAYLIST once more and PLAYED says 'cleared'."""
        def __init__(self, kind):
            pass

        def size(self):
            return len(PLAYLIST)

        def getposition(self):
            return PLAYLIST_AT[0]

        def __getitem__(self, n):
            return Entry(n)

        def clear(self):
            PLAYED.append('cleared')
            del PLAYLIST[:]
            del PLAYLIST_ITEMS[:]

        def add(self, url, listitem=None, index=-1):
            PLAYLIST.append(listitem.getLabel() if listitem else url)
            PLAYLIST_ITEMS.append((url, listitem))

    xbmc.Monitor, xbmc.Player, xbmc.PlayList = Monitor, Player, PlayList
    xbmc.PLAYLIST_MUSIC, xbmc.PLAYLIST_VIDEO = 0, 1
    xbmc.getRegion = lambda key: '%H:%M:%S' if key == 'time' else ''

    xbmcgui = types.ModuleType('xbmcgui')
    xbmcgui.NOTIFICATION_ERROR = 'error'

    class Window(object):
        def __init__(self, window_id):
            pass

        def getProperty(self, key):
            return PROPERTIES.get(key, '')

        def setProperty(self, key, value):
            PROPERTIES[key] = value

        def clearProperty(self, key):
            PROPERTIES.pop(key, None)

    class Dialog(object):
        def notification(self, heading, message, icon=None, time=5000):
            NOTIFICATIONS.append(message)

    class InfoTagVideo(object):
        """Keeps what's set on it, by setter: {'setTitle': 'Pilot', ...}."""
        def __init__(self):
            self.values = {}

        def __getattr__(self, name):
            if not name.startswith('set'):
                raise AttributeError(name)
            return lambda *args: self.values.__setitem__(name, args[0] if len(args) == 1 else args)

    class ListItem(object):
        def __init__(self, label='', label2='', path=''):
            self.label, self.path, self.properties, self.art = label, path, {}, {}
            self.tag = None

        def getVideoInfoTag(self):
            self.tag = self.tag or InfoTagVideo()
            return self.tag

        def getLabel(self):
            return self.label

        def getPath(self):
            return self.path

        def setProperty(self, key, value):
            self.properties[key] = value

        def setArt(self, art):
            self.art.update(art)

    xbmcgui.Window, xbmcgui.Dialog, xbmcgui.ListItem = Window, Dialog, ListItem

    class WindowXML(object):
        """As Kodi's: the focus only lands on a control while it's showing (`hidden` ids can't take it)."""
        def __init__(self, *args):
            self.properties, self.focus, self.hidden = {}, 0, set()

        def setProperty(self, key, value):
            self.properties[key] = value

        def getProperty(self, key):
            return self.properties.get(key, '')

        def clearProperty(self, key):
            self.properties.pop(key, None)

        def setFocusId(self, control_id):
            if control_id not in self.hidden:
                self.focus = control_id

        def getFocusId(self):
            return self.focus

        def getControl(self, control_id):
            return object()  # a control that's showing, and no list

        def close(self):
            self.was_closed = True

    xbmcgui.WindowXML, xbmcgui.WindowXMLDialog = WindowXML, WindowXML
    xbmcgui.getCurrentWindowId = lambda: 0

    xbmcaddon = types.ModuleType('xbmcaddon')

    class Addon(object):
        def __init__(self, addon_id=None):
            pass

        def getSetting(self, key):
            return SETTINGS.get(key, '')

        def setSetting(self, key, value):
            SETTINGS[key] = value

        def getLocalizedString(self, string_id):
            return 'string {} %s %s %s'.format(string_id)

        def getAddonInfo(self, key):
            return ''

    xbmcaddon.Addon = Addon

    xbmcvfs = types.ModuleType('xbmcvfs')
    xbmcvfs.translatePath = lambda path: path
    xbmcvfs.exists = lambda path: False
    xbmcvfs.mkdirs = lambda path: True

    xbmcplugin = types.ModuleType('xbmcplugin')

    sys.modules.update({'xbmc': xbmc, 'xbmcgui': xbmcgui, 'xbmcaddon': xbmcaddon, 'xbmcvfs': xbmcvfs, 'xbmcplugin': xbmcplugin})
