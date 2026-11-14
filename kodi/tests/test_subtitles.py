# Subtitles start off for what plays from Reelhouse (but for a file's forced ones), and carry on to the next episode:
# the choice (subtitles.py) and when the service makes it (service.Player), with Kodi's JSON-RPC stubbed.
import json
import time
import unittest

import helpers  # noqa: F401  (puts the add-on on sys.path)
import kodistubs

kodistubs.install()

from resources.lib import service, subtitles, utils  # noqa: E402

ENGLISH = {'index': 0, 'language': 'eng', 'name': 'English', 'isforced': False}
ENGLISH_FORCED = {'index': 1, 'language': 'eng', 'name': 'English (forced)', 'isforced': True}
FRENCH = {'index': 2, 'language': 'fre', 'name': 'French', 'isforced': False}


def kodi(on, current=None, subs=(ENGLISH, ENGLISH_FORCED, FRENCH), audio='eng'):
    """What Kodi's Player.GetProperties answers."""
    return {'subtitleenabled': on, 'currentsubtitle': current or {}, 'subtitles': list(subs),
            'currentaudiostream': {'index': 0, 'language': audio}}


class ChoiceTests(unittest.TestCase):
    def test_a_default_track_kodi_showed_goes_off(self):
        self.assertIsNone(subtitles.choose(kodi(True, ENGLISH, subs=(ENGLISH, FRENCH))))

    def test_forced_ones_in_the_audios_language_still_show(self):
        self.assertEqual(subtitles.choose(kodi(True, ENGLISH)), 1)
        self.assertEqual(subtitles.choose(kodi(False)), 1)
        self.assertIsNone(subtitles.choose(kodi(False, audio='fre')))  # forced English parts aren't for French audio
        marked = dict(ENGLISH_FORCED, isdefault=True)
        self.assertEqual(subtitles.choose(kodi(False, subs=(ENGLISH, marked), audio='')), 1)  # or marked default

    def test_a_forced_track_kodi_picked_stays(self):
        other = dict(ENGLISH_FORCED, index=4, language='ger')
        self.assertEqual(subtitles.choose(kodi(True, other, subs=(ENGLISH, other))), 4)

    def test_the_episode_befores_subtitles_carry_on(self):
        self.assertEqual(subtitles.choose(kodi(False), {'language': 'fre'}), 2)
        self.assertEqual(subtitles.choose(kodi(False, subs=(ENGLISH_FORCED, ENGLISH)), {'language': 'eng'}), 0)
        self.assertEqual(subtitles.choose(kodi(False, subs=(FRENCH,)), {'language': ''}), 2)  # no language: the first
        self.assertEqual(subtitles.choose(kodi(False), {'language': 'spa'}), 1)  # none in it: as a fresh start

    def test_what_is_carried_on(self):
        self.assertEqual(subtitles.shown(kodi(True, FRENCH)), {'language': 'fre'})
        self.assertIsNone(subtitles.shown(kodi(False, FRENCH)))
        self.assertIsNone(subtitles.shown(kodi(True, ENGLISH_FORCED)))  # forced ones show by themselves
        self.assertIsNone(subtitles.shown(None))

    def test_kodi_19_without_forced_marks(self):
        old = [dict((k, v) for k, v in s.items() if k != 'isforced') for s in (ENGLISH, FRENCH)]
        self.assertIsNone(subtitles.choose(kodi(True, old[0], subs=old)))

    def test_nothing_to_choose_from(self):
        self.assertIsNone(subtitles.choose(kodi(True, subs=())))
        self.assertIsNone(subtitles.choose({}))


