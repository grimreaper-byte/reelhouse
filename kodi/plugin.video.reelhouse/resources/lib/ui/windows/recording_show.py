# A show's series (from the Recordings screen), as a library's seasons: its cover and what it has, Delete show across
# the top, then its series' covers (TMDB's poster for each series, else the show's), with the count of recorded ones
# and REC while one records. Select opens a series (recording_series.py); the menu button offers Delete series too
# (its recorded episodes, after asking; what's still to come keeps recording). Read again every minute.
import time

import xbmcgui

from .. import model
from .base import Screen
from .options import choose
from .recordings import REFRESH, delete_many

GRID = 700
DELETE_SHOW = 711


class RecordingShow(Screen):
    XML = 'reelhouse-recording-show.xml'

    def load(self):
        if not hasattr(self, 'show'):
            self.show = None
            self.setProperty('title', self.title)
        self.last_read = time.time()
        data = self.fetch('/api/livetv/recordings' + ('?all=1' if self.everyone else ''))
        if data is None:
            return
        self.show = next((s for s in data.get('shows') or [] if s['key'] == self.key), None)
        if self.show is None:  # all of it deleted (here, or elsewhere)
            self.close()
            return
        show = self.show
        self.setProperty('title', show['title'])
        self.setProperty('meta', ' · '.join(p for p in [(show.get('channel') or {}).get('name'), model.counts_line(show.get('counts') or {})] if p))
        self.setProperty('poster', self.app.image(show['poster'], model.POSTER_W) if show.get('poster') else '')
        icon = (show.get('channel') or {}).get('icon')
        self.setProperty('logo', self.app.image(icon, 240) if icon else '')
        gone = len(model.deletable(model.show_recordings(show)))
        self.setProperty('deleteshow.label', 'Delete show ({})'.format(gone))
        self.getControl(DELETE_SHOW).setVisible(gone > 0)
        self.fill_list(GRID, [self.card(s) for s in show.get('seasons') or []])
        if not getattr(self, 'loaded', False):
            self.loaded = True
            self.setFocusId(GRID)

    def card(self, season):
        c = model.series_card(season, self.show)
        li = xbmcgui.ListItem(c['label'], c['label2'], offscreen=True)
        li.setProperty('season', 'none' if season.get('season') is None else str(season['season']))
        li.setProperty('badge', c['badge'])
        li.setProperty('recording', 'true' if c['recording'] else '')
        art = {}
        if season.get('poster'):
            art['poster'] = self.app.image(season['poster'], model.POSTER_W)
        if (self.show.get('channel') or {}).get('icon'):
            art['thumb'] = self.app.image(self.show['channel']['icon'], 240)
        if self.everyone:
            self.owner_line(li, art, season.get('recordings') or [])
        li.setArt(art)
        return li

    def default_focus(self):
        return GRID

    def selected_season(self):
        li = self.getControl(GRID).getSelectedItem()
        if li is None or self.show is None:
            return None
        key = li.getProperty('season')
        return next((s for s in self.show.get('seasons') or [] if ('none' if s.get('season') is None else str(s['season'])) == key), None)

    # ---------- choosing ----------

    def on_click(self, control_id):
        if control_id == GRID:
            self.open_series(self.selected_season())
        elif control_id == DELETE_SHOW:
            if delete_many(self.app, '“{}”'.format(self.show['title']), model.show_recordings(self.show)):
                self.after_change()

    def on_context(self, control_id):
        season = self.selected_season() if control_id == GRID else None
        if not season:
            return
        gone = model.deletable(season.get('recordings') or [])
        choices = [{'label': 'Open'}]
        if gone:
            choices.append({'label': 'Delete series ({})'.format(len(gone)), 'label2': 'Its recorded episodes; what’s still to come keeps recording'})
        n = choose('{} · {}'.format(self.show['title'], model.series_name(season, self.show)), choices,
                   subheading=model.counts_line(season.get('counts') or {}))
        if n == 0:
            self.open_series(season)
        elif n == 1 and delete_many(self.app, model.series_what(season, self.show), season.get('recordings') or []):
            self.after_change()

    def open_series(self, season):
        if not season:
            return
        self.open_child(('recording-series', self.key, self.show['title'], season.get('season'), self.everyone))
        if self.app.pending is None:  # back from the series (not on the way to another place)
            self.after_change()

    def after_change(self):
        self.load()
        if not self.closed:
            self.keep_focus()  # Delete show hides itself once there's nothing recorded left to delete

    # ---------- every minute: the show again ----------

    def tick(self):
        if time.time() - self.last_read >= REFRESH:
            self.load()
