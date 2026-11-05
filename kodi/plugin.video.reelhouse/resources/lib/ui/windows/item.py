# A film, show, season or episode, as its page in the web app: the artwork still behind it, poster and title, Play or
# Resume, From the start, Watched, ⋯ (Play version…, Media info, the episodes either side…), the overview, then rows:
# a show's seasons, a season's episodes, the cast, related titles and "More with …".
import xbmcgui

from ...api import ApiError
from .. import model
from .base import Screen, initials
from .options import choose

PLAY, AGAIN, WATCHED, MORE = 411, 412, 413, 415
INFO = 470
SEASONS, EPISODES, CAST = 450, 460, 430
RELATED = 440  # .. 443
RELATED_ROWS = 4


def backdrop_of(d):
    """The artwork behind the page: an episode's own picture, a season's show's, else the item's backdrop."""
    i = d['item']
    images = i.get('images') or {}
    if i.get('type') == 'episode':
        return images.get('thumb') or images.get('backdrop')
    if i.get('type') == 'season':
        return ((d.get('show') or {}).get('images') or {}).get('backdrop') or images.get('backdrop')
    return images.get('backdrop') or images.get('thumb')


class Item(Screen):
    XML = 'reelhouse-item.xml'

    def load(self):
        data = self.fetch('/api/items/{}'.format(int(self.item_id)))
        if data is None:
            return
        if data['item'].get('versionOf'):  # one of a film's other copies: the film's page
            self.item_id = data['item']['versionOf']
            data = self.fetch('/api/items/{}'.format(int(self.item_id)))
            if data is None:
                return
        self.details = data
        self.fill_header(data)
        self.fill_rows(data)
        if not getattr(self, 'loaded', False):
            self.loaded = True
            self.setFocusId(PLAY)
            self.load_related(data)

    def refresh(self):
        data = self.fetch('/api/items/{}'.format(int(self.item_id)))
        if data is not None:
            self.details = data
            self.fill_header(data)
            self.fill_rows(data)

    def default_focus(self):
        return PLAY

    # ---------- the top of the page ----------

    def fill_header(self, d):
        i = d['item']
        kind = i.get('type')
        images = i.get('images') or {}
        show = d.get('show') or {}
        self.setProperty('type', kind or '')
        self.setProperty('backdrop', self.app.image(backdrop_of(d), model.BACKDROP_W))
        if kind == 'episode':
            self.setProperty('still', self.app.image(images.get('thumb'), model.STILL_W))
            self.getControl(INFO).setPosition(520, 0)
        else:
            self.setProperty('poster', self.app.image(images.get('poster'), model.POSTER_W * 2))
        self.setProperty('show', show.get('title') or '' if kind in ('episode', 'season') else '')
        self.setProperty('heading', i.get('title') or '')
        self.setProperty('meta', model.meta_line(d))
        badges = model.quality_labels(i) if kind in ('movie', 'episode') else []
        for n in range(3):
            self.setProperty('badge.{}'.format(n), badges[n] if n < len(badges) else '')
        genres = i.get('genres') or show.get('genres') or []
        self.setProperty('genres', ' · '.join(genres[:4]))
        action = model.play_action(d)
        self.play_action = action
        self.setProperty('play.label', action[0] if action else 'Play')
        self.setProperty('play.again', action[3] if action and action[3] else '')
        watched = (i.get('state') or {}).get('watched')
        self.setProperty('watched.label', 'Watched' if watched else 'Mark watched')
        self.setProperty('tagline', i.get('tagline') or '')
        overview = i.get('overview') or (show.get('overview') if kind == 'season' else '') or ''
        self.setProperty('overview', overview)
        self.setProperty('credits', model.credits_line(i if kind in ('movie', 'show') else show))

    # ---------- the rows ----------

    def fill_rows(self, d):
        i = d['item']
        kind = i.get('type')
        children = d.get('children') or []
        self.fill_list(SEASONS, self.items([model.card(c) for c in children]) if kind == 'show' else [])
        episodes = []
        if kind == 'season':
            for e in children:
                c = model.card(e, 'landscape', subtitle=' · '.join(p for p in [
                    model.episode_label(e), model.format_duration(e.get('duration'))] if p))
                c['label'], c['play'] = e.get('title') or '', False
                episodes.append(c)
        self.fill_list(EPISODES, self.items(episodes))
        cast_from = d.get('show') if kind in ('season', 'episode') else i
        cast = (cast_from or {}).get('cast') or i.get('cast') or []
        faces = []
        for person in cast:
            li = xbmcgui.ListItem(person.get('name') or '', person.get('role') or '', offscreen=True)
            if person.get('profile'):
                li.setArt({'thumb': self.app.image(person['profile'], model.FACE_W)})
            li.setProperty('initials', initials(person.get('name')))
            li.setProperty('name', person.get('name') or '')
            faces.append(li)
        self.fill_list(CAST, faces)

    def load_related(self, d):
        kind = d['item'].get('type')
        rows = []
        if kind in ('movie', 'show'):
            try:
                r = self.app.api.get('/api/items/{}/related'.format(int(self.item_id)))
            except ApiError:
                r = {}
            if r.get('similar'):
                rows.append(('Related movies' if kind == 'movie' else 'Related shows', r['similar']))
            for person in r.get('byCast') or []:
                rows.append(('More with {}'.format(person['name']), person.get('items') or []))
        for n in range(RELATED_ROWS):
            title, items = rows[n] if n < len(rows) else ('', [])
            self.setProperty('related.{}.title'.format(n), title)
            self.fill_list(RELATED + n, self.items([model.card(it) for it in items]))

    # ---------- what the buttons and rows do ----------

    def on_click(self, control_id):
        d = getattr(self, 'details', None)
        if not d:
            return
        i = d['item']
        if control_id == PLAY and self.play_action:
            label, item_id, start, _ = self.play_action
            target = i if item_id == i['id'] else d.get('onDeck') or {'id': item_id}
            self.app.play(item_id, start, self.app.episode_queue(target), title=target.get('title'))
        elif control_id == AGAIN:
            self.app.play(i['id'], 0, self.app.episode_queue(i), title=i.get('title'))
        elif control_id == WATCHED:
            watched = not (i.get('state') or {}).get('watched')
            try:
                self.app.api.post('/api/items/{}/watched'.format(int(i['id'])), {'watched': watched})
            except ApiError as err:
                xbmcgui.Dialog().notification('Reelhouse', str(err), xbmcgui.NOTIFICATION_ERROR)
                return
            self.refresh()
        elif control_id == MORE:
            self.more()
        elif control_id in (SEASONS, EPISODES) or RELATED <= control_id < RELATED + RELATED_ROWS:
            card = self.selected(control_id)
            if card:
                self.open_child(('item', card['id']))
        elif control_id == CAST:
            li = self.getControl(CAST).getSelectedItem()
            if li:
                show_id = (d.get('show') or {}).get('id') if i.get('type') in ('season', 'episode') else None
                self.open_child(('person', li.getProperty('name'), show_id or i['id']))

    def on_context(self, control_id):
        if control_id in (EPISODES,) or RELATED <= control_id < RELATED + RELATED_ROWS:
            card = self.selected(control_id)
            if card and card['type'] in ('movie', 'episode'):
                self.app.play(card['id'], card['position'] or 0, title=card['title'])

    def more(self):
        d = self.details
        i = d['item']
        kind = i.get('type')
        versions = i.get('versions') or []
        actions = []
        if len(versions) > 1:
            actions.append(('Play version…', self.play_version))
        if kind in ('movie', 'episode'):
            actions.append(('Media info', self.media_info))
        if kind == 'episode':
            if d.get('prev'):
                actions.append(('Previous episode: ' + model.episode_label(d['prev']), lambda: self.go(d['prev']['id'])))
            if d.get('next'):
                actions.append(('Next episode: ' + model.episode_label(d['next']), lambda: self.go(d['next']['id'])))
            if d.get('season'):
                actions.append(('Go to ' + (d['season'].get('title') or 'season'), lambda: self.go(d['season']['id'])))
        if kind in ('episode', 'season') and d.get('show'):
            actions.append(('Go to ' + d['show']['title'], lambda: self.go(d['show']['id'])))
        n = choose(i.get('title') or '', [{'label': label} for label, _ in actions])
        if n is not None:
            actions[n][1]()

    def go(self, item_id):
        self.open_child(('item', item_id))

    def play_version(self):
        i = self.details['item']
        versions = i.get('versions') or []
        n = choose('Play version', [{'label': v.get('label') or '', 'label2': model.version_details(v),
                                     'tag': 'Plays by default' if k == 0 else ''} for k, v in enumerate(versions)])
        if n is None:
            return
        start = model.resume_point(i)
        if start > 0:
            how = choose(versions[n].get('label') or '', [{'label': 'Resume from ' + model.format_time(start)},
                                                         {'label': 'From the start'}])
            if how is None:
                return
            if how == 1:
                start = 0
        self.app.play(versions[n]['id'], start, title=i.get('title'))

    def media_info(self):
        i = self.details['item']
        versions = i.get('versions') or []
        if len(versions) > 1:
            text = '\n\n'.join(model.media_info_text(v.get('media'), v.get('label')) for v in versions)
        else:
            text = model.media_info_text(i.get('media'))
        xbmcgui.Dialog().textviewer('Media info · ' + (i.get('title') or ''), text)
