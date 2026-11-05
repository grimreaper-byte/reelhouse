# What the Reelhouse screens show, made from Reelhouse's JSON: worded as the web app words it.
import os
import re
import time
import unittest
from datetime import datetime, timedelta

import helpers  # noqa: F401  (puts the add-on on sys.path)
import kodistubs

from resources.lib.ui import model


def film(**over):
    item = {'id': 17, 'type': 'movie', 'title': 'Green Street Hooligans', 'year': 2005, 'duration': 6513,
            'contentRating': 'R', 'rating': 7.3, 'videoResolution': '720p',
            'images': {'poster': '/api/images/17/poster?v=1', 'backdrop': '/api/images/17/backdrop?v=1'},
            'state': {'position': 1194, 'watched': False}}
    item.update(over)
    return item


def episode(**over):
    item = {'id': 10, 'type': 'episode', 'title': 'Pilot', 'seasonNumber': 1, 'episodeNumber': 3, 'duration': 2700,
            'show': {'id': 5, 'title': 'Some Show'}, 'images': {'poster': '/api/images/10/poster', 'thumb': '/api/images/10/thumb'},
            'state': {}}
    item.update(over)
    return item


class WordingTests(unittest.TestCase):
    def test_times_and_lengths(self):
        self.assertEqual(model.format_time(1194), '19:54')
        self.assertEqual(model.format_time(3723), '1:02:03')
        self.assertEqual(model.format_duration(6513), '1 hr 49 min')
        self.assertEqual(model.format_duration(7200), '2 hr')
        self.assertEqual(model.format_duration(2940), '49 min')
        self.assertEqual(model.format_duration(None), '')

    def test_episodes_and_sizes(self):
        self.assertEqual(model.episode_label({'seasonNumber': 1, 'episodeNumber': 3}), 'S1 · E3')
        self.assertEqual(model.episode_label({'seasonNumber': 2, 'episodeNumber': 3, 'episodeEnd': 4}), 'S2 · E3–4')
        self.assertEqual(model.episode_label({'seasonNumber': 0, 'episodeNumber': 1}), 'Special · E1')
        self.assertEqual(model.format_bytes(715849728), '682.7 MB')
        self.assertEqual(model.format_bitrate(879000), '879 kbps')
        self.assertEqual(model.format_bitrate(9000000), '9.0 Mbps')

    def test_time_ago(self):
        now = 1_000_000
        self.assertEqual(model.time_ago((now - 30) * 1000, now), 'just now')
        self.assertEqual(model.time_ago((now - 600) * 1000, now), '10 min ago')
        self.assertEqual(model.time_ago((now - 86400) * 1000, now), 'yesterday')
        self.assertEqual(model.time_ago((now - 3 * 86400) * 1000, now), '3 days ago')

    def test_resume_point_skips_the_last_half_minute(self):
        self.assertEqual(model.resume_point(film()), 1194)
        self.assertEqual(model.resume_point(film(state={'position': 6500})), 0)
        self.assertEqual(model.resume_point(film(state={})), 0)


class CardTests(unittest.TestCase):
    def test_a_film(self):
        c = model.card(film())
        self.assertEqual((c['label'], c['label2']), ('Green Street Hooligans', '2005'))
        self.assertEqual(c['art'], {'poster': ('/api/images/17/poster?v=1', model.POSTER_W)})
        self.assertEqual((c['position'], c['duration'], c['watched']), (1194, 6513, False))

    def test_an_episode_under_its_show(self):
        c = model.card(episode())
        self.assertEqual((c['label'], c['label2']), ('Some Show', 'S1 · E3 · Pilot'))
        wide = model.card(episode(), 'landscape')
        self.assertEqual(wide['art'], {'thumb': ('/api/images/10/thumb', model.STILL_W)})
        self.assertTrue(wide['play'])

    def test_a_season_with_new_episodes_and_its_unwatched_count(self):
        season = {'id': 3, 'type': 'season', 'title': 'Season 1', 'show': {'title': 'Some Show'}, 'newCount': 2,
                  'leafCount': 6, 'viewedLeafCount': 1, 'images': {'poster': '/p'}}
        c = model.card(season)
        self.assertEqual((c['label'], c['label2'], c['badge']), ('Some Show', 'Season 1 · 2 new', '5'))
        done = model.card(dict(season, viewedLeafCount=6))
        self.assertEqual((done['badge'], done['watched']), ('', True))

    def test_home_rows(self):
        now = time.time()
        cards = model.hub_cards({'id': 'continue', 'items': [film()]})
        self.assertTrue(cards[0]['play'])
        others = model.hub_cards({'id': 'others', 'items': [film(watchedBy=['sam', 'jo', 'al'], watchedAt=(now - 120) * 1000)]}, now)
        self.assertEqual(others[0]['label2'], 'sam and 2 others · 2 min ago')
        self.assertFalse(others[0]['play'])


