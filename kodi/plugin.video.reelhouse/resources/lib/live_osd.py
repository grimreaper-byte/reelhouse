# Reelhouse's own player controls while a live TV channel plays (reelhouse-live-osd.xml), laid out as Kodi's are for a
# channel from its own TV add-ons (Tvheadend's, say): the programme's start and end above the ends of its progress bar,
# how far into it and how long it is in the middle, the clock with when it ends, and the channel's logo at the top left.
#
# Kodi draws all that from its own TV guide (PVR.EpgEvent… and PVR.TimeshiftProgress…, which its TV add-ons fill), and
# only for channels from those add-ons. A Reelhouse channel plays as a stream, so Kodi's controls could only say how
# long the stream has played. So while one plays, a dialog of the add-on's own sits over the picture and takes the
# remote, as other media add-ons' players do: it draws nothing until a button is pressed, then shows the controls, and
# hides them again after a few seconds (not while paused). Kodi's own controls then never open: a dialog over the
# picture gets the remote first. Pause, stop and the other player buttons still reach Kodi's player.
#
# The times follow the picture: the moment on screen is when the stream started plus how far it has played, so a
# pause holds them, as Kodi's do. The guide's entries come with the channel (plugin.live) and are asked for again from
# Reelhouse as programmes end.
import json
import threading
import time
from datetime import datetime

import xbmc
import xbmcgui

from . import connection, utils
from .api import ApiError

LAYOUT = 'reelhouse-live-osd.xml'
# Home window properties the layout goes by (a dialog doesn't draw changes to its own once it's open).
SHOWING, SHOWING_INFO, CAN_RECORD = 'reelhouse.liveosd', 'reelhouse.liveosdinfo', 'reelhouse.liveosdrecord'
RECORDING = 'reelhouse.liveosdrecording'  # the record button's red

CATCH = 100  # holds the focus while the controls are hidden
LOGO, TITLE, SUBTITLE, CLOCK, ENDS, REC = 201, 202, 203, 204, 205, 206
START, END, BAR, TIME = 211, 212, 213, 214
BIG_LOGO, INFO_TITLE, INFO_LINE, INFO_SUMMARY, INFO_NEXT = 231, 232, 233, 234, 235
PREVIOUS, PAUSE, STOP, NEXT, RECORD = 301, 302, 303, 304, 305
CHANNELS, DETAILS, SUBTITLES, SETTINGS = 311, 312, 313, 314

SHOW_FOR = 5    # seconds the controls stay without a button pressed
SKIP = 10       # seconds left and right go back and on (within what a pausing player keeps)
ASK_EVERY = 30  # what's on is asked for at most this often
LEAVE_QUIET = 2  # after Back leaves the picture (or Stop): the controls don't come straight back over it
CHANGING = 15    # how long the controls wait over the picture for a channel change's next channel

ACTION_LEFT, ACTION_RIGHT, ACTION_UP, ACTION_DOWN, ACTION_SELECT = 1, 2, 3, 4, 7
ACTION_PREVIOUS_MENU, ACTION_SHOW_INFO, ACTION_NAV_BACK = 10, 11, 92
ACTION_SHOW_OSD, ACTION_MOUSE_MOVE, ACTION_MOUSE_CLICK, ACTION_CONTEXT_MENU, ACTION_MENU = 24, 107, 100, 117, 163
ACTION_CHANNEL_UP, ACTION_CHANNEL_DOWN = 184, 185
# The remote's player buttons. Kodi still acts on play/pause and fast forward/rewind with the controls over the picture
# (so they only bring the controls up: acting on them too undid them); stop, next and previous are the controls'.
ACTION_PAUSE, ACTION_STOP, ACTION_NEXT_ITEM, ACTION_PREV_ITEM = 12, 13, 14, 15
ACTION_PLAYER_FORWARD, ACTION_PLAYER_REWIND, ACTION_PLAYER_PLAY, ACTION_PLAYER_PLAYPAUSE = 77, 78, 79, 229
BACK = (ACTION_PREVIOUS_MENU, ACTION_NAV_BACK)
TOGGLE = (ACTION_SHOW_OSD, ACTION_CONTEXT_MENU, ACTION_MENU)
# What brings the controls up besides OK. Any other action leaves them as they are: Kodi sends a do-nothing 999
# before some keys, which taken for a key brought them up and swallowed the Up after it.
SHOW = TOGGLE + (ACTION_MOUSE_MOVE, ACTION_MOUSE_CLICK)


