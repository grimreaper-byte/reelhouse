# A library: its posters in a grid, with the web app's Sort, Show (watched or not) and Genre choices. The choices are
# kept per library while the screens are open.
from urllib.parse import urlencode

from .. import model
from .base import Screen
from .options import choose

GRID = 500
SORT, FILTER, GENRE = 511, 512, 513
SORTS = [('title', 'Title', 'asc'), ('added', 'Date added', 'desc'), ('year', 'Year', 'desc'),
         ('released', 'Release date', 'desc'), ('rating', 'Rating', 'desc')]
FILTERS = [('', 'All'), ('unwatched', 'Unwatched'), ('inprogress', 'In progress'), ('watched', 'Watched')]


class Library(Screen):
    XML = 'reelhouse-library.xml'

    def view(self):
        return self.app.library_views.setdefault(self.library_info['id'], {'sort': 'title', 'order': 'asc', 'filter': '', 'genre': ''})

    def load(self):
        lib = self.library_info
        view = self.view()
        query = {'sort': view['sort'], 'order': view['order']}
        if view['filter']:
            query['filter'] = view['filter']
        if view['genre']:
            query['genre'] = view['genre']
        data = self.fetch('/api/libraries/{}/items?{}'.format(int(lib['id']), urlencode(query)))
        self.set_labels()
        if data is None:
            return
        info = data.get('library') or lib
        self.setProperty('title', info.get('name') or '')
        items = data.get('items') or []
        noun = 'movie' if info.get('type') == 'movie' else 'show'
        self.setProperty('count', '{} {}{}'.format(len(items), noun, '' if len(items) == 1 else 's'))
        self.fill_list(GRID, self.items([model.card(i) for i in items]))
        if not items:
            self.show_message('Nothing to show', 'No titles match these choices.' if view['filter'] or view['genre']
                              else 'This library is empty.')
        if not getattr(self, 'loaded', False):
            self.loaded = True
            self.setFocusId(GRID if items else SORT)

    def set_labels(self):
        view = self.view()
        self.setProperty('sort.label', 'Sort: ' + next(label for key, label, _ in SORTS if key == view['sort']))
        self.setProperty('filter.label', 'Show: ' + next(label for key, label in FILTERS if key == view['filter']))
        self.setProperty('genre.label', 'Genre: ' + (view['genre'] or 'All'))

    def default_focus(self):
        return GRID

    def on_click(self, control_id):
        view = self.view()
        if control_id == GRID:
            card = self.selected(GRID)
            if card:
                self.open_child(('item', card['id']))
        elif control_id == SORT:
            n = choose('Sort by', [{'label': label, 'tag': 'Chosen' if key == view['sort'] else ''} for key, label, _ in SORTS])
            if n is not None:
                view['sort'], view['order'] = SORTS[n][0], SORTS[n][2]
                self.reload_grid()
        elif control_id == FILTER:
            n = choose('Show', [{'label': label, 'tag': 'Chosen' if key == view['filter'] else ''} for key, label in FILTERS])
            if n is not None:
                view['filter'] = FILTERS[n][0]
                self.reload_grid()
        elif control_id == GENRE:
            data = self.fetch('/api/libraries/{}/genres'.format(int(self.library_info['id'])))
            if data is None:
                return
            genres = [''] + [g['genre'] for g in data.get('genres') or []]
            n = choose('Genre', [{'label': g or 'All', 'label2': '' if not g else '{} titles'.format(c),
                                  'tag': 'Chosen' if g == view['genre'] else ''}
                                 for g, c in zip(genres, [0] + [g['n'] for g in data.get('genres') or []])])
            if n is not None:
                view['genre'] = genres[n]
                self.reload_grid()

    def reload_grid(self):
        self.getControl(GRID).reset()
        self.load()
        self.getControl(GRID).selectItem(0)
