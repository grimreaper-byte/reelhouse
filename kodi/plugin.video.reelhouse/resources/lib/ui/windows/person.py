# Someone in a cast, as their page in the web app: photo, born/died/from, biography, their titles on the server, and
# (from TMDB) their other movies.
from urllib.parse import urlencode

import xbmcgui

from .. import model
from .base import Screen, initials

HERE, OTHERS = 630, 640


class Person(Screen):
    XML = 'reelhouse-person.xml'

    def load(self):
        query = {'name': self.name}
        if self.from_item:
            query['item'] = self.from_item
        p = self.fetch('/api/people?' + urlencode(query))
        if p is None:
            return
        self.setProperty('name', p.get('name') or self.name)
        self.setProperty('initials', initials(p.get('name') or self.name))
        if p.get('profile'):
            self.setProperty('photo', self.app.image(p['profile'], 480))
        items = p.get('items') or []
        others = (p.get('others') or {}).get('items') or []
        counts = [model.here_line(items), '{} more movie{}'.format(len(others), '' if len(others) == 1 else 's') if others else None]
        facts = [' · '.join(c for c in counts if c)] + model.person_facts(p.get('info'))
        self.setProperty('facts', '[CR]'.join(facts))
        self.setProperty('biography', ((p.get('info') or {}).get('biography') or '').replace('\n', '[CR]'))
        self.setProperty('here.title', 'On this server')
        self.fill_list(HERE, self.items([model.card(it, subtitle=' · '.join(
            str(x) for x in [it.get('year'), model.part(it)] if x)) for it in items]))
        self.setProperty('others.title', 'Other movies' if others else '')
        cards = []
        for f in others:
            cards.append({'id': 0, 'type': 'tmdb', 'label': f.get('title') or '', 'title': f.get('title') or '',
                          'label2': ' · '.join(str(x) for x in [f.get('year'), 'as ' + f['role'] if f.get('role') else None] if x),
                          'art': {'poster': (f.get('poster'), model.POSTER_W)}, 'watched': False, 'badge': '',
                          'position': 0, 'duration': 0, 'play': False})
        self.fill_list(OTHERS, self.items(cards))
        if not getattr(self, 'loaded', False):
            self.loaded = True
            self.setFocusId(HERE if items else OTHERS if others else 9000)

    def default_focus(self):
        return HERE

    def on_click(self, control_id):
        if control_id == HERE:
            card = self.selected(HERE)
            if card:
                self.open_child(('item', card['id']))
        elif control_id == OTHERS:
            xbmcgui.Dialog().notification('Reelhouse', 'Not on this server', time=2500, sound=False)