class PageTests(unittest.TestCase):
    def test_the_line_under_the_title(self):
        self.assertEqual(model.meta_line({'item': film()}), '2005 · 1 hr 49 min · R · ★ 7.3')
        self.assertEqual(model.meta_line({'item': {'type': 'show', 'year': 2024, 'childCount': 2}}), '2024 · 2 seasons')
        self.assertEqual(model.meta_line({'item': {'type': 'season', 'leafCount': 1}}), '1 episode')
        self.assertEqual(model.meta_line({'item': episode(airDate='2024-12-30')}), 'S1 · E3 · 2024-12-30 · 45 min')

    def test_one_quality_badge_per_copy(self):
        versions = [{'id': 17, 'label': '720p'}, {'id': 46, 'label': 'SD'}]
        self.assertEqual(model.quality_labels(film(versions=versions)), ['720p', 'SD'])
        self.assertEqual(model.quality_labels(film(versions=[{'label': '720p'}, {'label': '720p'}])), ['720p'])
        self.assertEqual(model.quality_labels(film()), ['720p'])

    def test_the_play_button(self):
        self.assertEqual(model.play_action({'item': film()}), ('Resume from 19:54', 17, 1194, 'From the start'))
        self.assertEqual(model.play_action({'item': film(state={})}), ('Play', 17, 0, None))
        show = {'item': {'id': 5, 'type': 'show'}, 'onDeck': episode(state={'position': 600})}
        self.assertEqual(model.play_action(show), ('Resume S1 · E3', 10, 600, None))
        self.assertIsNone(model.play_action({'item': {'id': 5, 'type': 'show'}}))

    def test_a_copy_and_a_files_details(self):
        v = {'width': 1280, 'height': 544, 'videoCodec': 'h264', 'audioCodec': 'aac', 'container': 'mp4',
             'fileSize': 715849728, 'bitrate': 879000}
        self.assertEqual(model.version_details(v), '1280×544 · H.264 · AAC · MP4 · 682.7 MB · 879 kbps')
        text = model.media_info_text({'container': 'mp4', 'duration': 6513, 'video': {'codec': 'h264', 'width': 1280, 'height': 544},
                                      'audio': [{'codec': 'aac', 'channels': 2, 'language': 'eng', 'isDefault': True}]}, '720p')
        self.assertIn('[B]720p[/B]', text)
        self.assertIn('Track 1: English · AAC · Stereo · (default)', text)

    def test_a_persons_lines(self):
        self.assertEqual(model.person_facts({'birthday': '1981-01-28', 'age': 45, 'birthplace': 'Cedar Rapids, Iowa, USA'}),
                         ['Born 28 Jan 1981 (age 45)', 'in Cedar Rapids, Iowa, USA'])
        self.assertEqual(model.here_line([{'type': 'movie'}, {'type': 'movie'}, {'type': 'show'}]), '2 movies and 1 show on this server')
        self.assertEqual(model.part({'role': 'Matt Buckner'}), 'as Matt Buckner')
        self.assertEqual(model.part({'directed': True}), 'Director')


