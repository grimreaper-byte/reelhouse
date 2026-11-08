# The service's progress/watched sending, its matching of the playing stream, and what a skip tells Reelhouse, with
# Kodi stubbed out.
import json
import threading
import time
import unittest

import helpers  # noqa: F401  (puts the add-on on sys.path)
import kodistubs

kodistubs.install()

from resources.lib import connection, plugin, service, utils  # noqa: E402
from resources.lib.api import ApiError  # noqa: E402


class FakeApi(object):
    def __init__(self):
        self.online = True
        self.sent = []

    def _send(self, call):
        if not self.online:
            raise ApiError('Reelhouse is not reachable at http://rh (timed out)')
        self.sent.append(call)

    def report_progress(self, item_id, position, duration, state, play_id=None, timeout=10):
        self._send(('progress', item_id, position, state))

    def set_watched(self, item_id, watched, timeout=10):
        self._send(('watched', item_id, watched))


def wait_until(condition, timeout=3):
    end = time.time() + timeout
    while time.time() < end:
        if condition():
            return True
        time.sleep(0.02)
    return False


class SenderTests(unittest.TestCase):
    def setUp(self):
        kodistubs.ABORT.clear()
        self.api = FakeApi()
        self.saved_api = connection.api
        connection.api = lambda: self.api
        self.service = service.Service()
        self.thread = threading.Thread(target=self.service.sender, daemon=True)
        self.thread.start()

    def tearDown(self):
        kodistubs.ABORT.set()
        self.thread.join(3)
        connection.api = self.saved_api

    def test_updates_go_out_one_at_a_time_in_order(self):
        for watched in (True, False, True, False):
            self.service.send('watched', 7, watched)
        self.assertTrue(wait_until(lambda: len(self.api.sent) == 4))
        self.assertEqual([c[2] for c in self.api.sent], [True, False, True, False])

    def test_updates_made_while_reelhouse_is_unreachable_follow_when_it_is_back(self):
        self.api.online = False
        self.service.send('watched', 1, True)
        for position, state in ((10.0, 'playing'), (20.0, 'playing'), (30.0, 'stopped')):
            self.service.send('progress', 5, position, 100.0, state, 'p')
        self.assertTrue(wait_until(lambda: len(self.service.unsent) == 2), self.service.unsent)
        self.assertEqual(self.api.sent, [])
        self.api.online = True
        self.service.outbox.put(None)  # what the live stream does when it reconnects
        self.assertTrue(wait_until(lambda: len(self.api.sent) == 2))
        self.assertEqual(self.api.sent, [('watched', 1, True), ('progress', 5, 30.0, 'stopped')])

    def test_a_new_update_waits_behind_ones_that_could_not_be_sent(self):
        self.api.online = False
        self.service.send('watched', 1, True)
        self.assertTrue(wait_until(lambda: len(self.service.unsent) == 1))
        self.api.online = True
        self.service.send('watched', 1, False)
        self.assertTrue(wait_until(lambda: len(self.api.sent) == 2))
        self.assertEqual(self.api.sent, [('watched', 1, True), ('watched', 1, False)])

    def test_kodi_is_not_held_up_when_closing_while_reelhouse_is_unreachable(self):
        self.api.online = False
        for n in range(20):
            self.service.send('watched', n, True)
        kodistubs.ABORT.set()
        started = time.time()
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())
        self.assertLess(time.time() - started, 1.5)


class GreetApi(object):
    def __init__(self, answers):
        self.answers = list(answers)  # an ApiError to raise, or /api/me's answer
        self.asked = 0

    def get(self, path, timeout=None):
        self.asked += 1
        answer = self.answers.pop(0)
        if isinstance(answer, ApiError):
            raise answer
        return answer

    def host(self):
        return 'rh'


