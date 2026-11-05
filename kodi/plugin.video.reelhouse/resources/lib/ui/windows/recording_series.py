# A series' recordings (from a show's series, or straight from the Recordings screen for a show without series
# numbers), as a library's episodes: the series' cover and what it has, Delete series across the top, then its
# episodes' pictures (TMDB's still for each, else the guide's, else the channel's logo) with REC, Scheduled or what
# went wrong. Select one (or the menu button) for what it offers: Stop recording (what's recorded so far stays), Cancel
# recording, or Delete recording (asked again). Read again every minute.
import time

import xbmcgui

from ...api import ApiError
from .. import model
from .base import Screen
from .options import choose
from .recordings import REFRESH, delete_many

GRID = 800
DELETE_SERIES = 811


class RecordingSeries(Screen):
    XML = 'reelhouse-recording-series.xml'

    def load(self):
        if not hasattr(self, 'series'):
            self.show, self.series = None, None
            self.setProperty('title', self.title)
        self.last_read = time.time()
        data = self.fetch('/api/livetv/recordings' + ('?all=1' if self.everyone else ''))
        if data is None:
            return
        self.show = next((s for s in data.get('shows') or [] if s['key'] == self.key), None)
        self.series = next((s for s in (self.show or {}).get('seasons') or [] if s.get('season') == self.season), None)
        if self.series is None:  # all of it deleted (here, or elsewhere)
            self.close()
            return
        show, series = self.show, self.series
        name = model.series_name(series, show)
        self.setProperty('title', show['title'] if name == 'Recordings' else '{} · {}'.format(show['title'], name))
        self.setProperty('meta', model.counts_line(series.get('counts') or {}))
        self.setProperty('poster', self.app.image(series['poster'], model.POSTER_W) if series.get('poster') else '')
        icon = (show.get('channel') or {}).get('icon')
        self.setProperty('logo', self.app.image(icon, 240) if icon else '')
        gone = len(model.deletable(series.get('recordings') or []))
        self.setProperty('deleteseries.label', '{} ({})'.format('Delete series' if series.get('season') is not None else 'Delete these', gone))
        self.getControl(DELETE_SERIES).setVisible(gone > 0)
        now = time.time()
        self.fill_list(GRID, [self.card(r, now) for r in series.get('recordings') or []])
        if not getattr(self, 'loaded', False):
            self.loaded = True
            self.setFocusId(GRID)

    def card(self, rec, now):
        c = model.episode_card(rec, now)
        li = xbmcgui.ListItem(c['label'], c['label2'], offscreen=True)
        for key in ('state', 'tag'):
            li.setProperty(key, c[key])
        li.setProperty('trouble', 'true' if c['trouble'] else '')
        li.setProperty('uuid', rec['uuid'])
        art = {}
        if rec.get('still'):
            art['thumb'] = self.app.image(rec['still'], 640)
        if (rec.get('channel') or {}).get('icon'):
            art['icon'] = self.app.image(rec['channel']['icon'], 240)
        if self.everyone:
            self.owner_line(li, art, [rec])
        li.setArt(art)
        return li

    def default_focus(self):
        return GRID

    def selected_recording(self):
        li = self.getControl(GRID).getSelectedItem()
        uuid = li.getProperty('uuid') if li is not None else ''
        return next((r for r in (self.series or {}).get('recordings') or [] if r['uuid'] == uuid), None)

    # ---------- choosing ----------

    def on_click(self, control_id):
        if control_id == GRID:
            self.recording_menu(self.selected_recording())
        elif control_id == DELETE_SERIES:
            if delete_many(self.app, model.series_what(self.series, self.show), self.series.get('recordings') or []):
                self.after_change()

    def on_context(self, control_id):
        if control_id == GRID:
            self.recording_menu(self.selected_recording())

    def recording_menu(self, rec):
        """The episode's details as the menu's heading, and what it offers."""
        if not rec:
            return
        r = model.recording_row(rec, time.time())
        owner = model.set_by(rec)
        if owner['avatar']:
            owner['avatar'] = self.app.image(owner['avatar'], 120)
        how = model.recording_action(rec)
        heading = '{}: {}'.format(self.show['title'], model.episode_card(rec, time.time())['label'])
        subheading = ' · '.join(p for p in [r['statelabel'], r['meta']] if p)
        if not how:
            choose(heading, [{'label': 'Close', 'label2': rec.get('description') or ''}], subheading=subheading, owner=owner)
            return
        if choose(heading, [{'label': how[1], 'label2': how[2] or rec.get('description') or ''}], subheading=subheading, owner=owner) is None:
            return
        self.change(rec, how)

    def change(self, rec, how):
        action, _, _, said = how
        if action == 'delete':
            title = model.episode_card(rec, time.time())['label']
            whose = '' if rec.get('mine') else (' {} set it.'.format(rec['owner']['username']) if rec.get('owner')
                                                else ' It wasn’t set through Reelhouse.')
            if not xbmcgui.Dialog().yesno('Delete this recording?', '“{}” ({}) will be deleted from Tvheadend’s recordings drive. '
                                          'This can’t be undone.{}'.format(self.show['title'], title, whose),
                                          nolabel='Keep it', yeslabel='Delete'):
                return
        try:
            self.app.api.post('/api/livetv/recordings/{}/{}'.format(rec['uuid'], action))
        except ApiError as err:
            xbmcgui.Dialog().notification('Reelhouse', str(err), xbmcgui.NOTIFICATION_ERROR)
        else:
            xbmcgui.Dialog().notification('Reelhouse', said, time=3000, sound=False)
        self.after_change()

    def after_change(self):
        self.load()
        if not self.closed and self.getFocusId() not in (GRID, DELETE_SERIES):
            self.setFocusId(GRID)

    # ---------- every minute: the series again ----------

    def tick(self):
        if time.time() - self.last_read >= REFRESH:
            self.load()