class SidebarTests(unittest.TestCase):
    def test_a_librarys_icon_is_its_own_or_its_types(self):
        self.assertEqual(model.library_icon({'type': 'show', 'icon': 'tvRecord'}), 'tvRecord')
        self.assertEqual(model.library_icon({'type': 'movie', 'icon': 'trophy'}), 'trophy')
        self.assertEqual(model.library_icon({'type': 'movie'}), 'film')  # a server from before icons
        self.assertEqual(model.library_icon({'type': 'show', 'icon': 'rocket'}), 'tv')  # one this add-on doesn't know

    def test_every_icon_the_server_offers_is_drawn(self):
        root = os.path.join(helpers.HERE, '..', '..')
        server = open(os.path.join(root, 'server', 'libraries.js'), encoding='utf-8').read()
        offered = re.findall(r"'(\w+)'", re.search(r'LIBRARY_ICONS = \[([^\]]*)\]', server).group(1))
        self.assertEqual(tuple(offered), model.LIBRARY_ICONS)
        icons = os.path.join(root, 'kodi', 'plugin.video.reelhouse', 'resources', 'skins', 'Default', 'media', 'reelhouse', 'icons')
        for name in model.LIBRARY_ICONS + tuple(n + '-spot' for n in model.ICON_SPOTS):
            self.assertTrue(os.path.isfile(os.path.join(icons, name + '.png')), name)

    def test_live_tv_settings_and_exit_kept_at_the_bottom(self):
        kodistubs.install()
        from resources.lib.ui.app import App
        app = App.__new__(App)  # without signing in
        app.me = {'liveTv': {'available': True}}
        app.libraries = [{'id': 1, 'name': 'Films', 'type': 'movie', 'count': 3}]
        top, bottom = app.nav_items()
        self.assertEqual([key for key, _, _, _ in top], ['home', 'library:1', 'search'])
        self.assertEqual([key for key, _, _, _ in bottom], ['livetv', 'radio', 'settings', 'exit'])
        self.assertEqual(bottom[-1][1:3], ('Exit', 'signOut'))
        self.assertEqual(App.target_for('exit'), ('exit',))
        app.me = {'liveTv': {'available': True, 'radio': False}}
        self.assertEqual([key for key, _, _, _ in app.nav_items()[1]], ['livetv', 'settings', 'exit'])
        # Accounts that may record have their recordings under Radio.
        app.me = {'liveTv': {'available': True, 'canRecord': True}}
        _, bottom = app.nav_items()
        self.assertEqual([key for key, _, _, _ in bottom], ['livetv', 'radio', 'recordings', 'settings', 'exit'])
        self.assertEqual(bottom[2][1:3], ('Manage Recordings', 'record'))
        self.assertEqual(App.target_for('recordings'), ('recordings',))
        app.me = {}  # no Live TV for this account
        self.assertEqual([key for key, _, _, _ in app.nav_items()[1]], ['settings', 'exit'])

    def test_fullscreen_is_first_while_something_plays(self):
        kodistubs.install()
        import xbmc
        from resources.lib.ui.app import App, HAS_MEDIA
        app = App.__new__(App)
        app.me = {}
        app.libraries = [{'id': 1, 'name': 'Films', 'type': 'movie', 'count': 3}]
        self.assertEqual([key for key, _, _, _ in app.nav_items()[0]], ['home', 'library:1', 'search'])
        top, bottom = app.nav_items(playing=True)
        self.assertEqual([key for key, _, _, _ in top], ['fullscreen', 'home', 'library:1', 'search'])
        self.assertEqual(top[0][1:3], ('Now playing', 'fullscreen'))
        self.assertEqual(bottom[-1][0], 'exit')  # Back on Home still ends on Exit
        icons = os.path.join(os.path.dirname(model.__file__), '..', '..', 'skins', 'Default', 'media', 'reelhouse', 'icons')
        self.assertTrue(os.path.isfile(os.path.join(icons, 'fullscreen.png')))
        saved = xbmc.getCondVisibility
        asked = []
        xbmc.getCondVisibility = lambda condition: asked.append(condition) or True
        try:
            self.assertIs(App.playing(), True)
        finally:
            xbmc.getCondVisibility = saved
        self.assertEqual(asked, [HAS_MEDIA])
        self.assertEqual(HAS_MEDIA, 'Player.HasMedia')

    def test_the_sidebars_highlight_when_it_is_filled(self):
        keys = ['fullscreen', 'home', 'library:1', 'search']
        self.assertEqual(model.nav_position(keys, None, 'library:1'), 2)    # this screen's own entry
        self.assertEqual(model.nav_position(keys, 'search', 'library:1'), 3)  # moving along it: stays where it was
        self.assertEqual(model.nav_position(keys, None, None), 0)           # a film's page: the first, Now playing
        # The film ended with the focus on Now playing: back on this screen's own entry, not a neighbour.
        self.assertEqual(model.nav_position(['home', 'library:1', 'search'], 'fullscreen', 'library:1'), 1)
        self.assertEqual(model.nav_position(['home', 'search'], 'fullscreen', None), 0)

    def test_opening_reelhouse_twice_at_once_opens_it_once(self):
        """The second time, while the first is still asking Reelhouse: no window to go to yet (a number here would be
        taken for one of Kodi's: 1 is its Programs)."""
        kodistubs.install()
        import xbmc
        from resources.lib.ui import app
        ran, shown = [], []

        class Slow(object):
            def load_account(self):
                app.run()  # pressed again meanwhile

            def show(self, target):
                shown.append(target)
        saved = xbmc.executebuiltin, app.App, app.utils.signed_in
        xbmc.executebuiltin, app.App, app.utils.signed_in = ran.append, Slow, lambda: True
        try:
            app.run()
        finally:
            xbmc.executebuiltin, app.App, app.utils.signed_in = saved
        self.assertEqual((ran, shown), ([], [('home',)]))

    def test_open_reelhouse_brings_back_screens_kodi_hid(self):
        kodistubs.install()
        import xbmc
        import xbmcgui
        from resources.lib.ui import app
        ran, current = [], [10000]
        saved = xbmc.executebuiltin, getattr(xbmcgui, 'getCurrentWindowId', None), kodistubs.ABORT.is_set()
        xbmc.executebuiltin, xbmcgui.getCurrentWindowId = ran.append, lambda: current[0]
        kodistubs.ABORT.clear()  # Kodi running (the service tests leave it stopping)
        try:
            app.App.showing(13002)  # a screen came up; then Kodi's home screen took over
            app.run()
            self.assertEqual(ran, ['ActivateWindow(13002)'])
            current[0] = 13002  # already showing: nothing to do
            app.run()
            self.assertEqual(len(ran), 1)
            # The top screen closed and Kodi went to its own window: Home under it comes back, and Open Reelhouse
            # would bring Home back too.
            screens = app.App.__new__(app.App)
            screens.screens = [13000, 13002]
            current[0] = 10025
            screens.closed(13002)
            self.assertEqual(ran[-1], 'ActivateWindow(13000)')
            app.run()
            self.assertEqual(ran[-2:], ['ActivateWindow(13000)'] * 2)
            # Closed with the one under it showing, as usual: nothing to do.
            screens.screens = [13000, 13002]
            current[0] = 13000
            screens.closed(13002)
            self.assertEqual(len(ran), 3)
        finally:
            kodistubs.PROPERTIES.pop(app.RUNNING_PROPERTY, None)
            xbmc.executebuiltin, xbmcgui.getCurrentWindowId = saved[:2]
            if saved[2]:
                kodistubs.ABORT.set()

    def test_back_never_leaves_home(self):
        # Home: the page → the sidebar → its Exit entry, and there it stays (Exit itself leaves).
        self.assertEqual(model.back_step(True, False, 310, False), 'sidebar')
        self.assertEqual(model.back_step(True, True, 310, False), 'exit')
        self.assertEqual(model.back_step(True, True, None, False), 'exit')
        self.assertEqual(model.back_step(True, True, 310, True), 'stay')
        # A screen over another: back into its page from the sidebar, otherwise closed (Home shows again).
        self.assertEqual(model.back_step(False, True, 310, False), 'page')
        self.assertEqual(model.back_step(False, True, None, False), 'close')
        self.assertEqual(model.back_step(False, False, 310, False), 'close')