class GreetTests(unittest.TestCase):
    def setUp(self):
        kodistubs.ABORT.clear()
        del kodistubs.NOTIFICATIONS[:]
        kodistubs.SETTINGS.update({'server_url': 'http://rh:8484', 'device_token': 't', 'user_name': 'dave',
                                   'server_name': 'my-server'})
        self.saved = connection.api, service.string, service.GREET_RETRY
        service.string = lambda string_id: '#{} %s|%s'.format(string_id)
        service.GREET_RETRY = 0.01
        self.service = service.Service()

    def tearDown(self):
        connection.api, service.string, service.GREET_RETRY = self.saved
        kodistubs.SETTINGS.clear()

    def greet(self, *answers):
        api = GreetApi(answers)
        connection.api = lambda: api
        self.service.greet()
        return api

    def test_says_who_this_kodi_is_signed_in_as(self):
        self.greet({'user': {'username': 'dave'}})
        self.assertEqual(kodistubs.NOTIFICATIONS, ['#30121 my-server|dave'])

    def test_waits_for_reelhouse_to_answer(self):
        api = self.greet(ApiError('not reachable'), ApiError('Bad gateway', 502), {'user': {'username': 'dave'}})
        self.assertEqual(api.asked, 3)
        self.assertEqual(kodistubs.NOTIFICATIONS, ['#30121 my-server|dave'])

    def test_a_renamed_account_shows_and_is_kept_under_its_new_name(self):
        self.greet({'user': {'username': 'David'}})
        self.assertEqual(kodistubs.NOTIFICATIONS, ['#30121 my-server|David'])
        self.assertEqual(kodistubs.SETTINGS['user_name'], 'David')

    def test_a_rejected_sign_in_says_so_instead(self):
        self.greet(ApiError('Not signed in', 401))
        self.assertEqual(kodistubs.NOTIFICATIONS, ['#30119 %s|%s'])
        self.assertTrue(self.service.rejected)

    def test_says_nothing_when_not_signed_in(self):
        kodistubs.SETTINGS['device_token'] = ''
        api = self.greet()
        self.assertEqual((api.asked, kodistubs.NOTIFICATIONS), (0, []))


class CompactTests(unittest.TestCase):
    def test_later_reports_replace_playing_heartbeats_of_the_same_item(self):
        jobs = [('progress', (5, 10.0, 100.0, 'playing', 'p')), ('progress', (5, 20.0, 100.0, 'paused', 'p')),
                ('progress', (6, 5.0, 50.0, 'playing', 'q')), ('progress', (6, 9.0, 50.0, 'playing', 'q')),
                ('watched', (6, True)), ('progress', (6, 12.0, 50.0, 'playing', 'q'))]
        self.assertEqual(service.compact(jobs), [jobs[1], jobs[3], jobs[4], jobs[5]])

    def test_keeps_the_newest_when_too_many(self):
        jobs = [('watched', (n, True)) for n in range(service.UNSENT_MAX + 10)]
        self.assertEqual(service.compact(jobs), jobs[10:])


class FakeOverlay(object):
    def __init__(self):
        self.shown, self.closed, self.updates = [], 0, 0

    def show(self, logo, stop, now=None):
        self.shown.append((logo, stop))

    def update(self, now=None):
        self.updates += 1

    def programme(self, stop, now=None):
        self.shown.append(('programme', stop))

    def ended(self, now=None):
        return False

    def close(self):
        self.closed += 1


