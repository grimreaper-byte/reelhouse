# Live TV and Radio: the web app's guide, a grid of channels against two hours with a line at now, the highlighted
# programme's details under it, the days along the top. Kodi's lists can't hold blocks of different widths, so the
# grid is drawn here with Python controls, rebuilt as the highlight moves out of sight; the arrow keys move as in the
# web guide (guide.py). Select on a programme: Watch (or Listen) while it's on, Record / Cancel when allowed (Cancel and
# Stop only on your own recordings; an admin's, anyone's), and Record series / Cancel series recording when allowed that
# too (one of a series recording's episodes offers Skip rather than Cancel, and Record again once skipped).
import threading
import time
from datetime import datetime, timedelta

import xbmc
import xbmcgui

from ... import utils
from ...api import ApiError
from .. import model
from ..guide import Guide, HALF_HOUR, half_hour
from .base import (Screen, SIDEBAR, SIDEBAR_SHUT, ACTION_MOVE_LEFT, ACTION_MOVE_RIGHT, ACTION_MOVE_UP, ACTION_MOVE_DOWN, texture)
from .options import choose
from .recordings import cancel_series

DAYS = 820
RULER_Y, GRID_Y, ROW_H, ROWS = 200, 250, 84, 7
CHANNEL_X, CHANNEL_W = 150, 260
PROG_X, PROG_W = 414, 1472
SPAN = 2 * 3600
CHUNK = 12 * 3600       # guide hours fetched at a time
DAY_COUNT = 7
REFRESH = 60            # seconds between re-reading the hours on screen

TEXT, TEXT_DIM, TEXT_FAINT, ACCENT, ACCENT_TEXT, DANGER = ('0xFFECEFF3', '0xFFA2ABB5', '0xFF6F7882', '0xFFE5A00D', '0xFF1A1300',
                                                         '0xFFE5534B')
ACCENT_TEXT_FAINT = '0x991A1300'
LEFT, CENTER_Y = 0, 4
DIRECTIONS = {ACTION_MOVE_LEFT: 'left', ACTION_MOVE_RIGHT: 'right', ACTION_MOVE_UP: 'up', ACTION_MOVE_DOWN: 'down'}


def start_of_day(offset):
    d = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=offset)
    return int(time.mktime(d.timetuple()))