class GuideWordingTests(unittest.TestCase):
    def test_genre_colours_as_in_kodi(self):
        self.assertEqual(model.genre_group({'genre': [0x14]}), 1)
        self.assertIsNone(model.genre_group({'genre': [0xF0]}))
        now = 1000
        comedy = {'start': 900, 'stop': 1900, 'genre': [0x14]}
        self.assertEqual(model.programme_colour(comedy, now), 'FF{:02X}{:02X}{:02X}'.format(*model.mix((219, 120, 23), model.ELEV3, 0.3)))
        self.assertEqual(model.programme_colour({'start': 0, 'stop': 500}, now)[:2], '99')  # past: fainter

    def test_the_highlighted_programmes_lines(self):
        now = time.time()
        start = int(now) - 600
        e = {'start': start, 'stop': start + 1800, 'title': 'Quiz Night', 'season': 1, 'episode': 4, 'subtitle': 'Part 4',
             'genre': [0x30], 'genreName': 'Game show', 'dvr': {'state': 'scheduled'}}
        s = model.programme_summary(e, {'name': 'Test Two'}, now)
        self.assertEqual(s['meta'], 'Test Two · S1 E4 · Part 4 · 20 min left')
        self.assertEqual((s['group'], s['rec'], s['description']), (3, 'Will be recorded', 'No description.'))
        later = dict(e, start=start + 7200, stop=start + 9000, dvr=None)
        self.assertTrue(model.programme_summary(later, None, now)['meta'].endswith('30 min'))

    def test_days(self):
        today = datetime.now().replace(hour=12, minute=0, second=0, microsecond=0)
        t = lambda d: time.mktime(d.timetuple())
        self.assertEqual(model.day_label(t(today), t(today)), 'Today')
        self.assertEqual(model.day_label(t(today + timedelta(days=1)), t(today)), 'Tomorrow')
        self.assertTrue(model.day_label(t(today + timedelta(days=3)), t(today)).startswith((today + timedelta(days=3)).strftime('%A')))