# ---------- what the controls say (no Kodi needed) ----------

def time_format(region='%H:%M:%S'):
    """Kodi's time of day without the seconds (xbmc.getRegion('time'), e.g. '%I:%M:%S %p' -> '%I:%M %p')."""
    return (region or '%H:%M:%S').replace(':%S', '').replace('%S', '').strip()


def clock(t, fmt):
    """A time of day as Kodi shows one: '11:45 PM' (no leading zero on a 12-hour clock) or '23:45'."""
    text = datetime.fromtimestamp(t).strftime(fmt)
    return text[1:] if fmt.startswith('%I') and text.startswith('0') else text


def length(seconds):
    """How Kodi's player says a time: '46:09', or '01:00:00' from an hour."""
    seconds = max(0, int(seconds))
    h, m, s = seconds // 3600, seconds // 60 % 60, seconds % 60
    return '{:02d}:{:02d}:{:02d}'.format(h, m, s) if h else '{:02d}:{:02d}'.format(m, s)


class Guide(object):
    """A channel's programmes known so far, in order."""

    def __init__(self, events=()):
        self.events = []
        self.add(events)

    def add(self, events):
        known = dict((self.key(e), e) for e in self.events)
        for e in events:
            if e and e.get('start') is not None and e.get('stop') is not None and e['stop'] > e['start']:
                known[self.key(e)] = e  # the newer word on it (whether it's recording, say)
        self.events = sorted(known.values(), key=lambda e: e['start'])

    @staticmethod
    def key(e):
        return e.get('id') or (e['start'], e['stop'])

    def at(self, t):
        return next((e for e in self.events if e['start'] <= t < e['stop']), None)

    def after(self, event):
        return next((e for e in self.events if e['start'] >= event['stop']), None) if event else None

    def wants_more(self, t):
        """Nothing known for the moment on screen, or nothing after it."""
        return self.after(self.at(t)) is None


def episode_line(event):
    return ' · '.join(p for p in (event.get('episodeLabel'), event.get('subtitle')) if p)


def view(channel, event, following, at, played, fmt):
    """What the controls say. at: the moment of the broadcast on screen; played: seconds the stream has played (all
    there is to say without the guide, as Kodi's controls say for a channel without one)."""
    if not event:
        return {'title': channel, 'subtitle': '', 'start': '', 'end': '', 'percent': 0.0, 'time': length(played),
                'ends': '', 'line': '', 'summary': '', 'next': '', 'recording': False, 'set': False, 'recordable': False,
                'id': None}
    span = event['stop'] - event['start']
    into = min(max(at - event['start'], 0), span)
    dvr = (event.get('dvr') or {}).get('state')
    return {
        'title': event.get('title') or channel,
        'subtitle': ' · '.join(p for p in (channel, episode_line(event)) if p),
        'start': clock(event['start'], fmt),
        'end': clock(event['stop'], fmt),
        'percent': 100.0 * into / span,
        'time': '{} / {}'.format(length(into), length(span)),
        'ends': 'Ends at: ' + clock(event['stop'], fmt),
        'line': ' · '.join(p for p in ('{} – {}'.format(clock(event['start'], fmt), clock(event['stop'], fmt)),
                                        event.get('genreName')) if p),
        'summary': event.get('summary') or event.get('description') or '',
        'next': 'Next: {}  {}'.format(clock(following['start'], fmt), following.get('title') or '') if following else '',
        'recording': dvr == 'recording',
        'set': dvr in ('scheduled', 'recording'),  # the record button red
        'recordable': bool(event.get('id')),
        'id': event.get('id'),
    }


# ---------- the dialog ----------

class LiveOsd(xbmcgui.WindowXMLDialog):
    owner = None

    def onInit(self):
        self.owner.ready(self)

    def onAction(self, action):
        self.owner.on_action(self, action.getId())

    def onClick(self, control_id):
        self.owner.on_click(self, control_id)


def start_thread(target):
    thread = threading.Thread(target=target)
    thread.daemon = True
    thread.start()
    return thread


