# Home: the web app's rows. Continue Watching plays where it stopped (the menu key opens the page instead); every
# other card opens its page.
from .. import model
from .base import Screen

ROWS = 12
POSTER_ROW, LANDSCAPE_ROW = 310, 340  # + the row's number


def row_of(control_id):
    for base in (POSTER_ROW, LANDSCAPE_ROW):
        if base <= control_id < base + ROWS:
            return control_id - base
    return None


class Home(Screen):
    XML = 'reelhouse-home.xml'
    ROOT = True
    nav = 'home'

    def load(self):
        self.setProperty('title', 'Home')
        first = not getattr(self, 'loaded', False)
        data = self.fetch('/api/hubs/home')
        if data is None:
            return
        hubs = data.get('hubs') or []
        for n in range(ROWS):
            hub = hubs[n] if n < len(hubs) else None
            landscape = bool(hub) and hub.get('style') == 'landscape'
            self.setProperty('hub.{}.title'.format(n), hub['title'] if hub else '')
            items = self.items(model.hub_cards(hub)) if hub else []
            self.fill_list(LANDSCAPE_ROW + n, items if landscape else [])
            self.fill_list(POSTER_ROW + n, [] if landscape else items)
        if not data.get('libraries'):
            self.show_message('No libraries yet', 'Ask the server owner to add a library, or to give you access to one.')
        elif not hubs:
            self.show_message('Nothing here yet', 'Your libraries are empty. Check that their folders contain video files.')
        if first:
            self.loaded = True
            self.setFocusId(self.default_focus() if hubs else 9000)
        elif self.focused_row_emptied():
            self.setFocusId(self.default_focus())

    def focused_row_emptied(self):
        """A refresh emptied the row with the focus (e.g. Continue Watching's last title finished)."""
        try:
            focus = self.getFocusId()
        except RuntimeError:  # nothing has the focus
            return False
        return row_of(focus) is not None and not self.getControl(focus).size()

    def default_focus(self):
        """The first row with anything in it (a group list doesn't hand the focus on to its rows)."""
        for n in range(ROWS):
            for base in (POSTER_ROW, LANDSCAPE_ROW):
                if self.getControl(base + n).size():
                    return base + n
        return 9000

    def on_click(self, control_id):
        if row_of(control_id) is None:
            return
        card = self.selected(control_id)
        if not card:
            return
        if card['play']:
            self.play(card)
        else:
            self.open_child(('item', card['id']))

    def on_context(self, control_id):
        if row_of(control_id) is not None:
            card = self.selected(control_id)
            if card:
                self.open_child(('item', card['id']))

    def play(self, card):
        start = card['position'] if card['position'] else 0
        item = {'id': card['id'], 'type': card['type'], 'title': card['title']}
        if card['type'] == 'episode':
            try:
                item = self.app.api.get('/api/items/{}'.format(card['id']))['item']
            except Exception:
                pass
        self.app.play(item['id'], start, self.app.episode_queue(item), title=item.get('title'))
