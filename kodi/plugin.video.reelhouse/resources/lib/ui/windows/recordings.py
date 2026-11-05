# Manage Recordings: the Live TV recordings you set from the guide, by show, as in the web app
# (web/js/views/recordings.js): grids of posters like a library's (TMDB's for the show's name, else the guide's picture,
# else the channel's logo) under the headings Recording now (a red REC mark), Recorded (newest first, the count of
# recorded episodes in the corner) and Scheduled (soonest first, when the next one records). Select opens the show's series (recording_show.py;
# its recordings, recording_series.py, when the guide gave no series numbers); the menu button offers Delete show too.
# Under them, Series recordings: what's been set to record every episode of a show on a channel (from the guide), Select
# offering its show's page and Cancel series recording.
# Across from the title is how full Tvheadend's recordings drive is. Admins can show everyone's, with who set what under
# each cover. Read again every minute, as recordings start, grow
# and finish by themselves.
import time

import xbmcgui

from ...api import ApiError
from .. import model
from .base import Screen
from .options import choose

LISTS = {'now': 601, 'recorded': 602, 'scheduled': 603}  # model.show_sections' grids, top to bottom
GROUPS = {'now': 621, 'recorded': 622, 'scheduled': 623}  # each with its heading
SERIES, SERIES_GROUP = 604, 624  # the series recordings, under them
DRIVE_BARS = (631, 632)  # the recordings drive's bar: its usual colour, and red when low on space
WHOSE = 611
REFRESH = 60  # seconds between reading the list again


class Recordings(Screen):
    XML = 'reelhouse-recordings.xml'

    def load(self):
        if not hasattr(self, 'everyone'):
            self.everyone = False
            self.shows = []
            self.series = []
            self.setProperty('title', 'Manage Recordings')
            self.setProperty('admin', 'true' if self.app.user().get('isAdmin') else '')
        self.setProperty('whose.label', 'Showing: ' + ('Everyone’s' if self.everyone else 'Yours'))
        self.last_read = time.time()
        data = self.fetch('/api/livetv/recordings' + ('?all=1' if self.everyone else ''))
        if data is None:
            return
        self.shows = data.get('shows') or []
        self.series = data.get('series') or []
        self.setProperty('count', model.recordings_summary(self.shows))
        drive = model.drive_line(data.get('drive'))
        self.setProperty('drive.label', drive['label'])
        self.setProperty('drive.hint', drive['hint'])
        self.setProperty('drive.low', 'true' if drive['low'] else '')
        for control_id in DRIVE_BARS:
            self.getControl(control_id).setPercent(drive['used'])
        now = time.time()
        for section, shows in model.show_sections(self.shows):
            self.fill_list(LISTS[section], [self.card(s, section, now) for s in shows])
            self.getControl(GROUPS[section]).setHeight(model.section_height(len(shows)))
        self.fill_list(SERIES, [self.series_item(s, now) for s in self.series])
        self.getControl(SERIES_GROUP).setHeight(model.section_height(len(self.series)))
        if not self.shows and not self.series:
            if self.everyone:
                self.show_message('No recordings', 'Tvheadend has no recordings Reelhouse can see.')
            else:
                self.show_message('Nothing recorded or scheduled', 'Open a programme in the Live TV guide and choose Record.')
        if not getattr(self, 'loaded', False):
            self.loaded = True
            self.focus_soon(self.default_focus())

    def card(self, show, section, now):
        c = model.show_card(show, section, now)
        li = xbmcgui.ListItem(c['label'], c['label2'], offscreen=True)
        li.setProperty('key', show['key'])
        li.setProperty('badge', c['badge'])
        li.setProperty('recording', 'true' if c['recording'] else '')
        art = {}
        if show.get('poster'):
            art['poster'] = self.app.image(show['poster'], model.POSTER_W)
        if (show.get('channel') or {}).get('icon'):
            art['thumb'] = self.app.image(show['channel']['icon'], 240)
        if self.everyone:
            self.owner_line(li, art, model.section_recordings(show, section))
        li.setArt(art)
        return li

    def series_item(self, series, now):
        c = model.series_recording_card(series, now)
        li = xbmcgui.ListItem(c['label'], c['label2'], offscreen=True)
        li.setProperty('uuid', series['uuid'])
        li.setProperty('recording', 'true' if c['recording'] else '')
        if not self.everyone:
            li.setProperty('line3', c['channel'])
        art = {}
        if series.get('poster'):
            art['poster'] = self.app.image(series['poster'], model.POSTER_W)
        if (series.get('channel') or {}).get('icon'):
            art['thumb'] = self.app.image(series['channel']['icon'], 240)
        if self.everyone:
            self.owner_line(li, art, [series])
        li.setArt(art)
        return li

    def default_focus(self):
        for section, shows in model.show_sections(self.shows):
            if shows:
                return LISTS[section]
        if self.series:
            return SERIES
        return WHOSE if self.getProperty('admin') else Screen.default_focus(self)

    def selected_show(self, control_id):
        li = self.getControl(control_id).getSelectedItem() if control_id in LISTS.values() else None
        key = li.getProperty('key') if li is not None else ''
        return next((s for s in self.shows if s['key'] == key), None)

    # ---------- choosing ----------

    def on_click(self, control_id):
        if control_id == WHOSE:
            n = choose('Show', [{'label': 'Yours', 'tag': '' if self.everyone else 'Chosen'},
                                {'label': 'Everyone’s', 'label2': 'With who set each', 'tag': 'Chosen' if self.everyone else ''}])
            if n is not None and (n == 1) != self.everyone:
                self.everyone = n == 1
                for control_id in LISTS.values():
                    self.getControl(control_id).reset()
                self.load()
        elif control_id in LISTS.values():
            self.open_show(self.selected_show(control_id))
        elif control_id == SERIES:
            self.series_menu()

    def on_context(self, control_id):
        if control_id == SERIES:
            self.series_menu()
            return
        show = self.selected_show(control_id)
        if not show:
            return
        gone = model.deletable(model.show_recordings(show))
        choices = [{'label': 'Open'}]
        if gone:
            choices.append({'label': 'Delete show ({})'.format(len(gone)), 'label2': 'Its recorded episodes; what’s still to come keeps recording'})
        n = choose(show['title'], choices, subheading=model.counts_line(show.get('counts') or {}))
        if n == 0:
            self.open_show(show)
        elif n == 1:
            delete_many(self.app, '“{}”'.format(show['title']), model.show_recordings(show))
            self.load()
            self.focus_soon(self.default_focus())

    def series_menu(self):
        """A series recording's details as the menu's heading, its show's page and Cancel series recording."""
        li = self.getControl(SERIES).getSelectedItem()
        uuid = li.getProperty('uuid') if li is not None else ''
        series = next((s for s in self.series if s['uuid'] == uuid), None)
        if not series:
            return
        show = next((s for s in self.shows if s['key'] == series.get('key')), None)
        owner = model.set_by(series)
        if owner['avatar']:
            owner['avatar'] = self.app.image(owner['avatar'], 120)
        about = 'Records every episode on this channel. Repeats are left out when the guide can tell.'
        choices = []
        if show:
            choices.append(('See its episodes', model.counts_line(series.get('counts') or {}), lambda: self.open_show(show)))
        if series.get('canChange'):
            choices.append(('Cancel series recording', about, lambda: self.cancel(series)))
        if not choices:
            choices.append(('Close', about, lambda: None))
        channel = (series.get('channel') or {}).get('name')
        subheading = ' · '.join(p for p in [channel, model.series_recording_next(series, time.time())] if p)
        n = choose(series.get('title') or '', [{'label': label, 'label2': detail} for label, detail, _ in choices], subheading=subheading, owner=owner)
        if n is not None:
            choices[n][2]()

    def cancel(self, series):
        if cancel_series(self.app, series['uuid'], series.get('title') or '', not series.get('mine'), (series.get('owner') or {}).get('username')):
            self.load()
            self.focus_soon(self.default_focus())

    def open_show(self, show):
        if not show:
            return
        # A show without series numbers opens straight to its recordings.
        if model.has_series(show):
            self.open_child(('recording-show', show['key'], show['title'], self.everyone))
        else:
            self.open_child(('recording-series', show['key'], show['title'], None, self.everyone))
        if self.app.pending is None:  # back from the show (not on the way to another place)
            self.load()  # what was changed there
            try:
                focus = self.getFocusId()
            except RuntimeError:  # nothing has the focus
                focus = None
            if focus not in (*LISTS.values(), SERIES) or not self.getControl(focus).size():  # its section emptied (all deleted there)
                self.focus_soon(self.default_focus())

    # ---------- every minute: the shows again ----------

    def tick(self):
        if time.time() - self.last_read >= REFRESH:
            self.load()


