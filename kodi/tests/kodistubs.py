# Minimal stand-ins for Kodi's Python modules (xbmc, xbmcgui, ...), enough to import and drive the service and
# plugin code outside Kodi. Settings live in SETTINGS; log lines and notifications are collected.
import sys
import threading
import types

SETTINGS = {}
LOG = []
NOTIFICATIONS = []
PROPERTIES = {}
ABORT = threading.Event()


def install():
    if 'xbmc' in sys.modules:
        return
    xbmc = types.ModuleType('xbmc')
    xbmc.LOGDEBUG, xbmc.LOGINFO, xbmc.LOGWARNING, xbmc.LOGERROR = 0, 1, 2, 3
    xbmc.log = lambda message, level=1: LOG.append((level, message))
    xbmc.getCondVisibility = lambda condition: False
    xbmc.getInfoLabel = lambda label: ''
    xbmc.executebuiltin = lambda command: None
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

        def seekTime(self, seconds):
            self.seeked = seconds

    xbmc.Monitor, xbmc.Player = Monitor, Player

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

    xbmcgui.Window, xbmcgui.Dialog = Window, Dialog

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