class PlayerTests(unittest.TestCase):
    def setUp(self):
        kodistubs.PROPERTIES.clear()
        self.sent = []
        owner = type('Owner', (), {'send': lambda _self, *args: self.sent.append(args)})()
        self.overlay = FakeOverlay()
        self.player = service.Player(owner, self.overlay)

    def start(self, item_id, playing_file):
        kodistubs.PROPERTIES[utils.PLAYING_PROPERTY] = json.dumps({'id': item_id, 'playId': 'p', 'duration': 100})
        self.player.playing_file = playing_file
        self.player.onAVStarted()

    def test_reports_the_stream_the_add_on_handed_out(self):
        self.start(1, 'http://rh:8484/api/stream/1?X-Reelhouse-Token=t')
        self.assertEqual(self.player.current['id'], 1)
        self.assertEqual(self.sent, [('progress', 1, 0.0, 100, 'playing', 'p')])

    def test_the_reelhouse_screens_resume_where_they_say(self):
        kodistubs.PROPERTIES[utils.PLAYING_PROPERTY] = json.dumps({'id': 1, 'playId': 'p', 'duration': 100, 'start': 42.0})
        self.player.playing_file = 'http://rh:8484/api/stream/1?X-Reelhouse-Token=t'
        self.player.onAVStarted()
        self.assertEqual(self.player.seeked, 42.0)
        self.assertEqual(self.sent, [('progress', 1, 42.0, 100, 'playing', 'p')])

    def test_live_tv_sends_heartbeats_and_frees_the_tuner_when_it_stops(self):
        kodistubs.PROPERTIES[utils.LIVE_PROPERTY] = json.dumps({'playId': 'abc', 'channel': 'Test One'})
        self.player.playing_file = 'http://rh:8484/api/live/abc/index.m3u8'
        self.player.onAVStarted()
        self.assertEqual(self.sent, [('live', 'abc', 'playing')])
        self.player.onPlayBackPaused()
        self.player.onPlayBackStopped()
        self.assertEqual(self.sent[1:], [('live', 'abc', 'paused'), ('live', 'abc', 'stopped')])
        self.assertNotIn(utils.LIVE_PROPERTY, kodistubs.PROPERTIES)
        self.assertIsNone(self.player.live)

    def test_a_live_channel_shows_its_logo_and_time_left_over_kodis_controls(self):
        kodistubs.PROPERTIES[utils.LIVE_PROPERTY] = json.dumps({'playId': 'abc', 'channel': 'Test One', 'logo': 'http://rh/logo', 'stop': 1800})
        self.player.playing_file = 'http://rh:8484/api/live/abc/index.m3u8'
        self.player.onAVStarted()
        self.assertEqual(self.overlay.shown, [('http://rh/logo', 1800)])
        self.player.tick()
        self.assertEqual(self.overlay.updates, 1)
        self.player.onPlayBackStopped()
        self.assertEqual(self.overlay.closed, 1)

    def test_radio_has_no_overlay(self):
        kodistubs.PROPERTIES[utils.LIVE_PROPERTY] = json.dumps({'playId': 'abc', 'radio': True, 'logo': 'x', 'stop': 1800})
        self.player.playing_file = 'http://rh:8484/api/live/abc/index.m3u8'
        self.player.onAVStarted()
        self.assertEqual(self.overlay.shown, [])

    def test_the_time_left_reads_as_the_guide_says_it(self):
        from resources.lib import live_overlay
        self.assertEqual(live_overlay.time_left(1800, 60), '29 min left')
        self.assertEqual(live_overlay.time_left(1800, 1790), '1 min left')
        self.assertEqual(live_overlay.time_left(1800, 1800), '')
        self.assertEqual(live_overlay.time_left(None, 60), '')

    def overlay_world(self, osd_open=False):
        """A stand-in for Kodi's windows: what goes in and out of its controls window, and the home window's properties."""
        from resources.lib import live_overlay
        world = type('World', (), {})()
        world.osd_open, world.inside, world.windows, world.homes, world.removals = osd_open, [], [], {}, 0

        class Control(object):
            def __init__(self, *args, **kwargs):
                self.args, self.kwargs, self.when, self.animations = args, kwargs, None, []

            def setVisibleCondition(self, condition, allow_hidden_focus=False):
                self.when = condition

            def setAnimations(self, animations):
                self.animations = animations

            def setLabel(self, *args, **kwargs):
                raise AssertionError('a label in a window not its own goes to every window')

            setImage = setLabel

        class Window(object):
            def __init__(self, window_id):
                self.window_id = window_id
                if window_id == live_overlay.OSD:
                    world.windows.append(self)

            def addControl(self, control):
                world.inside.append(control)

            def removeControls(self, controls):
                world.removals += 1
                if any(c not in world.inside for c in controls):
                    raise RuntimeError('Control does not exist in window')
                world.inside[:] = [c for c in world.inside if c not in controls]

            def setProperty(self, key, value):
                world.homes[key] = value

            def clearProperty(self, key):
                world.homes.pop(key, None)

        gui = type('Gui', (), {'ControlImage': Control, 'ControlLabel': Control, 'Window': Window})
        world.overlay = live_overlay.Overlay(gui, lambda condition: world.osd_open and condition == 'Window.IsVisible(videoosd)')
        return world

    def test_the_overlay_waits_for_kodis_controls_then_goes_in_them_and_is_held(self):
        # Not a dialog of its own (Kodi would give that the remote), nor Kodi's seek bar (which throws added controls
        # away): two controls in Kodi's controls window, once it has loaded (it loads when it first opens).
        from resources.lib import live_overlay
        world = self.overlay_world()
        o = world.overlay
        o.show('http://rh/logo', 1800, now=60)
        self.assertEqual(world.inside, [])
        self.assertEqual(world.homes, {live_overlay.SHOWING: o.token, live_overlay.LEFT: '29 min left'})
        world.osd_open = True
        o.update(now=120)
        logo, left = world.inside
        self.assertEqual(logo.args[4], 'http://rh/logo')
        # The label reads the time left from the home window: nothing is changed in a control once it's in.
        self.assertEqual(left.args[4], '$INFO[Window(Home).Property({})]'.format(live_overlay.LEFT))
        self.assertEqual(world.homes[live_overlay.LEFT], '28 min left')
        self.assertIn('String.IsEqual(Window(Home).Property({}),{})'.format(live_overlay.SHOWING, o.token), logo.when)
        self.assertIn('Window.IsVisible(osdvideosettings)', left.when)
        # They go with Kodi's controls rather than staying until the window has gone: the logo up with the top bar,
        # the time left down with the bottom bar, in Kodi's time font.
        self.assertIn(('WindowClose', 'effect=fade start=100 end=0 time=300'), logo.animations)
        self.assertTrue(any(e == 'WindowClose' and 'end=0,-200' in a for e, a in logo.animations))
        self.assertTrue(any(e == 'WindowClose' and 'end=0,200' in a for e, a in left.animations))
        self.assertEqual(left.kwargs['font'], 'font45')
        # Held: letting go of the window it added them through would cut its hold on them.
        self.assertEqual([w.window_id for w in world.windows], [live_overlay.OSD])
        self.assertIs(o.window, world.windows[0])

    def test_a_channel_change_swaps_the_controls_and_a_stop_hides_them(self):
        from resources.lib import live_overlay
        world = self.overlay_world(osd_open=True)
        o = world.overlay
        o.show('http://rh/logo', 1800, now=60)
        first = list(world.inside)
        world.osd_open = False  # loaded once opened: the next channel's go straight in
        o.show('http://rh/logo2', 3600, now=60)
        self.assertEqual(len(world.inside), 2)
        self.assertFalse(set(first) & set(world.inside))
        self.assertEqual(world.inside[0].args[4], 'http://rh/logo2')
        o.programme(7200, now=3600)  # the next programme: the same controls
        self.assertEqual((world.removals, world.homes[live_overlay.LEFT]), (1, '60 min left'))
        self.assertTrue(o.ended(now=7200))
        o.close()
        self.assertEqual(world.homes, {})
        self.assertEqual(len(world.inside), 2)  # left in, hidden, for the next channel to swap
        self.assertFalse(o.ended(now=9999))

    def test_controls_a_skin_reload_took_come_back_when_kodis_controls_next_show(self):
        world = self.overlay_world(osd_open=True)
        o = world.overlay
        o.show('http://rh/logo', 1800, now=60)
        del world.inside[:]  # the skin reloaded, deleting them
        world.osd_open = False
        o.show('http://rh/logo', 1800, now=60)
        self.assertEqual(world.inside, [])
        world.osd_open = True
        o.update(now=61)
        self.assertEqual(len(world.inside), 2)

    def test_a_channel_without_a_logo_has_only_the_time_left(self):
        world = self.overlay_world(osd_open=True)
        world.overlay.show('', 1800, now=60)
        self.assertEqual(len(world.inside), 1)

    def test_a_channel_change_leaves_the_new_sessions_property(self):
        kodistubs.PROPERTIES[utils.LIVE_PROPERTY] = json.dumps({'playId': 'old'})
        self.player.playing_file = 'http://rh:8484/api/live/old/index.m3u8'
        self.player.onAVStarted()
        kodistubs.PROPERTIES[utils.LIVE_PROPERTY] = json.dumps({'playId': 'new'})  # the next channel resolved
        self.player.report_live('stopped')  # the old one's stop arrives late
        self.assertEqual(json.loads(kodistubs.PROPERTIES[utils.LIVE_PROPERTY])['playId'], 'new')

    def test_skipping_on_stops_the_item_left(self):
        # The remote's Next: Kodi says the next one started, and never that this one stopped.
        self.start(1, 'http://rh:8484/api/stream/1?X-Reelhouse-Token=t')
        self.sent.clear()
        self.player.position = 24.0
        self.player.playing_file = 'http://rh:8484/api/stream/2?X-Reelhouse-Token=t'
        self.player.onPlayBackStarted()
        self.assertEqual(self.sent, [('progress', 1, 24.0, 100, 'stopped', 'p')])
        self.assertIsNone(self.player.current)
        self.start(2, 'http://rh:8484/api/stream/2?X-Reelhouse-Token=t')
        self.assertEqual(self.player.current['id'], 2)
        self.assertEqual(self.sent[1:], [('progress', 2, 0.0, 100, 'playing', 'p')])

    def test_starting_the_first_item_stops_nothing(self):
        self.player.onPlayBackStarted()
        self.assertEqual(self.sent, [])

    def test_leaving_live_tv_for_a_film_frees_the_tuner(self):
        kodistubs.PROPERTIES[utils.LIVE_PROPERTY] = json.dumps({'playId': 'abc', 'channel': 'Test One'})
        self.player.playing_file = 'http://rh:8484/api/live/abc/index.m3u8'
        self.player.onAVStarted()
        self.player.playing_file = 'http://rh:8484/api/stream/2?X-Reelhouse-Token=t'
        self.player.onPlayBackStarted()
        self.assertEqual(self.sent[1:], [('live', 'abc', 'stopped')])

    def test_the_next_items_time_is_not_taken_for_the_one_left(self):
        self.start(1, 'http://rh:8484/api/stream/1?X-Reelhouse-Token=t')
        self.player.getTime = lambda: 3.0
        self.player.tick()
        self.assertEqual(self.player.position, 3.0)
        self.player.position = 24.0
        self.player.playing_file = 'http://rh:8484/api/stream/2?X-Reelhouse-Token=t'  # Kodi moved on, and hasn't said so yet
        self.player.tick()
        self.assertEqual(self.player.position, 24.0)

    def test_skipping_quickly_keeps_the_next_streams_details(self):
        # The second Next was resolved before the first's picture came up: that one isn't reported, the next one is.
        kodistubs.PROPERTIES[utils.PLAYING_PROPERTY] = json.dumps({'id': 3, 'playId': 'q', 'duration': 100})
        self.player.playing_file = 'http://rh:8484/api/stream/2?X-Reelhouse-Token=t'
        self.player.onAVStarted()
        self.assertIsNone(self.player.current)
        self.player.playing_file = 'http://rh:8484/api/stream/3?X-Reelhouse-Token=t'
        self.player.onAVStarted()
        self.assertEqual(self.player.current['id'], 3)
        self.assertEqual(self.sent, [('progress', 3, 0.0, 100, 'playing', 'q')])
        self.assertNotIn(utils.PLAYING_PROPERTY, kodistubs.PROPERTIES)

    def test_another_video_is_not_mistaken_for_it(self):
        self.start(1, 'http://rh:8484/api/stream/14?X-Reelhouse-Token=t')
        self.start(1, 'plugin://plugin.video.youtube/play/?video_id=1')
        self.assertIsNone(self.player.current)
        self.assertEqual(self.sent, [])