class LiveTv(Screen):
    XML = 'reelhouse-livetv.xml'

    def load(self):
        self.lock = threading.RLock()
        self.controls = []          # what render() made, removed on the next one
        self.buttons = {}           # programme id -> its button
        self.by_control = {}        # button id -> ('event', id) | ('channel', uuid)
        self.highlighted = None
        self.anchor = None
        self.day = 0
        self.guide = None
        self.loaded_to = 0
        self.last_read = 0
        self.setProperty('title', 'Radio' if self.radio else 'Live TV')
        self.fill_days()
        self.read(self.first_start(0))
        if self.guide and self.guide.channels:
            self.focus_highlight()

    def first_start(self, day):
        return half_hour(time.time() - HALF_HOUR) if day == 0 else start_of_day(day)

    # ---------- the data ----------

    def read(self, start, keep=False):
        """Fetches the guide from `start` (a chunk of hours) and draws it; keep: same hours, same place (a refresh)."""
        try:
            data = self.app.api.get('/api/livetv/guide?from={}&to={}'.format(int(start), int(start + CHUNK)))
        except ApiError as err:
            if keep and self.guide:  # reading it again: what's on screen stays, and it's tried again in a minute
                utils.log('guide: {}'.format(err), xbmc.LOGWARNING)
                self.last_read = time.time()
                return
            self.show_message("The guide couldn't be loaded", str(err), retry=True)
            return
        self.clear_message()
        channels = [c for c in data.get('channels') or [] if bool(c.get('radio')) == bool(self.radio)]
        self.can_record = bool(data.get('canRecord'))
        self.can_record_series = bool(data.get('canRecordSeries'))
        self.loaded_to = start + CHUNK
        self.last_read = time.time()
        with self.lock:
            if keep and self.guide:
                top, window = self.guide.top, self.guide.start
                self.guide = Guide(channels, data.get('events') or [], ROWS, SPAN, window)
                self.guide.top = min(top, max(0, len(channels) - ROWS))
            else:
                self.guide = Guide(channels, data.get('events') or [], ROWS, SPAN, start)
            if not channels:
                self.remove_drawn()
                if self.radio:
                    self.show_message('No radio stations', 'Tvheadend gives radio stations a channel tag such as “Radio '
                                      'channels” when it maps them; stations without one show here once they’ve been played.')
                else:
                    self.show_message('No channels', 'Tvheadend has no channels this server’s account may watch.')
                return
            current = self.guide.by_id.get(self.highlighted)
            if current is None or current['stop'] <= self.guide.start:
                current = self.guide.first_highlight(time.time())
            self.highlighted = current['id'] if current else None
            self.render()
            self.show_summary()

    def more_hours(self):
        """Loads the next chunk of hours once the highlight reaches the end of what's loaded."""
        try:
            data = self.app.api.get('/api/livetv/guide?from={}&to={}'.format(int(self.loaded_to), int(self.loaded_to + CHUNK)))
        except ApiError:
            return False
        seen = set(e['id'] for e in self.guide.events)
        self.guide.set_events(self.guide.events + [e for e in data.get('events') or [] if e['id'] not in seen])
        self.loaded_to += CHUNK
        return True

    # ---------- the days ----------

    def fill_days(self):
        items = []
        now = time.time()
        for n in range(DAY_COUNT):
            label = 'Today' if n == 0 else model.day_label(start_of_day(n), now).split(' ')[0]
            li = xbmcgui.ListItem(label, offscreen=True)
            if n == self.day:
                li.setProperty('active', 'true')
            items.append(li)
        self.fill_list(DAYS, items)

    # ---------- drawing ----------

    def remove_drawn(self):
        if self.controls:
            try:
                self.removeControls(self.controls)
            except RuntimeError:
                pass
        self.controls, self.buttons, self.by_control = [], {}, {}

    def render(self):
        """Draws the channels and programmes in the window (rows top..top+ROWS, two hours from guide.start)."""
        g = self.guide
        now = time.time()
        self.remove_drawn()
        made, buttons, kinds = [], [], []
        logos, names = [], []  # the channel column, drawn over its buttons; names: (label, its button, lit)
        self.setProperty('day', model.day_label(g.start, now))
        t = g.start
        while t < g.start + SPAN:
            x = g.x_of(t, PROG_X, PROG_W)
            made.append(xbmcgui.ControlLabel(x + 8, RULER_Y, 160, 50, model.time_of(t), font='font12', textColor=TEXT_DIM,
                                             alignment=LEFT | CENTER_Y))
            t += HALF_HOUR
        white = texture('white.png')
        focus, clear = texture('accent.png'), texture('clear.png')  # the highlighted block: amber, dark text
        for row, channel in enumerate(g.visible_channels()):
            y = GRID_Y + row * ROW_H
            button = xbmcgui.ControlButton(CHANNEL_X + 4, y + 3, CHANNEL_W - 8, ROW_H - 6, '', focusTexture=focus,
                                           noFocusTexture=clear)
            buttons.append(button)
            kinds.append(('channel', channel['uuid']))
            if channel.get('icon'):
                logos.append(xbmcgui.ControlImage(CHANNEL_X + 16, y + 14, 56, 56, self.app.image(channel['icon'], 120),
                                                  aspectRatio=2))
            # The name twice: light, and dark on the amber highlight (as a programme's title is).
            number = '{}  '.format(channel['number']) if channel.get('number') is not None else ''
            for colours, lit in (((TEXT_FAINT, TEXT), False), ((ACCENT_TEXT_FAINT, ACCENT_TEXT), True)):
                label = xbmcgui.ControlLabel(CHANNEL_X + 84, y + 3, CHANNEL_W - 96, ROW_H - 6,
                                             '[COLOR {}]{}[/COLOR]{}'.format(colours[0], number, channel.get('name') or ''),
                                             font='font12', textColor=colours[1], alignment=LEFT | CENTER_Y)
                names.append((label, button, lit))
            blocks = g.blocks(channel['uuid'], PROG_X, PROG_W)
            if not blocks:
                made.append(xbmcgui.ControlLabel(PROG_X + 14, y + 3, 600, ROW_H - 6, 'No guide information', font='font12',
                                                 textColor=TEXT_FAINT, alignment=LEFT | CENTER_Y))
            for e, x, w in blocks:
                if w < 8:
                    continue
                made.append(xbmcgui.ControlImage(x + 2, y + 3, w - 4, ROW_H - 6, white,
                                                 colorDiffuse='0x' + model.programme_colour(e, now)))
                title = e.get('title') or ''
                if model.recording_marked(e.get('dvr')):
                    title = '[COLOR FFE5534B]●[/COLOR] {}'.format(title)
                past = e['stop'] <= now
                button = xbmcgui.ControlButton(x + 2, y + 3, w - 4, ROW_H - 6, title if w > 40 else '', focusTexture=focus,
                                               noFocusTexture=clear, textOffsetX=14, textOffsetY=8, alignment=LEFT,
                                               font='font12', textColor=TEXT_DIM if past else TEXT, focusedColor=ACCENT_TEXT)
                buttons.append(button)
                kinds.append(('event', e['id']))
                if w > 110:
                    made.append(xbmcgui.ControlLabel(x + 16, y + 44, w - 28, 30, '{}–{}'.format(model.time_of(e['start']),
                                                     model.time_of(e['stop'])), font='font10', textColor=TEXT_FAINT))
        line_x = g.x_of(now, PROG_X, PROG_W)
        self.now_line = xbmcgui.ControlImage(line_x if line_x is not None else -10, RULER_Y + 8, 3,
                                             GRID_Y - RULER_Y + ROWS * ROW_H - 8, white, colorDiffuse=ACCENT)
        if line_x is None:
            self.now_line.setVisible(False)
        made.append(self.now_line)
        column = logos + [label for label, _, _ in names]
        self.addControls(made + buttons + column)
        # Added controls draw over the window's own, the open sidebar too: the channel column hides while it's open.
        for logo in logos:
            logo.setVisibleCondition(SIDEBAR_SHUT)
        for label, button, lit in names:
            focused = 'Control.HasFocus({})'.format(button.getId())
            label.setVisibleCondition(focused if lit else '!{} + {}'.format(focused, SIDEBAR_SHUT))
        for button, kind in zip(buttons, kinds):
            self.by_control[button.getId()] = kind
            if kind[0] == 'event':
                self.buttons[kind[1]] = button
        self.controls = made + buttons + column

    # ---------- the highlight ----------

    def show_summary(self):
        e = self.guide.by_id.get(self.highlighted) if self.guide else None
        if not e:
            for key in ('time', 'title', 'meta', 'genre', 'group', 'rec', 'description'):
                self.clearProperty('summary.' + key)
            return
        channel = next((c for c in self.guide.channels if c['uuid'] == e['channel']), None)
        s = model.programme_summary(e, channel, time.time())
        for key in ('time', 'title', 'meta', 'genre', 'rec', 'description'):
            self.setProperty('summary.' + key, s[key])
        self.setProperty('summary.group', str(s['group'] or ''))

    def focus_highlight(self):
        button = self.buttons.get(self.highlighted)
        if button is not None:
            self.setFocus(button)
        elif self.buttons:
            first = next(iter(self.buttons))
            self.highlighted = first
            self.setFocus(self.buttons[first])
            self.show_summary()

    def go_to(self, event):
        """Highlights a programme, moving the window to it first when it's out of sight."""
        with self.lock:
            self.highlighted = event['id']
            floor = start_of_day(self.day) if self.day else self.first_start(0)
            if self.guide.reveal(event, floor=floor) or event['id'] not in self.buttons:
                self.render()
            self.focus_highlight()
            self.show_summary()

    def default_focus(self):
        return self.buttons[self.highlighted].getId() if self.highlighted in self.buttons else DAYS

    def page_focus(self):
        # The guide's buttons are drawn again (new ids) every minute: back to the highlighted programme then.
        return self.content_focus if self.content_focus in self.by_control or self.content_focus == DAYS else self.default_focus()

    def onFocus(self, control_id):
        Screen.onFocus(self, control_id)
        kind = self.by_control.get(control_id)
        if kind and kind[0] == 'event' and kind[1] != self.highlighted:
            self.highlighted = kind[1]
            self.show_summary()

    # ---------- moving with the arrow keys ----------

    def onAction(self, action):
        action_id = action.getId()
        focus = self.getFocusId()
        kind = self.by_control.get(focus)
        if kind and action_id in DIRECTIONS:
            self.move(kind, DIRECTIONS[action_id])
            return
        if focus == DAYS and action_id == ACTION_MOVE_DOWN and self.guide and self.guide.channels:
            self.focus_highlight()
            return
        Screen.onAction(self, action)

    def move(self, kind, direction):
        g = self.guide
        if kind[0] == 'channel':
            uuids = [c['uuid'] for c in g.channels]
            row = uuids.index(kind[1])
            if direction == 'left':
                self.setFocusId(SIDEBAR)
            elif direction == 'right':
                target = g.nearest_at(g.by_channel.get(kind[1], []), max(time.time(), g.start))
                if target:
                    self.go_to(target)
            elif direction == 'up' and row == 0:
                self.setFocusId(DAYS)
            else:
                nxt = row + (1 if direction == 'down' else -1)
                if 0 <= nxt < len(uuids):
                    with self.lock:
                        if nxt < g.top or nxt >= g.top + ROWS:
                            g.top = max(0, min(nxt, len(uuids) - ROWS)) if nxt < g.top else nxt - ROWS + 1
                            self.render()
                        self.focus_channel(uuids[nxt])
            return
        current = g.by_id.get(kind[1])
        if not current:
            return
        target, self.anchor = g.move(current, direction, self.anchor, time.time())
        if target is None and direction == 'right' and self.more_hours():
            target, self.anchor = g.move(current, direction, self.anchor, time.time())
        if target is not None:
            self.go_to(target)
        elif direction == 'left':
            self.focus_channel(current['channel'])
        elif direction == 'up':
            self.setFocusId(DAYS)

    def focus_channel(self, uuid):
        for control_id, kind in self.by_control.items():
            if kind == ('channel', uuid):
                self.setFocusId(control_id)
                return

    # ---------- choosing ----------

    def on_click(self, control_id):
        if control_id == DAYS:
            self.pick_day(self.getControl(DAYS).getSelectedPosition())
            return
        kind = self.by_control.get(control_id)
        if not kind:
            return
        if kind[0] == 'channel':
            self.watch(kind[1])
        else:
            self.programme(self.guide.by_id.get(kind[1]))

    def pick_day(self, day):
        self.day = day
        self.highlighted = None
        self.anchor = None
        self.fill_days()
        self.read(self.first_start(day))
        self.focus_highlight()

    def watch(self, uuid):
        channels = self.guide.channels
        index = next((n for n, c in enumerate(channels) if c['uuid'] == uuid), 0)
        self.app.play_live(channels, index, self.radio)

    def programme(self, e):
        if not e:
            return
        now = time.time()
        airing = e['start'] <= now < e['stop']
        past = e['stop'] <= now
        rec = e.get('dvr')
        someone_elses = bool(rec) and rec.get('canChange') is False  # only they, or an admin, may change it
        actions = []
        if airing:
            actions.append(('Listen' if self.radio else 'Watch', lambda: self.watch(e['channel'])))
        if self.can_record and not past:
            if not rec:
                actions.append(('Record', lambda: self.record(e)))
            elif someone_elses:
                pass
            elif rec.get('state') == 'recording':
                actions.append(('Stop recording', lambda: self.recording(rec, 'stop', 'Recording stopped')))
            elif rec.get('state') == 'scheduled' and rec.get('series'):
                actions.append(('Skip this episode', lambda: self.recording(rec, 'cancel', 'Episode skipped')))
            elif rec.get('state') == 'scheduled':
                actions.append(('Cancel recording', lambda: self.recording(rec, 'cancel', 'Recording cancelled')))
            elif rec.get('state') == 'skipped':
                actions.append(('Record', lambda: self.recording(rec, 'record', '“{}” will be recorded'.format(e.get('title')))))
        series = model.series_action(rec, past, self.can_record_series)
        if series == 'record':
            actions.append(('Record series', lambda: self.record_series(e)))
        elif series == 'cancel':
            actions.append(('Cancel series recording', lambda: self.cancel_series(e, rec)))
        if not actions:
            xbmcgui.Dialog().notification('Reelhouse', 'Your account can’t schedule recordings.' if not self.can_record and not past
                                          else ('Someone else has a series recording of this; only they or an admin can change it.'
                                                if rec.get('series') else 'Someone else set this recording; only they or an admin can cancel it.')
                                          if someone_elses and not past else 'This programme has finished.', time=3000, sound=False)
            return
        if len(actions) == 1 and airing:
            actions[0][1]()
            return
        channel = next((c for c in self.guide.channels if c['uuid'] == e['channel']), None)
        summary = model.programme_summary(e, channel, now)
        n = choose(e.get('title') or '', [{'label': label} for label, _ in actions], subheading=summary['time'] + ' · ' + summary['meta'])
        if n is not None:
            actions[n][1]()

    def record(self, e):
        try:
            self.app.api.post('/api/livetv/record', {'eventId': e['id']})
        except ApiError as err:
            xbmcgui.Dialog().notification('Reelhouse', str(err), xbmcgui.NOTIFICATION_ERROR)
            return
        xbmcgui.Dialog().notification('Reelhouse', '“{}” will be recorded'.format(e.get('title')), time=3000, sound=False)
        self.read(self.guide.start, keep=True)
        self.focus_highlight()

    def record_series(self, e):
        try:
            already = (self.app.api.post('/api/livetv/series', {'eventId': e['id']}) or {}).get('already')
        except ApiError as err:
            xbmcgui.Dialog().notification('Reelhouse', str(err), xbmcgui.NOTIFICATION_ERROR)
            return
        channel = next((c for c in self.guide.channels if c['uuid'] == e['channel']), {})
        words = 'You already have a series recording of “{}” on {}' if already else 'Every episode of “{}” on {} will be recorded'
        xbmcgui.Dialog().notification('Reelhouse', words.format(model.show_name(e.get('title')), channel.get('name') or 'this channel'),
                                      time=3000, sound=False)
        self.read(self.guide.start, keep=True)
        self.focus_highlight()

    def cancel_series(self, e, rec):
        if cancel_series(self.app, rec['series'], model.show_name(e.get('title'))):
            self.read(self.guide.start, keep=True)
            self.focus_highlight()

    def recording(self, rec, action, said):
        try:
            self.app.api.post('/api/livetv/recordings/{}/{}'.format(rec['uuid'], action))
        except ApiError as err:
            xbmcgui.Dialog().notification('Reelhouse', str(err), xbmcgui.NOTIFICATION_ERROR)
            return
        xbmcgui.Dialog().notification('Reelhouse', said, time=3000, sound=False)
        self.read(self.guide.start, keep=True)
        self.focus_highlight()

    # ---------- every second: the now line; every minute: the hours on screen again ----------

    def tick(self):
        if not self.guide or not self.guide.channels:
            return
        if time.time() - self.last_read >= REFRESH:
            had_focus = self.getFocusId() in self.by_control
            self.read(self.guide.start, keep=True)
            if had_focus:
                self.focus_highlight()
            return
        x = self.guide.x_of(time.time(), PROG_X, PROG_W)
        line = getattr(self, 'now_line', None)
        if line is not None and x is not None:
            line.setPosition(x, RULER_Y + 8)

    def refresh(self):
        pass  # the guide re-reads itself every minute (tick)
