# What Kodi's player is told about a film or episode the Reelhouse screens play: an episode is titled as the app has
# it, "S1 · E3 — Pilot", under its show (its numbers aren't passed on their own, or Kodi's skin writes its own
# "Episode: S1E3: Pilot"). What Kodi's own library plays keeps the library's details.
import unittest
from urllib.parse import parse_qsl, urlparse

import helpers  # noqa: F401  (puts the add-on on sys.path)
import kodistubs

kodistubs.install()

import xbmcplugin  # noqa: E402

from resources.lib import connection, plugin  # noqa: E402
from resources.lib.api import ApiError  # noqa: E402
from resources.lib.ui import app as ui_app, model  # noqa: E402

PILOT = {'id': 12, 'type': 'episode', 'title': 'Pilot', 'seasonNumber': 1, 'episodeNumber': 3, 'year': 2008,
         'overview': 'It begins.', 'parentId': 11,
         'images': {'poster': '/api/images/12/poster?v=1', 'backdrop': '/api/images/12/backdrop?v=1',
                    'thumb': '/api/images/12/thumb?v=1'}}
SECOND = {'id': 13, 'type': 'episode', 'title': 'The Next One', 'seasonNumber': 1, 'episodeNumber': 4, 'episodeEnd': 5}
EPISODE = {'item': PILOT, 'show': {'id': 10, 'type': 'show', 'title': 'Some Show',
                                  'images': {'poster': '/api/images/10/poster?v=2'}},
           'season': {'id': 11, 'type': 'season', 'title': 'Season 1'}}
SEASON = {'item': {'id': 11, 'type': 'season'}, 'show': {'id': 10, 'title': 'Some Show'},
          'children': [dict(PILOT, id=8, episodeNumber=2, title='Before'), PILOT, SECOND]}


class FakeApi(object):
    def __init__(self, details=None):
        self.details, self.asked = details, []

    def playback(self, item_id):
        return {'playId': 'p1', 'duration': 1500, 'subtitleTracks': []}

    def stream_url(self, item_id):
        return 'http://rh/api/stream/{}'.format(item_id)

    def media_url(self, path, **params):
        return 'http://rh{}&w={}&token=t'.format(path, params['w'])

    def get(self, path, **kw):
        self.asked.append(path)
        if self.details is None:
            raise ApiError('Reelhouse is not reachable at http://rh (timed out)')
        return self.details[path] if path in self.details else self.details


class PlayerInfoTests(unittest.TestCase):
    def test_an_episode_is_titled_as_the_app_has_it_under_its_show(self):
        self.assertEqual(model.player_info(PILOT, 'Some Show'), {
            'mediatype': 'episode', 'tvshowtitle': 'Some Show', 'title': 'S1 · E3 — Pilot', 'plot': 'It begins.',
        })

    def test_specials_and_double_episodes(self):
        special = dict(PILOT, seasonNumber=0, episodeNumber=2)
        self.assertEqual(model.player_info(special)['title'], 'Special · E2 — Pilot')
        self.assertEqual(model.player_info(SECOND)['title'], 'S1 · E4–5 — The Next One')

    def test_an_episode_without_numbers_keeps_its_title(self):
        info = model.player_info({'type': 'episode', 'title': 'Extra', 'seasonNumber': None})
        self.assertEqual(info, {'mediatype': 'episode', 'title': 'Extra'})

    def test_an_episode_has_its_season_cover_as_poster_its_shows_and_its_still(self):
        self.assertEqual(model.player_art(EPISODE), {
            'poster': ('/api/images/12/poster?v=1', 480),  # Reelhouse gives the season's cover for it
            'tvshow.poster': ('/api/images/10/poster?v=2', 480),
            'thumb': ('/api/images/12/thumb?v=1', 480),
        })

    def test_a_film_has_its_poster(self):
        film = {'item': {'type': 'movie', 'images': {'poster': '/api/images/3/poster?v=1', 'backdrop': None}}}
        self.assertEqual(model.player_art(film), {'poster': ('/api/images/3/poster?v=1', 480)})

    def test_a_film_has_its_year(self):
        info = model.player_info({'type': 'movie', 'title': 'Heat', 'year': 1995})
        self.assertEqual(info, {'mediatype': 'movie', 'year': 1995, 'title': 'Heat'})


class PlayTests(unittest.TestCase):
    def setUp(self):
        kodistubs.SETTINGS.update({'server_url': 'http://rh', 'device_token': 't'})
        kodistubs.PROPERTIES.clear()
        self.resolved = []
        xbmcplugin.setResolvedUrl = lambda handle, ok, item: self.resolved.append((ok, item))
        self.kept = connection.api

    def tearDown(self):
        connection.api = self.kept
        kodistubs.SETTINGS.clear()
        kodistubs.PROPERTIES.clear()

    def play(self, api, **params):
        connection.api = lambda: api
        plugin.play(1, dict(params, id='12'))
        self.assertEqual(len(self.resolved), 1)
        ok, item = self.resolved[0]
        self.assertTrue(ok)
        self.assertEqual(item.getPath(), 'http://rh/api/stream/12')
        return item

    def test_what_the_screens_play_says_what_it_is(self):
        api = FakeApi(EPISODE)
        item = self.play(api, screens='1')
        self.assertEqual(api.asked, ['/api/items/12'])
        self.assertEqual(item.tag.values, {
            'setMediaType': 'episode', 'setTitle': 'S1 · E3 — Pilot', 'setTvShowTitle': 'Some Show',
            'setPlot': 'It begins.',
        })
        self.assertEqual(item.art, {
            'poster': 'http://rh/api/images/12/poster?v=1&w=480&token=t',
            'tvshow.poster': 'http://rh/api/images/10/poster?v=2&w=480&token=t',
            'thumb': 'http://rh/api/images/12/thumb?v=1&w=480&token=t',
        })

    def test_kodis_own_library_keeps_its_details(self):
        api = FakeApi(EPISODE)
        item = self.play(api)
        self.assertEqual(api.asked, [])
        self.assertIsNone(item.tag)
        self.assertEqual(item.art, {})

    def test_it_still_plays_when_the_details_cant_be_had(self):
        item = self.play(FakeApi(None), screens='1')
        self.assertIsNone(item.tag)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.kept = connection.api
        connection.api = lambda: FakeApi({'/api/items/11': SEASON})
        self.app = ui_app.App()

    def tearDown(self):
        connection.api = self.kept

    def test_the_episodes_after_it_go_in_with_their_titles_under_the_show(self):
        self.app.play(12, 120, self.app.episode_queue(PILOT), title='Pilot')
        urls = [dict(parse_qsl(urlparse(url).query)) for url, _ in kodistubs.PLAYLIST_ITEMS]
        self.assertEqual(urls, [{'mode': 'play', 'id': '12', 'start': '120', 'screens': '1'},
                                {'mode': 'play', 'id': '13', 'screens': '1'}])
        self.assertEqual(kodistubs.PLAYLIST, ['Pilot', 'S1 · E4–5 — The Next One'])
        first, after = [li for _, li in kodistubs.PLAYLIST_ITEMS]
        self.assertIsNone(first.tag)  # told as it starts (plugin.play)
        self.assertEqual(after.tag.values, {'setMediaType': 'episode', 'setTitle': 'S1 · E4–5 — The Next One',
                                            'setTvShowTitle': 'Some Show'})


if __name__ == '__main__':
    unittest.main()
