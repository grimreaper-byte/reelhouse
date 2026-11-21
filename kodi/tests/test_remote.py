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
        self.saved_settle = remote.TRACKS_SETTLE
        remote.TRACKS_SETTLE = 0  # no second look at the stubs' streams
        self.saved_string = remote.string
        remote.string = lambda n: 'Playing from %s'  # the stubs' strings take three values
        self.saved_cond = xbmc.getCondVisibility
        xbmc.getCondVisibility = lambda c: self.paused if c == 'Player.Paused' else self.saved_cond(c)

    def tearDown(self):
        connection.api = self.saved_api
        remote.string = self.saved_string
        remote.NEVER_BUSY = self.saved_never_busy
        remote.TRACKS_SETTLE = self.saved_settle
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

    # ---------- phase 2 (add-on 0.16.0): sharing, channels, sound, subtitles, volume ----------

    def rpc_recorder(self, answers=None):
        """Kodi's JSON-RPC as calls kept here, answering [answers] (by method) or {}."""
        calls = []
        saved = remote.utils.rpc

        def rpc(method, **params):
            calls.append((method, params))
            return (answers or {}).get(method, {})
        remote.utils.rpc = rpc
        self.addCleanup(setattr, remote.utils, 'rpc', saved)
        return calls

    def test_the_stream_is_shared_with_anyone_at_home_only_while_that_is_on(self):
        kodistubs.SETTINGS['remote_shared'] = 'true'
        self.addCleanup(kodistubs.SETTINGS.__setitem__, 'remote_shared', 'false')
        self.assertEqual(remote.events_query(), {'target': 'kodi', 'shared': '1'})
        kodistubs.SETTINGS['remote_control'] = 'false'
        self.assertIsNone(remote.events_query(), 'sharing needs the phone remote on')

    def test_sound_subtitles_and_volume_from_the_phone(self):
        self.playing()
        calls = self.rpc_recorder()
        for command in ({'type': 'audio', 'track': '2'}, {'type': 'subtitle', 'track': '1'},
                        {'type': 'subtitle', 'track': None}, {'type': 'volume', 'level': 40},
                        {'type': 'mute', 'muted': True}):
            remote.handle(self.player, dict(command, id=command['type']))
        sets = [(m, p) for m, p in calls if m.startswith(('Player.Set', 'Application.Set'))]
        self.assertEqual(sets, [
            ('Player.SetAudioStream', {'playerid': 1, 'stream': 2}),
            ('Player.SetSubtitle', {'playerid': 1, 'subtitle': 1, 'enable': True}),
            ('Player.SetSubtitle', {'playerid': 1, 'subtitle': 'off'}),
            ('Application.SetVolume', {'volume': 40}),
            ('Application.SetMute', {'mute': False}),
            ('Application.SetMute', {'mute': True}),
        ])
        self.assertTrue(all(body['ok'] for _, body in self.answers()))

    def test_a_refused_change_is_said(self):
        self.playing()
        self.rpc_recorder({'Player.SetAudioStream': None})
        remote.handle(self.player, {'id': 'a', 'type': 'audio', 'track': '7'})
        self.assertEqual(self.answers(), [('a', {'ok': False, 'problem': 'Kodi couldn’t change the sound track.'})])

    def test_what_kodi_offers_the_phone_is_reported_when_it_changes(self):
        self.playing()
        self.rpc_recorder({
            'Player.GetProperties': {
                'audiostreams': [{'index': 0, 'language': 'eng', 'name': 'English', 'codec': 'ac3', 'channels': 6},
                                 {'index': 1, 'language': 'fre', 'name': 'Commentary', 'codec': 'aac', 'channels': 2}],
                'currentaudiostream': {'index': 1},
                'subtitles': [{'index': 0, 'language': 'eng', 'name': 'English', 'isforced': True}],
                'currentsubtitle': {'index': 0}, 'subtitleenabled': False,
            },
            'Application.GetProperties': {'volume': 73, 'muted': False},
        })
        offer = remote.controls_now(self.player)
        self.assertEqual(offer['audio'], [{'id': '0', 'label': 'English · AC3 · 5.1'}, {'id': '1', 'label': 'Commentary · AAC · Stereo'}])
        self.assertEqual(offer['audioId'], '1')
        self.assertEqual(offer['subtitles'], [{'id': '0', 'label': 'English (forced)'}])
        self.assertIsNone(offer['subtitleId'], 'subtitles off')
        self.assertEqual((offer['volume'], offer['muted'], offer['canPause']), (73, False, True))
        remote.forget_controls()
        remote.report_controls(self.player)
        remote.report_controls(self.player)  # nothing changed: not again
        self.assertEqual([args[0] for args in self.sent].count('controls'), 1)
        self.player.current = None
        remote.report_controls(self.player)
        self.assertEqual(self.sent[-1], ('controls', {}), 'nothing playing: nothing to change')

    def a_channel_starts(self, works=True):
        from resources.lib import plugin
        import xbmcgui
        asked = []

        def start_channel(uuid):
            asked.append(uuid)
            if not works:
                return None
            self.player.live = {'uuid': uuid, 'playId': 'live-1'}  # as the service's player hears it start
            return xbmcgui.ListItem(uuid, path='http://rh/api/live/live-1/index.m3u8')
        kept, plugin.start_channel = plugin.start_channel, start_channel
        self.addCleanup(setattr, plugin, 'start_channel', kept)
        return asked

    def test_a_channel_from_the_phone_starts_at_reelhouse_then_plays_full_screen(self):
        asked = self.a_channel_starts()
        remote.handle(self.player, {'id': 'c', 'type': 'play', 'channel': 'one', 'radio': False, 'name': 'One', 'from': 'Pixel'})
        self.assertEqual(asked, ['one'])
        self.assertIn(('play', 'http://rh/api/live/live-1/index.m3u8'), kodistubs.PLAYED)
        self.assertEqual(self.answers(), [('c', {'ok': True, 'problem': None})])
        self.assertEqual(len(kodistubs.NOTIFICATIONS), 1, 'says whose phone')
        remote.handle(self.player, {'id': 'z', 'type': 'play', 'channel': 'two', 'zap': True, 'from': 'Pixel'})
        self.assertEqual(asked, ['one', 'two'])
        self.assertEqual(len(kodistubs.NOTIFICATIONS), 1, 'channel up and down quietly')

    def test_a_channel_that_wont_start_is_said(self):
        self.a_channel_starts(works=False)
        remote.handle(self.player, {'id': 'c', 'type': 'play', 'channel': 'one'})
        self.assertEqual(self.answers(), [('c', {'ok': False, 'problem': 'Kodi didn’t start the channel.'})])

    def test_a_channel_pauses_but_isnt_wound_on(self):
        self.player.live = {'uuid': 'one', 'playId': 'live-1'}
        remote.handle(self.player, {'id': 'p', 'type': 'pause'})
        remote.handle(self.player, {'id': 's', 'type': 'skip', 'seconds': 30})
        self.assertIn('pause', kodistubs.PLAYED)
        self.assertEqual(self.answers()[1], ('s', {'ok': False, 'problem': 'A channel can’t be wound on or back from the phone.'}))


if __name__ == '__main__':
    unittest.main()
