# What's added to Kodi's own player while a live channel plays: the channel's logo before its name at the top left, and
# the programme's time left in the bottom bar, while Kodi's controls show. Placed for Estuary.
#
# They're controls added to Kodi's controls window, not a dialog of the add-on's own: Kodi gives an add-on's dialog the
# remote, and its controls then wouldn't open. Kodi's ways with added controls, as found:
# - Its seek bar throws away the message that adds a control. The controls window takes it, and stays loaded once it
#   has opened; before that, controls added would go when it loads, so the first ones wait until it shows.
# - Letting go of the xbmcgui.Window that controls were added through leaves them on screen but cuts the add-on's hold
#   on them: a setLabel then goes to every window and relabels every label without an id. So the window is held, and
#   nothing in a control is changed once it's in: the label reads the time left from a home window property, and each
#   channel gets a new logo rather than a changed one (a skin reload deletes the controls under the add-on; removing
#   one checks it's still there first).
import time

import xbmc
import xbmcgui

from . import utils

OSD = 12901  # Kodi's video controls (videoosd)
SHOWING = 'reelhouse.liveosd'  # on the home window while a live channel plays: whose controls show
LEFT = 'reelhouse.liveleft'    # on the home window: the time left, which the label reads
# Kodi's dialogs that go over its controls, which Estuary hides its controls for.
OVER = ('SliderDialog', 'osdaudiosettings', 'osdvideosettings', 'osdcmssettings', 'VideoBookmarks',
        'playerprocessinfo', 'PVROSDChannels', 'pvrchannelguide')
# The start of the title Kodi shows at the top left, leaving room for the logo before the name (two em spaces, which
# Kodi doesn't trim).
TITLE_ROOM = '  '
LOGO = (20, 8, 64, 64)            # x, y, width, height: before the name at the top left, centred on it
# Beside Kodi's time in the middle of the bottom bar, in its font from its top, so the two read as one line.
TIME_LEFT = (1066, 985, 560, 60)
KEEP = 2


def moves(dy):
    """In and out with Kodi's controls as Estuary moves its own (a fade and a slide of dy, 300 ms): without, they'd stay
    on screen until the controls had gone."""
    slide = 'time=300 tween=cubic easing=out effect=slide '
    return [('WindowOpen', 'effect=fade start=0 end=100 time=300'), ('WindowOpen', slide + 'start=0,{} end=0,0'.format(dy)),
            ('WindowClose', 'effect=fade start=100 end=0 time=300'), ('WindowClose', slide + 'start=0,0 end=0,{}'.format(dy))]


LOGO_MOVES = moves(-200)      # with the top bar
TIME_LEFT_MOVES = moves(200)  # with the bottom bar


def time_left(stop, now):
    """"29 min left", as the guide says it; nothing when the programme isn't known or is over."""
    if not stop or stop <= now:
        return ''
    return '{} min left'.format(max(1, int(round((stop - now) / 60.0))))


class Overlay(object):
    def __init__(self, gui=None, visible=None):
        self.gui = gui or xbmcgui
        self.visible = visible or xbmc.getCondVisibility
        # Its own value for SHOWING: controls an earlier run of the service left in Kodi's window stay hidden.
        self.token = 'rh{}'.format(int(time.time() * 1000))
        self.window = None    # held: letting go of it would cut the hold on the controls
        self.controls = []    # in Kodi's window
        self.waiting = False  # to go in when Kodi's controls next show
        self.logo = ''
        self.left = None
        self.stop = None
        self.on = False

    def condition(self):
        return 'String.IsEqual(Window(Home).Property({}),{}) + ![{}]'.format(
            SHOWING, self.token, ' | '.join('Window.IsVisible({})'.format(name) for name in OVER))

    def show(self, logo, stop, now=None):
        """Over a channel just started (or changed to): its logo, and the programme's end."""
        self.logo = logo or ''
        self._place()
        self.on = True
        self.gui.Window(utils.HOME).setProperty(SHOWING, self.token)
        self.programme(stop, now)

    def programme(self, stop, now=None):
        """The programme on now ends at stop."""
        self.stop = stop
        self.left = None
        self.update(now)

    def update(self, now=None):
        """The time left as of now (every second), and the controls in once Kodi's controls have opened."""
        if not self.on:
            return
        if self.waiting and self.visible('Window.IsVisible(videoosd)'):
            self._add()
        left = time_left(self.stop, time.time() if now is None else now)
        if left != self.left:
            self.left = left
            self.gui.Window(utils.HOME).setProperty(LEFT, left)

    def ended(self, now=None):
        """The programme has ended: time to ask what's on now."""
        return self.on and bool(self.stop) and self.stop <= (time.time() if now is None else now)

    def close(self):
        """The channel has stopped: the controls hidden (and left in, for the next channel to swap)."""
        if self.on:
            home = self.gui.Window(utils.HOME)
            home.clearProperty(SHOWING)
            home.clearProperty(LEFT)
        self.on = False
        self.stop = None
        self.left = None

    def _place(self):
        """New controls for this channel, the last one's out."""
        if self._remove() or self.visible('Window.IsVisible(videoosd)'):
            self._add()
        else:
            self.waiting = True  # Kodi's controls haven't loaded (or were reloaded): in when they next show

    def _remove(self):
        """Its controls out of Kodi's window; whether they were still there, which means the window is loaded."""
        controls, self.controls = self.controls, []
        self.waiting = False
        if not controls:
            return False
        try:
            self.window.removeControls(controls)
        except RuntimeError:  # gone already, with a skin reload
            return False
        return True

    def _add(self):
        self.waiting = False
        controls = []
        if self.logo:
            controls.append((self.gui.ControlImage(*(LOGO + (self.logo,)), aspectRatio=KEEP), LOGO_MOVES))
        controls.append((self.gui.ControlLabel(*(TIME_LEFT + ('$INFO[Window(Home).Property({})]'.format(LEFT),)),
                                               font='font45', textColor='0xFFFFFFFF'), TIME_LEFT_MOVES))
        if self.window is None:
            self.window = self.gui.Window(OSD)
        when = self.condition()
        for control, animations in controls:
            try:
                self.window.addControl(control)
                control.setVisibleCondition(when)
                control.setAnimations(animations)
            except (RuntimeError, TypeError) as err:
                utils.log('live overlay not shown: {}'.format(err))
                return
            self.controls.append(control)