class StartTests(unittest.TestCase):
    def setUp(self):
        del kodistubs.RPC[:]
        kodistubs.RPC_RESULTS.clear()

    def sets(self):
        return [params for method, params in kodistubs.RPC if method == 'Player.SetSubtitle']

    def test_switched_off(self):
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(True, ENGLISH, subs=(ENGLISH, FRENCH))
        self.assertIsNone(subtitles.start())
        self.assertEqual(self.sets(), [{'playerid': 1, 'subtitle': 'off'}])

    def test_already_off_is_left(self):
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(False, subs=(ENGLISH, FRENCH))
        subtitles.start()
        self.assertEqual(self.sets(), [])

    def test_the_forced_track_is_put_on(self):
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(True, ENGLISH)
        self.assertEqual(subtitles.start(), 1)
        self.assertEqual(self.sets(), [{'playerid': 1, 'subtitle': 1, 'enable': True}])

    def test_a_carried_track_already_showing_is_left(self):
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(True, FRENCH)
        self.assertEqual(subtitles.start({'language': 'fre'}), 2)
        self.assertEqual(self.sets(), [])

    def test_kodi_with_nothing_playing(self):
        kodistubs.RPC_RESULTS['Player.GetProperties'] = None
        self.assertIsNone(subtitles.start())
        self.assertEqual(self.sets(), [])


class ServiceTests(unittest.TestCase):
    """The service sets them as a Reelhouse item's picture starts, and looks each second at what's showing."""

    STREAM = 'http://rh:8484/api/stream/{}?X-Reelhouse-Token=t'

    def setUp(self):
        kodistubs.PROPERTIES.clear()
        del kodistubs.RPC[:]
        kodistubs.RPC_RESULTS.clear()
        owner = type('Owner', (), {'send': lambda _self, *args: None})()
        self.player = service.Player(owner, type('Controls', (), {'tick': lambda _self: None,
                                                                   'stop': lambda _self: None})())

    def starts(self, item_id, kodi_has, fresh=False):
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi_has
        kodistubs.PROPERTIES[utils.PLAYING_PROPERTY] = json.dumps({'id': item_id, 'playId': 'p', 'fresh': fresh})
        self.player.playing_file = self.STREAM.format(item_id)
        del kodistubs.RPC[:]
        self.player.onPlayBackStarted()
        self.player.onAVStarted()
        return [params.get('subtitle') for method, params in kodistubs.RPC if method == 'Player.SetSubtitle']

    def test_a_film_starts_with_subtitles_off(self):
        self.assertEqual(self.starts(1, kodi(True, ENGLISH, subs=(ENGLISH, FRENCH))), ['off'])

    def test_the_next_episode_keeps_the_subtitles_on(self):
        self.starts(1, kodi(False))
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(True, FRENCH)  # put on in Kodi's player
        self.player.tick()
        self.assertEqual(self.starts(2, kodi(False)), [2])

    def test_and_off(self):
        self.starts(1, kodi(False, subs=(ENGLISH, FRENCH)))
        self.player.tick()
        self.assertEqual(self.starts(2, kodi(True, ENGLISH, subs=(ENGLISH, FRENCH))), ['off'])

    def test_a_fresh_start_or_one_after_stop_does_not_carry_them(self):
        self.starts(1, kodi(False))
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(True, FRENCH)
        self.player.tick()
        self.assertEqual(self.starts(2, kodi(True, FRENCH), fresh=True), [1])  # off, but for the forced English
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(True, FRENCH)
        self.player.tick()
        self.player.onPlayBackStopped()
        self.assertEqual(self.starts(3, kodi(True, FRENCH)), [1])

    def test_not_after_a_while(self):
        self.starts(1, kodi(False))
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(True, FRENCH)
        self.player.tick()
        self.player.subtitles_seen = (self.player.subtitles_seen[0], time.time() - service.CARRY_SUBTITLES_WITHIN - 1)
        self.assertEqual(self.starts(2, kodi(True, FRENCH)), [1])

    def test_what_isnt_reelhouses_is_left_alone(self):
        kodistubs.RPC_RESULTS['Player.GetProperties'] = kodi(True, ENGLISH)
        self.player.playing_file = 'smb://nas/films/Other.mkv'
        del kodistubs.RPC[:]
        self.player.onAVStarted()
        self.assertEqual(kodistubs.RPC, [])


if __name__ == '__main__':
    unittest.main()