class LiveControls(object):
    """Driven by the service's player: start() as a channel starts, stop() as it stops, tick() every second."""

    def __init__(self, spawn=start_thread, now=time.time):
        self.spawn = spawn
        self.now = now
        self.live = None          # the channel playing (plugin.live's LIVE_PROPERTY)
        self.player = None
        self.guide = Guide()
        self.began = 0.0          # the broadcast moment the stream started at
        self.fmt = '%H:%M'
        self.dialog = None
        self.thread = None
        self.lock = threading.RLock()
        self.shown = False
        self.info = False
        self.last_input = 0.0
        self.asked = 0.0
        self.stopped = 0.0
        self.quiet_until = 0.0
        self.leaving = False
        self.can_record = False
        self.picking = False      # one of the controls' menus is open
        self.drawn = {}           # what each control says now: only changes are sent
        self.channels = []        # the guide's channels in order, as the screens left them: {'uuid', 'name'}
        self.current = None       # the uuid of the channel playing (or last played)
        self.wanted = None        # the channel (its place in self.channels) a channel change is heading for
        self.switching = False

    # ----- from the service -----

    def start(self, info, player):
        """A channel has started playing (the first, or the next one on a channel change)."""
        self.learn_channels()
        with self.lock:
            self.current = info.get('uuid')
            self.live = info
            self.player = player
            self.guide = Guide([info.get('now'), info.get('next')])
            self.asked = 0.0
            self.began = self.now() - self.played()
            self.fmt = time_format(xbmc.getRegion('time'))
            self.drawn = {}
        self.spawn(self.ask_rights)
        self.show()  # as Kodi shows a channel's details as it starts
        if not (self.thread and self.thread.is_alive()):
            self.thread = self.spawn(self.run)

    def stop(self):
        with self.lock:
            self.live = None
            self.stopped = self.now()

    def tick(self):
        """Every second: the times, what's on next once needed, hiding the controls, and closing over anything else."""
        live = self.live
        if live:
            if self.guide.wants_more(self.moment()) and self.now() - self.asked >= ASK_EVERY:
                self.asked = self.now()
                self.spawn(self.ask_guide)
            if (self.shown and self.now() - self.last_input >= SHOW_FOR and not xbmc.getCondVisibility('Player.Paused')
                    and self.on_top()):
                self.hide()
        # Over a channel change they stay (Kodi stays on the picture while the next channel starts, and OK would open
        # its own controls); they go with the picture, or if no channel follows.
        dialog = self.dialog
        if dialog is not None and (not xbmc.getCondVisibility('Window.IsActive(fullscreenvideo)')
                                   or (not live and self.now() - self.stopped >= CHANGING)):
            dialog.close()
        self.draw()

    # ----- the dialog's thread -----

    def run(self):
        """Puts the controls over the picture whenever a channel plays full screen, until the channel has gone."""
        monitor = xbmc.Monitor()
        while not monitor.abortRequested():
            if not self.live and self.now() - self.stopped >= CHANGING:
                break
            if self.live and self.now() >= self.quiet_until and xbmc.getCondVisibility(
                    'Window.IsActive(fullscreenvideo) + Player.HasVideo'):
                dialog = LiveOsd(LAYOUT, utils.addon().getAddonInfo('path'), 'Default', '1080i')
                dialog.owner = self
                dialog.ready_now = False
                self.dialog = dialog
                dialog.doModal()
                self.dialog = None
                del dialog
                if self.leaving:  # Back with the controls hidden: on to the screen before the picture, as Kodi's Back
                    self.leaving = False
                    self.quiet_until = self.now() + LEAVE_QUIET
                    xbmc.executebuiltin('Action(Back)')
                continue
            if monitor.waitForAbort(0.25):
                break
        self.set_shown(False)
        xbmcgui.Window(utils.HOME).clearProperty(CAN_RECORD)
        xbmcgui.Window(utils.HOME).clearProperty(RECORDING)
        self.thread = None

    def ready(self, dialog):
        dialog.ready_now = True
        self.drawn = {}
        self.set_shown(self.shown)
        dialog.setFocusId(CATCH)
        if self.shown:
            self.focus(dialog, self.first_button())
        self.draw()

    def on_action(self, dialog, action):
        if self.player_button(dialog, action):
            return
        if action in BACK:
            if self.shown:
                self.hide()
            else:
                self.leaving = True
                dialog.close()
            return
        # Up and down change channel whether the controls show or not, as Kodi's own TV does (its buttons are one row,
        # so up and down move nothing there): the controls show for a few seconds as a channel starts, and flicking
        # through channels, each press after the first would otherwise have been lost to them.
        if action in (ACTION_UP, ACTION_CHANNEL_UP, ACTION_DOWN, ACTION_CHANNEL_DOWN):
            self.change_channel(1 if action in (ACTION_UP, ACTION_CHANNEL_UP) else -1)
            if self.shown:
                self.last_input = self.now()
            return
        if not self.shown:
            if action in (ACTION_LEFT, ACTION_RIGHT):
                self.skip(-SKIP if action == ACTION_LEFT else SKIP)
                self.show()
            elif action == ACTION_SHOW_INFO:
                self.show(info=True)
            elif action in SHOW:  # OK reaches onClick (the focus holder)
                self.show()
            return
        if action == ACTION_SHOW_INFO:
            self.show(info=not self.info)
        elif action in TOGGLE:
            self.hide()
        else:
            self.last_input = self.now()

    def player_button(self, dialog, action):
        """The remote's play, pause, stop, next and previous, fast forward and rewind; the controls show for them."""
        if action == ACTION_STOP:
            self.stop_playing(dialog)
            return True
        if action in (ACTION_NEXT_ITEM, ACTION_PREV_ITEM):
            self.change_channel(1 if action == ACTION_NEXT_ITEM else -1)
        elif action not in (ACTION_PAUSE, ACTION_PLAYER_PLAYPAUSE, ACTION_PLAYER_PLAY, ACTION_PLAYER_FORWARD,
                            ACTION_PLAYER_REWIND):  # Kodi's own
            return False
        self.show()
        return True

    def skip(self, seconds):
        """Back or on in what the player keeps of the channel (Kodi's small-skip command did nothing here)."""
        if not xbmc.getCondVisibility('Player.SeekEnabled'):
            return
        player = xbmc.Player()
        try:
            player.seekTime(max(0.0, player.getTime() + seconds))
        except RuntimeError:
            pass

    def stop_playing(self, dialog):
        self.hide()
        self.quiet_until = self.now() + LEAVE_QUIET
        dialog.close()
        xbmc.Player().stop()

    def on_click(self, dialog, control):
        self.last_input = self.now()
        if control == CATCH:
            self.show()
        elif control == PREVIOUS:
            self.change_channel(-1)
        elif control == NEXT:
            self.change_channel(1)
        elif control == PAUSE:
            xbmc.Player().pause()
        elif control == STOP:
            self.stop_playing(dialog)
        elif control == RECORD:
            self.record()
        elif control == CHANNELS:
            self.pick_channel()
        elif control == DETAILS:
            self.show(info=not self.info)
        elif control == SUBTITLES:
            xbmc.executebuiltin('ActivateWindow(osdsubtitlesettings)')
        elif control == SETTINGS:
            self.pick_settings()

    # ----- showing and hiding -----

    def show(self, info=None):
        self.last_input = self.now()
        if info is not None:
            self.info = info
        was = self.shown
        self.shown = True
        self.set_shown(True)
        dialog = self.dialog
        if not was and dialog is not None and getattr(dialog, 'ready_now', False):
            self.focus(dialog, self.first_button())

    def hide(self):
        self.shown = False
        self.info = False
        self.set_shown(False)
        dialog = self.dialog
        if dialog is not None and getattr(dialog, 'ready_now', False):
            dialog.setFocusId(CATCH)

    def set_shown(self, shown):
        home = xbmcgui.Window(utils.HOME)
        home.setProperty(SHOWING, '1' if shown else '')
        home.setProperty(SHOWING_INFO, '1' if shown and self.info else '')

    @staticmethod
    def first_button():
        """Pause, as Kodi's controls start on it; Stop for a stream Kodi can't pause (as most live ones), which has none."""
        return PAUSE if xbmc.getCondVisibility('Player.PauseEnabled') else STOP

    @staticmethod
    def focus(dialog, control):
        """A button just made to show can't take the focus until Kodi's next frame."""
        for _ in range(10):
            dialog.setFocusId(control)
            if dialog.getFocusId() == control:
                return
            xbmc.sleep(40)

    def on_top(self):
        """Nothing of Kodi's open over the controls (its subtitle or settings dialogs, say): they stay while it is."""
        return not self.picking and not xbmc.getCondVisibility(
            'Window.IsActive(osdsubtitlesettings) | Window.IsActive(osdvideosettings) | Window.IsActive(osdaudiosettings)')

    # ----- drawing -----

    def played(self):
        try:
            return self.player.getTime() if self.player else 0.0
        except RuntimeError:
            return 0.0

    def moment(self):
        """The moment of the broadcast on screen."""
        return self.began + self.played()

    def draw(self):
        dialog = self.dialog
        live = self.live
        if dialog is None or not live or not getattr(dialog, 'ready_now', False):
            return
        with self.lock:
            at = self.moment()
            event = self.guide.at(at)
            v = view(live.get('channel') or '', event, self.guide.after(event), at, self.played(), self.fmt)
            texts = {
                TITLE: v['title'], SUBTITLE: v['subtitle'], CLOCK: xbmc.getInfoLabel('System.Time'), ENDS: v['ends'],
                REC: '● REC' if v['recording'] else '', START: v['start'], END: v['end'], TIME: v['time'],
                INFO_TITLE: v['title'], INFO_LINE: v['line'], INFO_NEXT: v['next'],
            }
            try:
                for control, text in texts.items():
                    if self.drawn.get(control) != text:
                        dialog.getControl(control).setLabel(text)
                        self.drawn[control] = text
                if self.drawn.get(INFO_SUMMARY) != v['summary']:
                    dialog.getControl(INFO_SUMMARY).setText(v['summary'])
                    self.drawn[INFO_SUMMARY] = v['summary']
                percent = round(v['percent'], 1)
                if self.drawn.get(BAR) != percent:
                    dialog.getControl(BAR).setPercent(percent)
                    self.drawn[BAR] = percent
                logo = live.get('logo') or ''
                if self.drawn.get(LOGO) != logo:
                    dialog.getControl(LOGO).setImage(logo, False)
                    dialog.getControl(BIG_LOGO).setImage(logo, False)
                    self.drawn[LOGO] = logo
            except (RuntimeError, TypeError) as err:  # closing as it's drawn
                utils.log('live controls: {}'.format(err), xbmc.LOGDEBUG)
            home = xbmcgui.Window(utils.HOME)
            for prop, on in ((CAN_RECORD, self.can_record and v['recordable']), (RECORDING, v['set'])):
                value = '1' if on else ''
                if self.drawn.get(prop) != value:
                    home.setProperty(prop, value)
                    self.drawn[prop] = value

    # ----- asking Reelhouse -----

    def ask_rights(self):
        try:
            me = connection.api().get('/api/me') or {}
        except (ApiError, OSError, ValueError):
            return
        self.can_record = bool((me.get('liveTv') or {}).get('canRecord'))

    def ask_guide(self):
        live = self.live
        if not live or not live.get('uuid'):
            return
        try:
            data = connection.api().get('/api/livetv/channels/{}/now'.format(live['uuid'])) or {}
        except (ApiError, OSError, ValueError):
            return
        with self.lock:
            if self.live is live:
                self.guide.add([data.get('now'), data.get('next')])

    def record(self):
        """The record button: records the programme on screen, or offers to stop (or cancel) its recording."""
        with self.lock:
            event = self.guide.at(self.moment())
        if not event or not event.get('id'):
            return
        dvr = event.get('dvr') or {}
        if dvr.get('state') in ('scheduled', 'recording'):
            return self.unrecord(event, dvr)
        try:
            connection.api().post('/api/livetv/record', {'eventId': event['id']})
        except (ApiError, OSError, ValueError) as err:
            utils.notify(str(err), error=True)
            return
        with self.lock:
            event['dvr'] = {'state': 'recording' if event['start'] <= self.now() < event['stop'] else 'scheduled'}
        utils.notify('Recording {}'.format(event.get('title') or ''))
        self.asked = 0.0  # its recording's id comes with the guide's next word on it
        self.spawn(self.ask_guide)
        self.draw()

    def unrecord(self, event, dvr):
        from .ui.windows import options
        recording = dvr['state'] == 'recording'
        if not dvr.get('uuid'):
            self.spawn(self.ask_guide)  # not known yet: the guide's next word on it brings it
            return
        self.picking = True
        try:
            chosen = options.choose(event.get('title') or 'Recording', [
                {'label': 'Stop recording', 'label2': "What's recorded so far is kept"} if recording
                else {'label': 'Cancel recording'},
                {'label': 'Keep recording'}])
        finally:
            self.picking = False
        self.last_input = self.now()
        if chosen != 0:
            return
        try:
            connection.api().post('/api/livetv/recordings/{}/{}'.format(dvr['uuid'], 'stop' if recording else 'cancel'))
        except (ApiError, OSError, ValueError) as err:
            utils.notify(str(err), error=True)
            return
        with self.lock:
            event['dvr'] = None
        utils.notify('Recording stopped' if recording else 'Recording cancelled')
        self.draw()

    # ----- channels and Kodi's own settings -----

    def learn_channels(self):
        """The channels in the guide's order, as the screens left them on the home window as a channel started.

        A channel change goes through the controls rather than Kodi's playlist: the controls start the channel at
        Reelhouse and hand Kodi its stream (start_channel). Through the playlist, Kodi opened the add-on's item for the
        next channel while the one it was leaving played on, and when that ran out first (a channel that couldn't play
        and Kodi skipping on through the next ones, say) it opened another at once, and two busy dialogs make Kodi quit.
        It also went back to a channel played before at the stream address it had then, long stopped. So the screens
        play the channel on its own and leave the order here.
        """
        home = xbmcgui.Window(utils.HOME)
        try:
            channels = json.loads(home.getProperty(utils.CHANNELS_PROPERTY) or '[]')
        except ValueError:
            channels = []
        if channels:
            home.clearProperty(utils.CHANNELS_PROPERTY)  # taken: a later start keeps these
            with self.lock:
                self.channels = [{'uuid': c['uuid'], 'name': c.get('name') or ''} for c in channels if c.get('uuid')]
                self.wanted = None

    def place(self):
        """The playing channel's place in the guide's order, or -1."""
        return next((n for n, c in enumerate(self.channels) if c['uuid'] == self.current), -1)

    def change_channel(self, step):
        """The next or previous channel in the guide's order (no further than its ends); pressed again before it has
        started, on from the one it's heading for."""
        with self.lock:
            base = self.wanted if self.wanted is not None else self.place()
            if base < 0 or not 0 <= base + step < len(self.channels):
                return
        self.go_to(base + step)

    def go_to(self, place):
        with self.lock:
            self.wanted = place
            busy = self.switching
            self.switching = True
        if not busy:
            self.spawn(self.switch)

    def switch(self):
        """Starts the channel asked for (the latest, when asked again meanwhile), then hands Kodi its stream. The one
        playing goes on meanwhile (Reelhouse keeps its last seconds readable): no stop, no busy dialog."""
        from . import plugin
        while True:
            with self.lock:
                place, self.wanted = self.wanted, None
                if place is None:
                    self.switching = False
                    return
                channel = self.channels[place]
            item = plugin.start_channel(channel['uuid'])  # says why when it can't
            if item is not None:
                with self.lock:
                    self.current = channel['uuid']
                xbmc.Player().play(item.getPath(), item)

    def pick_channel(self):
        from .ui.windows import options
        names = [c['name'] for c in self.channels]
        here = self.place()
        if not names:
            return
        self.picking = True
        try:
            chosen = options.choose('Channels', [{'label': name, 'tag': 'Playing' if n == here else ''}
                                                 for n, name in enumerate(names)])
        finally:
            self.picking = False
        self.last_input = self.now()
        if chosen is not None and chosen != here:
            self.go_to(chosen)

    def pick_settings(self):
        from .ui.windows import options
        self.picking = True
        try:
            chosen = options.choose('Settings', [{'label': 'Video settings'}, {'label': 'Audio settings'}])
        finally:
            self.picking = False
        self.last_input = self.now()
        if chosen is not None:
            xbmc.executebuiltin('ActivateWindow({})'.format(('osdvideosettings', 'osdaudiosettings')[chosen]))
