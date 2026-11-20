# The phone remote in Kodi (remote.py): the live stream opens as a target while it's allowed, and each command is
# done with Kodi's player and answered.
import unittest

import helpers  # noqa: F401  (puts the add-on on sys.path)
import kodistubs

kodistubs.install()

import xbmc  # noqa: E402

from resources.lib import connection, remote, service  # noqa: E402
from resources.lib.api import ApiError  # noqa: E402


class FakeApi(object):
    def __init__(self):
        self.posts = []
        self.items = {
            11: {'item': {'id': 11, 'type': 'episode', 'title': 'Pilot', 'parentId': 5}},
            5: {'children': [{'id': 11, 'title': 'Pilot'}, {'id': 12, 'title': 'Second'}], 'show': {'title': 'A Show'}},
            12: {'item': {'id': 12, 'type': 'episode', 'title': 'Second', 'parentId': 5}},
            1: {'item': {'id': 1, 'type': 'movie', 'title': 'A Film'}},
        }

    def get(self, path, timeout=None):
        item_id = int(path.rsplit('/', 1)[1])
        if item_id not in self.items:
            raise ApiError('Not found', 404)
        return self.items[item_id]

    def post(self, path, body=None, timeout=None):
        self.posts.append((path, body))


class RemoteTests(unittest.TestCase):
    def setUp(self):
        for store in (kodistubs.PLAYED, kodistubs.PLAYLIST, kodistubs.PLAYLIST_ITEMS, kodistubs.NOTIFICATIONS):
            del store[:]
        kodistubs.PROPERTIES.clear()
        kodistubs.SETTINGS['remote_control'] = 'true'
        self.api = FakeApi()
        self.saved_api = connection.api
        connection.api = lambda: self.api
        self.sent = []
        owner = type('Owner', (), {'send': lambda _self, *args: self.sent.append(args)})()
        self.player = service.Player(owner, controls=type('C', (), {'tick': lambda s: None, 'stop': lambda s: None})())
        self.paused = False
        self.saved_never_busy = remote.NEVER_BUSY
        remote.NEVER_BUSY = 0.05  # the stubs' player never starts anything
        self.saved_string = remote.string
        remote.string = lambda n: 'Playing from %s'  # the stubs' strings take three values
        self.saved_cond = xbmc.getCondVisibility
        xbmc.getCondVisibility = lambda c: self.paused if c == 'Player.Paused' else self.saved_cond(c)

    def tearDown(self):
        connection.api = self.saved_api
        remote.string = self.saved_string
        remote.NEVER_BUSY = self.saved_never_busy
        xbmc.getCondVisibility = self.saved_cond

    def playing(self):
        self.player.current = {'id': 11, 'playId': 'p', 'duration': 1500}
        self.player.position = 100.0

    def answers(self):
        return [(path.split('/')[4], body) for path, body in self.api.posts]

    def test_the_stream_is_a_target_only_while_the_phone_may_control_kodi(self):
        self.assertEqual(remote.events_query(), {'target': 'kodi'})
        kodistubs.SETTINGS['remote_control'] = 'false'
        self.assertIsNone(remote.events_query())

    def started_by_kodi(self):
        """Kodi starts what it's given: the service's player hears of it (onAVStarted) as the playlist goes in."""
        saved = remote.app.play

        def play(item_id, *args, **kw):
            saved(item_id, *args, **kw)
            self.player.current = {'id': item_id, 'playId': 'p', 'duration': 1500}
        remote.app.play = play
        self.addCleanup(setattr, remote.app, 'play', saved)

    def test_play_starts_it_as_the_screens_do_with_the_episodes_after_it_queued(self):
        self.started_by_kodi()
        remote.handle(self.player, {'id': 'c1', 'type': 'play', 'itemId': 11, 'start': 90, 'from': 'Pixel'})
        urls = [url for url, _ in kodistubs.PLAYLIST_ITEMS]
        self.assertEqual(len(urls), 2)
        self.assertIn('id=11', urls[0])
        self.assertIn('start=90', urls[0])
        self.assertIn('fresh=1', urls[0])
        self.assertIn('id=12', urls[1])
        self.assertIn(('play', -1), kodistubs.PLAYED)
        self.assertEqual(kodistubs.NOTIFICATIONS[-1], 'Playing from Pixel')
        self.assertEqual(self.answers(), [('c1', {'ok': True, 'problem': None})])

    def test_a_film_that_is_not_there_is_answered_with_why(self):
        remote.handle(self.player, {'id': 'c2', 'type': 'play', 'itemId': 99, 'start': 0})
        self.assertEqual(self.answers(), [('c2', {'ok': False, 'problem': 'Not found'})])

    def test_pause_and_resume_only_toggle_when_needed(self):
        self.playing()
        remote.handle(self.player, {'id': 'a', 'type': 'pause'})
        self.paused = True
        remote.handle(self.player, {'id': 'b', 'type': 'pause'})
        remote.handle(self.player, {'id': 'c', 'type': 'resume'})
        self.assertEqual([p for p in kodistubs.PLAYED if p == 'pause'], ['pause', 'pause'])
        self.assertTrue(all(body['ok'] for _, body in self.answers()))

    def test_seek_and_skip_move_and_report_at_once(self):
        self.playing()
        remote.handle(self.player, {'id': 'a', 'type': 'seek', 'position': 600})
        self.player.position = 600.0
        self.player.getTime = lambda: 600.0
        remote.handle(self.player, {'id': 'b', 'type': 'skip', 'seconds': -700})
        self.assertEqual([p for p in kodistubs.PLAYED if isinstance(p, tuple) and p[0] == 'seek'], [('seek', 600.0), ('seek', 0.0)])
        self.assertEqual([s[:5] for s in self.sent], [('progress', 11, 600.0, 1500, 'playing'), ('progress', 11, 0.0, 1500, 'playing')])

    def test_without_anything_from_reelhouse_playing_the_phone_is_told(self):
        remote.handle(self.player, {'id': 'a', 'type': 'stop'})
        self.assertEqual(self.answers(), [('a', {'ok': False, 'problem': remote.NOTHING})])

    def test_a_play_kodi_never_starts_is_answered_so(self):
        remote.handle(self.player, {'id': 'c3', 'type': 'play', 'itemId': 1, 'start': 0})
        self.assertEqual(self.answers(), [('c3', {'ok': False, 'problem': 'Kodi didn’t start it.'})])

    def test_a_play_waits_while_kodi_is_opening_something(self):
        self.started_by_kodi()
        busy = [3]  # Kodi's busy dialog shows for the next three looks

        def cond(c):
            if c == remote.BUSY:
                busy[0] -= 1
                return busy[0] >= 0
            return self.paused if c == 'Player.Paused' else self.saved_cond(c)
        xbmc.getCondVisibility = cond
        saved = remote.QUIET_FOR, remote.STEP
        remote.QUIET_FOR, remote.STEP = 0.05, 0.01
        self.addCleanup(setattr, remote, 'QUIET_FOR', saved[0])
        self.addCleanup(setattr, remote, 'STEP', saved[1])
        remote.handle(self.player, {'id': 'c4', 'type': 'play', 'itemId': 1, 'start': 0})
        self.assertLess(busy[0], 0, 'looked until the busy dialog had gone')
        self.assertEqual(self.answers(), [('c4', {'ok': True, 'problem': None})])

    def test_stop_and_next(self):
        self.started_by_kodi()
        self.playing()
        remote.handle(self.player, {'id': 'a', 'type': 'stop'})
        self.assertIn('stop', kodistubs.PLAYED)
        remote.handle(self.player, {'id': 'b', 'type': 'next', 'itemId': 12})
        self.assertIn('id=12', kodistubs.PLAYLIST_ITEMS[0][0])
        self.assertTrue(all(body['ok'] for _, body in self.answers()))


if __name__ == '__main__':
    unittest.main()
