# Reelhouse's own player controls for a live channel (live_osd.py): what they say, as Kodi's controls say it for a
# channel from its own TV add-ons, and how they answer the remote, with Kodi stubbed out.
import json
import unittest
from datetime import datetime

import helpers  # noqa: F401  (puts the add-on on sys.path)
import kodistubs

kodistubs.install()

import xbmc  # noqa: E402
import xbmcgui  # noqa: E402

from resources.lib import live_osd, utils  # noqa: E402

TWELVE = '%I:%M %p'


def at(hour, minute, second=0):
    return datetime(2026, 11, 7, hour, minute, second).timestamp()


class WordingTests(unittest.TestCase):
    def test_times_of_day_as_kodi_shows_them(self):
        self.assertEqual(live_osd.time_format('%I:%M:%S %p'), TWELVE)
        self.assertEqual(live_osd.time_format('%H:%M:%S'), '%H:%M')
        self.assertEqual(live_osd.clock(at(23, 45), TWELVE), '11:45 PM')
        self.assertEqual(live_osd.clock(at(9, 5), TWELVE), '9:05 AM')
        self.assertEqual(live_osd.clock(at(9, 5), '%H:%M'), '09:05')

    def test_lengths_as_kodis_player_says_them(self):
        self.assertEqual(live_osd.length(46 * 60 + 9), '46:09')
        self.assertEqual(live_osd.length(3600), '01:00:00')
        self.assertEqual(live_osd.length(-5), '00:00')

    def test_the_layout_in_the_users_picture_of_kodis_own(self):
        # Kodi with Tvheadend's add-on: 11:45 PM and 12:45 AM at the bar's ends, 46:09 / 01:00:00, Ends at 12:45 AM.
        event = {'id': 3, 'start': at(23, 45), 'stop': at(23, 45) + 3600, 'title': 'English Football League Highlights',
                 'episodeLabel': 'S1 E2', 'summary': 'Goals.', 'genreName': 'Sport'}
        following = {'start': event['stop'], 'stop': event['stop'] + 1800, 'title': 'Late News'}
        v = live_osd.view('Test One', event, following, event['start'] + 46 * 60 + 9, 120, TWELVE)
        self.assertEqual((v['start'], v['end'], v['time'], v['ends']), ('11:45 PM', '12:45 AM', '46:09 / 01:00:00', 'Ends at: 12:45 AM'))
        self.assertAlmostEqual(v['percent'], 76.9, places=1)
        self.assertEqual(v['title'], 'English Football League Highlights')
        self.assertEqual(v['subtitle'], 'Test One · S1 E2')
        self.assertEqual(v['line'], '11:45 PM – 12:45 AM · Sport')
        self.assertEqual(v['next'], 'Next: 12:45 AM  Late News')
        self.assertTrue(v['recordable'])

    def test_without_a_guide_it_says_how_long_the_channel_has_played(self):
        v = live_osd.view('Test One', None, None, at(12, 0), 75, TWELVE)
        self.assertEqual((v['title'], v['time'], v['start'], v['ends'], v['percent']), ('Test One', '01:15', '', '', 0.0))

    def test_the_record_button_is_red_while_the_programme_records(self):
        event = {'id': 3, 'start': 0, 'stop': 60, 'title': 'x'}
        v = live_osd.view('', event, None, 10, 10, TWELVE)
        self.assertEqual((v['recordable'], v['set'], v['recording']), (True, False, False))
        event['dvr'] = {'state': 'scheduled'}
        self.assertTrue(live_osd.view('', event, None, 10, 10, TWELVE)['set'])
        event['dvr']['state'] = 'recording'
        v = live_osd.view('', event, None, 10, 10, TWELVE)
        self.assertEqual((v['recordable'], v['set'], v['recording']), (True, True, True))


class GuideTests(unittest.TestCase):
    def test_the_programme_on_screen_and_what_follows(self):
        g = live_osd.Guide([{'id': 1, 'start': 0, 'stop': 60}, None, {'id': 2, 'start': 60, 'stop': 120}])
        self.assertEqual(g.at(59)['id'], 1)
        self.assertEqual(g.after(g.at(10))['id'], 2)
        self.assertFalse(g.wants_more(10))
        self.assertTrue(g.wants_more(60))   # the last one known: time to ask what's after it
        self.assertTrue(g.wants_more(500))  # nothing known
        g.add([{'id': 2, 'start': 60, 'stop': 120, 'dvr': {'state': 'recording'}}, {'id': 3, 'start': 120, 'stop': 180}])
        self.assertEqual([e['id'] for e in g.events], [1, 2, 3])
        self.assertEqual(g.at(61)['dvr']['state'], 'recording')


