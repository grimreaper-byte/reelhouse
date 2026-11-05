# Search: Kodi's keyboard for the words, then the web app's sections as rows (movies, TV shows, episodes, and titles
# whose cast or crew matched). Episodes play; everything else opens its page.
from urllib.parse import quote

import xbmcgui

from .. import model
from .base import Screen

BOX = 700
MOVIES, SHOWS, EPISODES, PEOPLE = 721, 722, 723, 724


class Search(Screen):
    XML = 'reelhouse-search.xml'

    def load(self):
        self.setProperty('title', 'Search')
        query = getattr(self, 'query', '')
        self.setProperty('query.label', query or 'Search for movies, shows, episodes and people')
        if not getattr(self, 'loaded', False):
            self.loaded = True
            self.setFocusId(BOX)
            self.ask()
            return
        self.find()

    def refresh(self):
        if getattr(self, 'query', ''):
            self.find(move_focus=False)  # a library changed: the same search again, leaving the focus where it is

    def default_focus(self):
        return BOX

    def ask(self):
        text = xbmcgui.Dialog().input('Search', getattr(self, 'query', ''))
        if text.strip():
            self.query = text.strip()
            self.setProperty('query.label', self.query)
            self.find()

    def find(self, move_focus=True):
        r = self.fetch('/api/search?q=' + quote(self.query))
        if r is None:
            return
        self.fill_list(MOVIES, self.items([model.card(i) for i in r.get('movies') or []]))
        self.fill_list(SHOWS, self.items([model.card(i) for i in r.get('shows') or []]))
        self.fill_list(EPISODES, self.items([model.card(i, 'landscape') for i in r.get('episodes') or []]))
        self.fill_list(PEOPLE, self.items([model.card(i) for i in r.get('people') or []]))
        if not any(r.get(k) for k in ('movies', 'shows', 'episodes', 'people')):
            self.show_message('No results', 'Nothing in your libraries matches “{}”.'.format(self.query))
        elif move_focus:
            self.setFocusId(next(c for c, k in ((MOVIES, 'movies'), (SHOWS, 'shows'), (EPISODES, 'episodes'),
                                                (PEOPLE, 'people')) if r.get(k)))

    def on_click(self, control_id):
        if control_id == BOX:
            self.clear_message()
            self.ask()
            return
        card = self.selected(control_id) if control_id in (MOVIES, SHOWS, EPISODES, PEOPLE) else None
        if not card:
            return
        if card['play']:
            self.app.play(card['id'], card['position'] or 0, title=card['title'])
        else:
            self.open_child(('item', card['id']))

    def on_context(self, control_id):
        card = self.selected(control_id) if control_id in (MOVIES, SHOWS, EPISODES, PEOPLE) else None
        if card:
            self.open_child(('item', card['id']))