class RecordingsTests(unittest.TestCase):
    def setUp(self):
        self.now = time.mktime(datetime.now().replace(hour=12, minute=0, second=0, microsecond=0).timetuple())
        start = int(self.now) + 6 * 3600
        self.rec = {'uuid': 'u1', 'state': 'scheduled', 'title': 'News', 'subtitle': 'Part 5', 'description': 'The news.',
                    'channel': {'uuid': 'c1', 'name': 'Test One', 'number': 1, 'icon': '/api/livetv/channels/c1/icon?v=1'},
                    'start': start, 'stop': start + 1800, 'size': None, 'status': 'Scheduled for recording',
                    'owner': {'id': 2, 'username': 'kid'}, 'mine': True, 'canChange': True}

    def test_each_state_offers_its_action_and_someone_elses_none(self):
        self.assertEqual(model.recording_action(self.rec)[:2], ('cancel', 'Cancel recording'))
        self.assertEqual(model.recording_action(dict(self.rec, state='recording'))[0], 'stop')
        self.assertEqual(model.recording_action(dict(self.rec, state='recorded'))[0], 'delete')
        self.assertEqual(model.recording_action(dict(self.rec, state='failed'))[0], 'delete')
        self.assertIsNone(model.recording_action(dict(self.rec, canChange=False)))

    def test_a_cover_says_who_set_whats_in_it(self):
        kid = {'id': 2, 'username': 'kid', 'avatar': '/api/avatars/2'}
        sam = {'id': 3, 'username': 'sam'}
        rec = lambda state, owner: {'state': state, 'owner': owner}
        show = {'seasons': [{'recordings': [rec('recorded', sam), rec('failed', kid), rec('recorded', sam)]},
                            {'recordings': [rec('scheduled', kid), rec('scheduled', None), rec('recording', None)]}]}
        self.assertEqual(len(model.section_recordings(show, 'recorded')), 3)
        self.assertEqual(model.owner_line(model.section_recordings(show, 'recorded')), {'names': 'sam, kid', 'letter': 'S', 'avatar': ''})
        self.assertEqual(model.owner_line(model.section_recordings(show, 'scheduled')), {'names': 'kid', 'letter': 'K', 'avatar': '/api/avatars/2'})
        self.assertEqual(model.owner_line(model.section_recordings(show, 'now')), {'names': 'Not set through Reelhouse', 'letter': '', 'avatar': ''})

    def test_a_recording_under_way_with_a_problem_says_so(self):
        rec = dict(self.rec, state='recording', status='Waiting for stream', problem=True, start=self.now, stop=self.now + 60)
        row = model.recording_row(rec, self.now)
        self.assertEqual((row['trouble'], row['statelabel']), (True, 'Recording now · Waiting for stream'))
        self.assertEqual(model.episode_card(rec, self.now)['tag'], 'Waiting for stream')
        fine = dict(rec, status='Running', problem=False)
        self.assertFalse(model.recording_row(fine, self.now)['trouble'])
        self.assertEqual(model.episode_card(fine, self.now)['tag'], 'REC')

    def test_a_failed_recording_in_the_guide(self):
        self.assertEqual(model.recording_label({'state': 'failed'}), 'Recording failed')
        self.assertFalse(model.recording_marked({'state': 'failed'}))

    def test_a_series_recordings_episodes_are_skipped_rather_than_cancelled(self):
        made = dict(self.rec, series='rule')
        self.assertEqual(model.recording_action(made)[:2], ('cancel', 'Skip this episode'))
        self.assertEqual(model.recording_action(dict(made, state='recording'))[0], 'stop')
        self.assertEqual(model.recording_action(dict(made, state='recorded'))[0], 'delete')
        self.assertIsNone(model.recording_action(dict(made, canChange=False)))
        self.assertEqual(model.recording_label({'state': 'scheduled'}), 'Will be recorded')
        self.assertEqual(model.recording_label({'state': 'scheduled', 'series': 'rule'}), 'Series recording')
        self.assertEqual(model.recording_label({'state': 'skipped', 'series': 'rule'}), 'Skipped')
        self.assertTrue(model.recording_marked({'state': 'scheduled'}))
        self.assertFalse(model.recording_marked({'state': 'skipped'}))
        self.assertFalse(model.recording_marked(None))

    def test_what_the_guide_offers_about_a_series_recording(self):
        self.assertEqual(model.series_action(None, False, True), 'record')
        self.assertIsNone(model.series_action(None, False, False))
        self.assertIsNone(model.series_action(None, True, True))
        # A single recording of theirs can still become a series recording; someone else's holds the programme.
        self.assertEqual(model.series_action({'state': 'scheduled', 'canChange': True}, False, True), 'record')
        self.assertIsNone(model.series_action({'state': 'scheduled', 'canChange': False}, False, True))
        # Theirs to cancel even if they may no longer set new ones.
        self.assertEqual(model.series_action({'state': 'scheduled', 'canChange': True, 'series': 'rule'}, False, False), 'cancel')
        self.assertEqual(model.series_action({'state': 'skipped', 'canChange': True, 'series': 'rule'}, False, True), 'cancel')
        self.assertIsNone(model.series_action({'state': 'scheduled', 'canChange': False, 'series': 'rule'}, False, True))
        self.assertIsNone(model.series_action({'state': 'scheduled', 'canChange': True, 'series': 'rule'}, True, True))

    def test_a_series_recordings_cover_and_what_cancelling_it_says(self):
        now = time.mktime((2026, 11, 1, 12, 0, 0, 0, 0, -1))
        at_nine = time.mktime((2026, 11, 1, 21, 0, 0, 0, 0, -1))
        s = {'uuid': 'r', 'key': 'news', 'title': 'News', 'channel': {'name': 'One'}, 'counts': {}, 'next': None}
        self.assertEqual(model.series_recording_card(s, now), {'label': 'News', 'label2': 'Nothing scheduled yet', 'channel': 'One', 'recording': False})
        self.assertEqual(model.series_recording_card(dict(s, next=at_nine), now)['label2'], 'Today, {}'.format(model.time_of(at_nine)))
        self.assertEqual(model.series_recording_next(dict(s, next=at_nine), now), 'Next: Today, {}'.format(model.time_of(at_nine)))
        busy = model.series_recording_card(dict(s, next=at_nine, counts={'recording': 1}), now)
        self.assertEqual((busy['label2'], busy['recording']), ('Recording now', True))
        self.assertEqual(model.owner_line([s])['names'], 'Not set through Reelhouse')
        self.assertEqual(model.set_by(dict(s, owner={'id': 2, 'username': 'kid'}))['names'], 'Set by kid')
        self.assertEqual(model.show_name('New: Mock The Week'), 'Mock The Week')
        self.assertEqual(model.show_name('new:Mock The Week'), 'Mock The Week')
        self.assertEqual(model.show_name('New Tricks'), 'New Tricks')
        self.assertTrue(model.cancel_series_text('News').endswith('already recorded stays.'))
        self.assertTrue(model.cancel_series_text('News', True, 'kid').endswith('kid set it.'))
        self.assertTrue(model.cancel_series_text('News', True).endswith('It wasn’t set through Reelhouse.'))

    def test_the_sections_and_a_shows_cover_in_each(self):
        t = self.rec['start']
        show = {'key': 'news', 'title': 'News', 'counts': {'recording': 1, 'scheduled': 2, 'recorded': 5, 'failed': 0},
                'recordingNow': True, 'latest': t, 'nextScheduled': t + 3600, 'seasons': []}
        quiet = {'key': 'quiz', 'title': 'Quiz', 'counts': {'recording': 0, 'scheduled': 1, 'recorded': 0, 'failed': 1},
                 'recordingNow': False, 'latest': t - 100, 'nextScheduled': t + 600, 'seasons': []}
        old = {'key': 'old', 'title': 'Old', 'counts': {'recording': 0, 'scheduled': 0, 'recorded': 2, 'failed': 0},
               'recordingNow': False, 'latest': t - 50, 'nextScheduled': None, 'seasons': []}
        sections = model.show_sections([show, quiet, old])
        self.assertEqual([(section, [s['key'] for s in shows]) for section, shows in sections],
                         [('now', ['news']), ('recorded', ['news', 'old', 'quiz']), ('scheduled', ['quiz', 'news'])])
        self.assertEqual(model.show_card(show, 'now', self.now), {'label': 'News', 'label2': 'Recording now', 'badge': '', 'recording': True})
        self.assertEqual(model.show_card(show, 'recorded', self.now), {'label': 'News', 'label2': '5 recorded', 'badge': '5', 'recording': False})
        self.assertEqual(model.show_card(show, 'scheduled', self.now)['label2'], 'Today, 19:00')
        self.assertEqual(model.show_card(quiet, 'scheduled', self.now)['label2'], 'Today, 18:10')
        self.assertEqual(model.show_card(quiet, 'recorded', self.now)['label2'], '1 failed')
        self.assertEqual(model.recordings_summary([show, quiet]), '2 shows · 1 recording now · 3 scheduled · 5 recorded · 1 failed')
        self.assertEqual(model.recordings_summary([]), '')
        self.assertEqual([model.section_height(n) for n in (1, 8, 9, 40)], [476, 476, 896, 896])

    def test_deleting_a_series_or_the_show_takes_its_recorded_episodes(self):
        recs = [dict(self.rec, uuid='a', state='recorded', season=1), dict(self.rec, uuid='b', state='failed', season=1, mine=False),
                dict(self.rec, uuid='c', state='recorded', season=2, canChange=False), dict(self.rec, uuid='d', season=2),
                dict(self.rec, uuid='e', state='recording')]
        show = {'title': 'News', 'seasons': [{'season': 1, 'recordings': recs[:2]}, {'season': 2, 'recordings': recs[2:4]},
                                             {'season': None, 'recordings': recs[4:]}]}
        self.assertEqual([r['uuid'] for r in model.show_recordings(show)], ['a', 'b', 'c', 'd', 'e'])
        self.assertEqual([r['uuid'] for r in model.deletable(recs)], ['a', 'b'])
        self.assertEqual([s for s, _ in model.series_to_delete(show)], [1])  # series 2 has nothing this account may delete
        self.assertEqual(model.delete_many_text(recs), 'All 2 of its recordings will be deleted from Tvheadend’s recordings drive. '
                         'This can’t be undone. 1 of them was set by someone else. The 2 still to come keep recording.')
        self.assertEqual(model.delete_many_text(recs[:1]), 'Its recording will be deleted from Tvheadend’s recordings drive. '
                         'This can’t be undone.')

    def test_a_recordings_lines(self):
        r = model.recording_row(self.rec, self.now)
        self.assertEqual(r['meta'], 'Test One'.join(['1 · ', ' · Today, 18:00–18:30 · 30 min']))
        # On its show's page it's known by its episode, else its subtitle, else its title.
        self.assertEqual((r['title'], r['subtitle'], r['statelabel'], r['initials']), ('Part 5', '', 'Scheduled', 'Te'))
        self.assertEqual(model.recording_row(dict(self.rec, season=1, episode=4), self.now)['title'], 'S1 E4')
        self.assertEqual(model.recording_row(dict(self.rec, season=1, episode=4), self.now)['subtitle'], 'Part 5')
        self.assertEqual(model.recording_row(dict(self.rec, subtitle=None), self.now)['title'], 'News')
        self.assertEqual([model.recording_episode({'episode': 3}), model.recording_episode({'season': 2}), model.recording_episode({})],
                         ['Episode 3', 'Series 2', None])
        now = model.recording_row(dict(self.rec, state='recording', size=350 * 1024 * 1024), self.now)
        self.assertTrue(now['meta'].endswith('30 min · 350.0 MB so far'))
        done = model.recording_row(dict(self.rec, state='recorded', size=2 * 1024 ** 3, status='Completed OK', channel=None), self.now)
        self.assertEqual((done['meta'], done['statelabel'], done['trouble']), ('Today, 18:00–18:30 · 30 min · 2.00 GB', 'Recorded', False))
        # Tvheadend's word when it didn't go to plan.
        missing = model.recording_row(dict(self.rec, state='recorded', status='File missing'), self.now)
        self.assertEqual((missing['statelabel'], missing['trouble']), ('Recorded · File missing', True))
        self.assertEqual(model.recording_row(dict(self.rec, state='failed', status='Time missed'), self.now)['statelabel'], 'Failed · Time missed')

    def test_a_shows_series_and_a_series_episodes_as_covers(self):
        one = {'season': 1, 'counts': {'recording': 1, 'scheduled': 0, 'recorded': 3, 'failed': 0}, 'recordings': []}
        loose = {'season': None, 'counts': {'recording': 0, 'scheduled': 2, 'recorded': 0, 'failed': 0}, 'recordings': []}
        show = {'title': 'News', 'seasons': [one, loose]}
        self.assertTrue(model.has_series(show))
        self.assertFalse(model.has_series({'seasons': [loose]}))
        self.assertEqual(model.series_card(one, show), {'label': 'Series 1', 'label2': '1 recording now · 3 recorded', 'badge': '3',
                                                        'recording': True})
        self.assertEqual(model.series_card(loose, show)['label'], 'Other recordings')
        self.assertEqual(model.series_name(loose, {'seasons': [loose]}), 'Recordings')
        self.assertEqual(model.series_what(one, show), 'series 1 of “News”')
        self.assertEqual(model.series_what(loose, show), 'the other recordings of “News”')
        card = model.episode_card(dict(self.rec, episode=4, size=350 * 1024 * 1024), self.now)
        self.assertEqual((card['label'], card['label2'], card['tag']), ('Episode 4 · Part 5', 'Today, 18:00 · 30 min · 350.0 MB', 'Scheduled'))
        self.assertEqual(model.episode_card(dict(self.rec, state='recording'), self.now)['tag'], 'REC')
        missed = model.episode_card(dict(self.rec, state='failed', status='Time missed'), self.now)
        self.assertEqual((missed['tag'], missed['trouble']), ('Failed · Time missed', True))
        self.assertEqual(model.episode_card(dict(self.rec, state='recorded', status='Completed OK'), self.now)['tag'], '')
        self.assertNotIn('owner', model.episode_card(self.rec, self.now))

    def test_the_recordings_drive_across_from_the_title(self):
        gb = 1024 ** 3
        drive = {'free': 400 * gb, 'total': 2048 * gb, 'recordings': 12 * gb}
        self.assertEqual(model.drive_line(drive), {'label': 'Recordings drive · 400.00 GB free of 2.00 TB', 'hint': 'Recordings take up 12.00 GB',
                                                   'low': False, 'used': 80.46875})
        low = model.drive_line(dict(drive, free=100 * gb, recordings=0))
        self.assertEqual((low['label'], low['hint'], low['low']), ('Recordings drive · 100.00 GB free of 2.00 TB · Low on space', 'No recordings yet', True))
        self.assertEqual(model.drive_line(dict(drive, free=0, recordings=None))['label'], 'Recordings drive · 0 B free of 2.00 TB · Low on space')
        self.assertEqual(model.drive_line(dict(drive, recordings=None))['hint'], '')
        self.assertEqual(model.drive_line(None), {'label': '', 'hint': '', 'low': False, 'used': 0})

    def test_who_set_it_in_its_details(self):
        self.assertEqual(model.set_by(self.rec), {'names': 'Set by kid', 'letter': 'K', 'avatar': ''})  # your own too: the name, not "you"
        self.assertEqual(model.set_by(dict(self.rec, owner={'id': 3, 'username': 'sam', 'avatar': '/a/3'})),
                         {'names': 'Set by sam', 'letter': 'S', 'avatar': '/a/3'})
        self.assertEqual(model.set_by(dict(self.rec, mine=False, owner=None)), {'names': 'Not set through Reelhouse', 'letter': '', 'avatar': ''})


if __name__ == '__main__':
    unittest.main()