class FakeControl(object):
    def __init__(self, log, control_id):
        self.log, self.id = log, control_id

    def setLabel(self, text):
        self.log.append((self.id, text))

    def setText(self, text):
        self.log.append((self.id, text))

    def setPercent(self, percent):
        self.log.append((self.id, percent))

    def setImage(self, image, use_cache=True):
        self.log.append((self.id, image))


class FakeDialog(object):
    def __init__(self):
        self.log, self.focus, self.closed, self.ready_now = [], 0, 0, True

    def getControl(self, control_id):
        return FakeControl(self.log, control_id)

    def setFocusId(self, control_id):
        self.focus = control_id

    def getFocusId(self):
        return self.focus

    def close(self):
        self.closed += 1


class FakePlayer(object):
    def __init__(self):
        self.time = 0.0

    def getTime(self):
        return self.time


class ControlsTests(unittest.TestCase):
    def setUp(self):
        kodistubs.PROPERTIES.clear()
        del kodistubs.PLAYED[:]
        del kodistubs.BUILTINS[:]
        self.clock = at(23, 45) + 600.0
        self.spawned = []
        self.conditions = {'Window.IsActive(fullscreenvideo)': True, 'Player.Paused': False, 'Player.PauseEnabled': True}
        self._cond = xbmc.getCondVisibility
        xbmc.getCondVisibility = lambda c: self.conditions.get(c, False)
        self.controls = live_osd.LiveControls(spawn=self.spawned.append, now=lambda: self.clock)
        self.player = FakePlayer()
        now = {'id': 3, 'start': at(23, 45), 'stop': at(23, 45) + 3600, 'title': 'Highlights'}
        self.controls.start({'playId': 'p', 'channel': 'Test One', 'uuid': 'u1', 'logo': 'http://rh/logo', 'now': now}, self.player)
        self.dialog = FakeDialog()
        self.controls.dialog = self.dialog

    def tearDown(self):
        xbmc.getCondVisibility = self._cond

    def with_channels(self, names, playing):
        """The guide's channels (c0, c1…) as the screens leave them, the one at `playing` starting on its own (not
        through Kodi's playlist, which made Kodi quit): the controls take the order."""
        kodistubs.PROPERTIES[utils.CHANNELS_PROPERTY] = json.dumps(
            [{'uuid': 'c{}'.format(n), 'name': name} for n, name in enumerate(names)])
        now = {'id': 3, 'start': at(23, 45), 'stop': at(23, 45) + 3600, 'title': 'Highlights'}
        self.controls.start({'playId': 'p', 'channel': names[playing], 'uuid': 'c{}'.format(playing), 'now': now}, self.player)
        self.assertNotIn(utils.CHANNELS_PROPERTY, kodistubs.PROPERTIES)  # taken
        del kodistubs.PLAYED[:]

    def switched_to(self, started=None):
        """Runs the channel change the controls set off: the channels started at Reelhouse and the streams played."""
        from resources.lib import plugin
        asked = []

        def start_channel(uuid):
            asked.append(uuid)
            if started is not None and uuid not in started:
                return None  # it couldn't play (said why)
            return xbmcgui.ListItem(uuid, path='http://rh/api/live/{}/index.m3u8'.format(uuid))

        kept, plugin.start_channel = plugin.start_channel, start_channel
        try:
            if self.controls.switch in self.spawned:
                self.spawned.remove(self.controls.switch)
                self.controls.switch()
        finally:
            plugin.start_channel = kept
        return asked, [p[1] for p in kodistubs.PLAYED if isinstance(p, tuple)]

    def showing(self):
        return kodistubs.PROPERTIES.get(live_osd.SHOWING) == '1'

    def test_they_show_as_a_channel_starts_and_hide_after_a_few_seconds(self):
        self.assertTrue(self.showing())
        self.assertIn(self.controls.run, self.spawned)  # the thread that puts them over the picture
        self.clock += live_osd.SHOW_FOR - 1
        self.controls.tick()
        self.assertTrue(self.showing())
        self.clock += 1
        self.controls.tick()
        self.assertFalse(self.showing())
        self.assertEqual(self.dialog.focus, live_osd.CATCH)

    def test_they_stay_while_paused(self):
        self.conditions['Player.Paused'] = True
        self.clock += 60
        self.controls.tick()
        self.assertTrue(self.showing())

    def test_they_say_where_the_picture_is_in_the_programme(self):
        self.player.time = 120.0  # the stream started at 23:55 and has played two minutes
        self.controls.ready(self.dialog)
        said = dict(self.dialog.log)
        self.assertEqual(said[live_osd.TIME], '12:00 / 01:00:00')
        self.assertEqual(said[live_osd.START], '23:45')
        self.assertEqual(said[live_osd.ENDS], 'Ends at: 00:45')
        self.assertEqual(said[live_osd.TITLE], 'Highlights')
        self.assertEqual(said[live_osd.SUBTITLE], 'Test One')
        self.assertEqual(said[live_osd.BAR], 20.0)
        self.assertEqual(said[live_osd.LOGO], 'http://rh/logo')
        del self.dialog.log[:]
        self.controls.draw()  # nothing new to say: nothing sent
        self.assertEqual(self.dialog.log, [])

    def test_a_pause_holds_the_times(self):
        self.controls.ready(self.dialog)
        self.clock += 300  # paused five minutes: the stream hasn't played on
        del self.dialog.log[:]
        self.controls.draw()
        self.assertNotIn(live_osd.TIME, dict(self.dialog.log))

    def test_up_and_down_change_channel_while_hidden(self):
        self.with_channels(['Test One', 'Test Two', 'Test Three'], playing=1)
        self.controls.hide()
        self.controls.on_action(self.dialog, live_osd.ACTION_UP)
        self.assertEqual(self.switched_to(), (['c2'], ['http://rh/api/live/c2/index.m3u8']))
        self.controls.on_action(self.dialog, live_osd.ACTION_UP)  # the last channel: nowhere to go
        self.assertEqual(self.switched_to(), ([], ['http://rh/api/live/c2/index.m3u8']))
        self.controls.on_action(self.dialog, live_osd.ACTION_DOWN)
        self.controls.on_action(self.dialog, live_osd.ACTION_DOWN)  # pressed again before the first has started
        self.assertEqual(self.switched_to()[0], ['c0'])  # straight to the one asked for last

    def test_up_changes_channel_while_the_controls_show_too(self):
        # They show for a few seconds as a channel starts: flicking through channels, the next press went to them.
        self.with_channels(['Test One', 'Test Two', 'Test Three'], playing=0)
        self.assertTrue(self.showing())
        self.controls.on_action(self.dialog, live_osd.ACTION_UP)
        self.assertEqual(self.switched_to()[0], ['c1'])

    def test_a_channel_that_cant_play_leaves_the_one_playing(self):
        self.with_channels(['Test One', 'Test Two', 'Test Three'], playing=0)
        self.controls.hide()
        self.controls.on_action(self.dialog, live_osd.ACTION_UP)
        self.assertEqual(self.switched_to(started=[]), (['c1'], []))  # no skipping on through the others
        self.controls.on_action(self.dialog, live_osd.ACTION_UP)
        self.assertEqual(self.switched_to()[0], ['c1'])  # still from the one playing

    def test_back_hides_them_then_leaves_the_picture(self):
        self.controls.on_action(self.dialog, live_osd.ACTION_NAV_BACK)
        self.assertFalse(self.showing())
        self.assertEqual(self.dialog.closed, 0)
        self.controls.on_action(self.dialog, live_osd.ACTION_NAV_BACK)
        self.assertEqual(self.dialog.closed, 1)
        self.assertTrue(self.controls.leaving)

    def test_ok_while_hidden_shows_them_on_pause(self):
        self.controls.hide()
        self.controls.on_action(self.dialog, live_osd.ACTION_SELECT)  # the focus holder's click does it
        self.assertFalse(self.showing())
        self.controls.on_click(self.dialog, live_osd.CATCH)
        self.assertTrue(self.showing())
        self.assertEqual(self.dialog.focus, live_osd.PAUSE)

    def test_a_stream_kodi_cant_pause_starts_on_stop(self):
        self.conditions['Player.PauseEnabled'] = False
        self.controls.hide()
        self.controls.on_click(self.dialog, live_osd.CATCH)
        self.assertEqual(self.dialog.focus, live_osd.STOP)
        self.controls.on_action(self.dialog, live_osd.ACTION_PAUSE)  # Kodi's own (and it can't here)
        self.assertEqual(kodistubs.PLAYED, [])

    def test_kodis_do_nothing_action_leaves_them_hidden(self):
        # Kodi sends 999 before some keys: taken for a key, the controls came up and swallowed the Up after it.
        self.with_channels(['Test One', 'Test Two'], playing=0)
        self.controls.hide()
        self.controls.on_action(self.dialog, 999)
        self.assertFalse(self.showing())
        self.controls.on_action(self.dialog, live_osd.ACTION_UP)
        self.assertEqual(self.switched_to()[0], ['c1'])

    def test_left_and_right_go_back_and_on_where_the_player_can(self):
        self.controls.hide()
        self.controls.on_action(self.dialog, live_osd.ACTION_LEFT)  # a stream Kodi can't seek in: nothing
        self.conditions['Player.SeekEnabled'] = True
        self.controls.hide()  # (they came up for it; shown, left and right move between their buttons)
        self.controls.on_action(self.dialog, live_osd.ACTION_LEFT)
        self.assertEqual(kodistubs.PLAYED, [('seek', 0.0)])  # from 0: no further back than the start
        self.assertTrue(self.showing())

    def test_info_shows_the_programmes_details(self):
        self.controls.hide()
        self.controls.on_action(self.dialog, live_osd.ACTION_SHOW_INFO)
        self.assertEqual(kodistubs.PROPERTIES.get(live_osd.SHOWING_INFO), '1')
        self.controls.on_action(self.dialog, live_osd.ACTION_SHOW_INFO)
        self.assertEqual(kodistubs.PROPERTIES.get(live_osd.SHOWING_INFO), '')

    def test_they_go_with_the_picture_and_stay_over_a_channel_change(self):
        self.controls.stop()
        self.clock += 5
        self.controls.tick()
        self.assertEqual(self.dialog.closed, 0)  # the next channel may be starting
        self.conditions['Window.IsActive(fullscreenvideo)'] = False
        self.controls.tick()
        self.assertEqual(self.dialog.closed, 1)

    def test_the_next_programme_is_asked_for_as_the_last_known_one_plays(self):
        self.controls.tick()
        self.assertIn(self.controls.ask_guide, self.spawned)
        count = self.spawned.count(self.controls.ask_guide)
        self.controls.tick()  # not again straight away
        self.assertEqual(self.spawned.count(self.controls.ask_guide), count)

    def test_record_is_offered_once_the_account_may_and_goes_red_as_it_records(self):
        self.controls.ready(self.dialog)
        self.assertEqual(kodistubs.PROPERTIES.get(live_osd.CAN_RECORD), '')
        self.controls.can_record = True
        self.controls.draw()
        self.assertEqual(kodistubs.PROPERTIES.get(live_osd.CAN_RECORD), '1')
        self.assertEqual(kodistubs.PROPERTIES.get(live_osd.RECORDING), '')
        self.controls.guide.events[0]['dvr'] = {'state': 'recording', 'uuid': 'd1'}
        self.controls.draw()
        self.assertEqual(kodistubs.PROPERTIES.get(live_osd.RECORDING), '1')
        self.assertEqual(kodistubs.PROPERTIES.get(live_osd.CAN_RECORD), '1')  # still there, to stop it

    def test_the_remotes_player_buttons(self):
        # Kodi pauses by itself (pausing too undid it); stop and next/previous are the controls'.
        self.with_channels(['Test One', 'Test Two'], playing=0)
        self.controls.hide()
        self.controls.on_action(self.dialog, live_osd.ACTION_PAUSE)
        self.assertTrue(self.showing())
        self.controls.on_action(self.dialog, live_osd.ACTION_PLAYER_PLAY)
        self.controls.on_action(self.dialog, live_osd.ACTION_NEXT_ITEM)
        self.controls.on_action(self.dialog, live_osd.ACTION_STOP)
        self.assertEqual([p for p in kodistubs.PLAYED if p in ('pause', 'stop')], ['stop'])
        self.assertEqual(self.switched_to()[0], ['c1'])
        self.assertEqual(self.dialog.closed, 1)

    def test_stop_closes_them_and_stops_the_player(self):
        self.controls.on_click(self.dialog, live_osd.STOP)
        self.assertEqual((self.dialog.closed, kodistubs.PLAYED), (1, ['stop']))
        self.assertFalse(self.showing())