class UnstartedStreamTests(unittest.TestCase):
    def setUp(self):
        kodistubs.PROPERTIES.clear()
        self.sent = []
        self.api = type('Api', (), {'report_progress': lambda _self, *args, **kw: self.sent.append(args)})()

    def test_a_stream_skipped_before_its_picture_came_up_is_let_go(self):
        kodistubs.PROPERTIES[utils.PLAYING_PROPERTY] = json.dumps({'id': 2, 'playId': 'p', 'duration': 100})
        plugin.let_go_of_unstarted(self.api)
        self.assertEqual(self.sent, [(2, 0, 100, 'stopped', 'p')])

    def test_nothing_waiting_means_nothing_to_say(self):
        plugin.let_go_of_unstarted(self.api)
        self.assertEqual(self.sent, [])

    def test_reelhouse_out_of_reach_does_not_stop_the_next_one_being_asked_for(self):
        def refuse(*args, **kw):
            raise ApiError('Reelhouse is not reachable at http://rh (timed out)')
        self.api.report_progress = refuse
        kodistubs.PROPERTIES[utils.PLAYING_PROPERTY] = json.dumps({'id': 2, 'playId': 'p', 'duration': 100})
        plugin.let_go_of_unstarted(self.api)  # says nothing, and raises nothing


if __name__ == '__main__':
    unittest.main()