def cancel_series(app, uuid, title, someone_elses=False, who=None):
    """Ends a series recording, after asking: what it had scheduled goes; what's recording or recorded stays. True if done."""
    if not xbmcgui.Dialog().yesno('Cancel this series recording?', model.cancel_series_text(title, someone_elses, who),
                                  nolabel='Keep it', yeslabel='Cancel series recording'):
        return False
    try:
        app.api.post('/api/livetv/series/{}/cancel'.format(uuid))
    except ApiError as err:
        xbmcgui.Dialog().notification('Reelhouse', str(err), xbmcgui.NOTIFICATION_ERROR)
        return False
    xbmcgui.Dialog().notification('Reelhouse', 'Series recording cancelled', time=3000, sound=False)
    return True


def delete_many(app, what, recs):
    """Delete series / Delete show: their recorded episodes (this account's to delete), after asking. True if done."""
    gone = model.deletable(recs)
    if not gone or not xbmcgui.Dialog().yesno('Delete {}?'.format(what), model.delete_many_text(recs), nolabel='Keep them',
                                              yeslabel='Delete'):
        return False
    try:
        r = app.api.post('/api/livetv/recordings/delete', {'uuids': [x['uuid'] for x in gone]})
    except ApiError as err:
        xbmcgui.Dialog().notification('Reelhouse', str(err), xbmcgui.NOTIFICATION_ERROR)
        return False
    deleted, skipped = r.get('deleted', 0), len(r.get('skipped') or [])
    xbmcgui.Dialog().notification('Reelhouse', 'Deleted {} recording{}{}'.format(deleted, '' if deleted == 1 else 's',
                                  ' ({} couldn’t be)'.format(skipped) if skipped else ''), time=3000, sound=False)
    return True