class OfferTests(unittest.TestCase):
    """The Reelhouse screens offer InputStream FFmpeg Direct (pausing live TV) once, when Live TV is there."""

    def setUp(self):
        from resources.lib.ui import app
        self.app_module = app
        self.app = app.App.__new__(app.App)  # without signing in
        self.app.me = {'liveTv': {'available': True}}
        kodistubs.SETTINGS.pop(app.TIMESHIFT_ASKED, None)
        self.installed = False
        self._cond = xbmc.getCondVisibility
        xbmc.getCondVisibility = lambda c: self.installed and c == 'System.HasAddon({})'.format(utils.TIMESHIFT_PLAYER)

    def tearDown(self):
        xbmc.getCondVisibility = self._cond
        kodistubs.SETTINGS.pop(self.app_module.TIMESHIFT_ASKED, None)

    def test_offered_when_live_tv_is_there_and_it_isnt(self):
        self.assertTrue(self.app.timeshift_wanted())

    def test_not_again_once_offered(self):
        kodistubs.SETTINGS[self.app_module.TIMESHIFT_ASKED] = 'true'
        self.assertFalse(self.app.timeshift_wanted())

    def test_not_when_installed_or_without_live_tv(self):
        self.installed = True
        self.assertFalse(self.app.timeshift_wanted())
        self.installed = False
        self.app.me = {'liveTv': {'available': False}}
        self.assertFalse(self.app.timeshift_wanted())


if __name__ == '__main__':
    unittest.main()
