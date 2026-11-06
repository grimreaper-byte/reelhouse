# What a Reelhouse screen does when Reelhouse goes away and comes back (a server being recreated while Kodi is open), and
# where the focus goes: tried with Kodi's window stubbed (kodistubs.py), as the logic is the screens' own.
import threading
import unittest

import helpers  # noqa: F401  (puts the add-on on sys.path)
import kodistubs

kodistubs.install()

from resources.lib.api import ApiError  # noqa: E402
from resources.lib.ui.windows import base, home, livetv, recordings, search  # noqa: E402


class FakeApi(object):
    def __init__(self):
        self.down = False
        self.asked = 0

    def get(self, path, **kwargs):
        self.asked += 1
        if self.down:
            raise ApiError('Reelhouse is not reachable')
        return {'ok': True}


class FakeApp(object):
    def __init__(self):
        self.api = FakeApi()
        self.pending = None


def screen(cls=base.Screen, **attrs):
    window = cls.__new__(cls)
    base.Screen.__init__(window)
    window.app = FakeApp()
    window.content_focus = None
    window.last_focus = None
    for key, value in attrs.items():
        setattr(window, key, value)
    return window


def in_background(window, work):
    """Runs `work` as the screen's once-a-second thread does (Screen.follow_changes)."""
    result = []

    def run():
        window.refresher = threading.current_thread()
        result.append(work())
    thread = threading.Thread(target=run)
    thread.start()
    thread.join()
    return result[0]


class FetchTests(unittest.TestCase):
    def test_a_page_asked_for_says_when_it_cant_be_had_with_try_again_focused(self):
        w = screen()
        w.app.api.down = True
        self.assertIsNone(w.fetch('/x'))
        self.assertEqual(w.getProperty('message.retry'), 'true')
        self.assertEqual(w.getFocusId(), base.RETRY)

    def test_try_again_gets_the_focus_though_it_only_shows_a_moment_later(self):
        w = screen()
        w.hidden.add(base.RETRY)
        slept = []

        def next_frame(ms):
            slept.append(ms)
            w.hidden.discard(base.RETRY)
        saved, base.xbmc.sleep = base.xbmc.sleep, next_frame
        try:
            w.app.api.down = True
            w.fetch('/x')
        finally:
            base.xbmc.sleep = saved
        self.assertTrue(slept)
        self.assertEqual(w.getFocusId(), base.RETRY)

    def test_a_refresh_that_fails_leaves_the_page_and_the_focus_alone(self):
        w = screen()
        self.assertEqual(w.fetch('/x'), {'ok': True})
        w.setFocusId(603)
        w.app.api.down = True
        self.assertIsNone(in_background(w, lambda: w.fetch('/x')))
        self.assertEqual(w.getProperty('message.title'), '')
        self.assertEqual(w.getFocusId(), 603)
        # And it's all as it was when Reelhouse is back.
        w.app.api.down = False
        self.assertEqual(in_background(w, lambda: w.fetch('/x')), {'ok': True})
        self.assertEqual(w.getFocusId(), 603)

    def test_a_refresh_of_a_screen_that_never_loaded_still_says_why(self):
        w = screen()
        w.app.api.down = True
        in_background(w, lambda: w.fetch('/x'))
        self.assertEqual(w.getProperty('message.retry'), 'true')

    def test_something_the_person_asked_for_says_when_it_fails_even_with_a_page_up(self):
        w = screen()
        w.fetch('/x')
        w.refresher = None  # the thread is elsewhere; this is the person pressing a button
        w.app.api.down = True
        self.assertIsNone(w.fetch('/x'))
        self.assertEqual(w.getProperty('message.retry'), 'true')

    def test_try_again_working_puts_the_focus_back_on_the_page(self):
        w = screen()
        w.fetch('/x')
        w.onFocus(603)
        w.app.api.down = True
        w.fetch('/x')
        self.assertEqual(w.getFocusId(), base.RETRY)
        w.onFocus(base.RETRY)
        w.hidden.add(base.RETRY)  # the message goes
        w.clear_message()
        self.assertEqual(w.getFocusId(), 603, 'not left on a button that has gone')


class GuideTests(unittest.TestCase):
    def test_the_minutes_refresh_failing_leaves_the_guide_up_and_waits_another_minute(self):
        w = screen(livetv.LiveTv, guide=object(), last_read=0, radio=False)
        w.setFocusId(3025)
        w.app.api.down = True
        w.read(0, keep=True)
        self.assertEqual(w.getProperty('message.title'), '')
        self.assertEqual(w.getFocusId(), 3025)
        self.assertGreater(w.last_read, 0, 'or it would ask again every second')

    def test_the_guide_that_cant_be_had_at_all_says_so(self):
        w = screen(livetv.LiveTv, guide=None, last_read=0, radio=False)
        w.app.api.down = True
        w.read(0)
        self.assertEqual(w.getProperty('message.title'), "The guide couldn't be loaded")


class FocusTests(unittest.TestCase):
    def test_back_from_a_show_opened_from_series_recordings_stays_there(self):
        w = screen(recordings.Recordings, shows=[{'key': 'a', 'recordingNow': False, 'counts': {'recorded': 1}, 'latest': 1}], series=[], everyone=False)
        w.setFocusId(recordings.SERIES)
        moved = []
        w.open_child = lambda target: None
        w.load = lambda: None
        w.focus_soon = moved.append
        w.getControl = lambda control_id: type('Control', (), {'size': lambda self: 1})()
        w.open_show({'key': 'a', 'title': 'A', 'seasons': []})
        self.assertEqual(moved, [])

    def test_a_search_read_again_leaves_the_focus_where_it_is(self):
        w = screen(search.Search, query='news', loaded=True)
        found = {'movies': [], 'shows': [], 'episodes': [], 'people': [{'id': 1}]}
        w.fetch = lambda path: found
        w.items = lambda cards: []
        w.fill_list = lambda control_id, items: None
        w.setFocusId(search.BOX)
        w.refresh()
        self.assertEqual(w.getFocusId(), search.BOX, 'a library changing moved it')
        w.find()
        self.assertEqual(w.getFocusId(), search.PEOPLE, 'a search just made goes to what it found')


def lists(window, sizes):
    """Gives a screen Kodi's lists, by id and how many each holds (with the sidebar's); other ids are controls that show."""
    class List(object):
        def __init__(self, n):
            self.n = n

        def size(self):
            return self.n

        def getSelectedPosition(self):
            return 0

    def get(control_id):
        if control_id in sizes:
            return List(sizes[control_id])
        if control_id in base.SIDEBARS:
            return List(5)
        return object()
    window.getControl = get
    return window


def key(action_id):
    return type('Action', (), {'getId': lambda self: action_id})()


class LastRecordingGoneTests(unittest.TestCase):
    """Deleting the only recording, as someone who isn't an admin (no Showing button): the page has nothing left to focus."""

    def page(self, **attrs):
        w = screen(recordings.Recordings, shows=[], series=[], nav_at_end=True, content_focus=recordings.LISTS['recorded'], **attrs)
        return lists(w, {control_id: 0 for control_id in (*recordings.LISTS.values(), recordings.SERIES)})

    def test_right_from_the_sidebar_stays_there_rather_than_going_to_the_emptied_list(self):
        w = self.page()
        w.setFocusId(base.SIDEBAR_END)
        w.onAction(key(base.ACTION_MOVE_RIGHT))
        self.assertEqual(w.getFocusId(), base.SIDEBAR_END)

    def test_choosing_its_own_sidebar_entry_stays_there_too(self):
        w = self.page(nav='recordings')
        w.setFocusId(base.SIDEBAR_END)
        w.app.target_for = lambda entry: ('recordings',)
        selected = type('Item', (), {'getProperty': lambda self, name: 'recordings'})()
        sidebar = lists(w, {control_id: 0 for control_id in (*recordings.LISTS.values(), recordings.SERIES)}).getControl
        w.getControl = lambda control_id: type('Nav', (), {'getSelectedItem': lambda self: selected})() if control_id == base.SIDEBAR_END else sidebar(control_id)
        w.sidebar_clicked(base.SIDEBAR_END)
        self.assertEqual(w.getFocusId(), base.SIDEBAR_END)

    def test_back_from_the_sidebar_leaves_the_screen(self):
        w = self.page()
        w.setFocusId(base.SIDEBAR_END)
        w.onAction(key(base.ACTION_NAV_BACK))
        self.assertTrue(getattr(w, 'was_closed', False), 'Back would have stayed on the sidebar for good')

    def test_the_focus_moves_off_a_list_that_emptied_onto_the_lit_sidebar_entry(self):
        w = self.page()
        w.setFocusId(recordings.LISTS['recorded'])
        w.keep_focus()
        self.assertEqual(w.getFocusId(), base.SIDEBAR_END)

    def test_an_admin_has_the_showing_button_to_go_to(self):
        w = self.page()
        w.setProperty('admin', 'true')
        w.setFocusId(recordings.LISTS['recorded'])
        w.keep_focus()
        self.assertEqual(w.getFocusId(), recordings.WHOSE)

    def test_with_nothing_focused_the_first_arrow_brings_the_focus_back(self):
        label = base.xbmc.getInfoLabel
        base.xbmc.getInfoLabel = lambda name: ''
        try:
            for action_id in base.ARROWS:
                w = self.page()
                # As Kodi does: it goes on naming the last control that had the focus, though nothing has it now.
                w.focus = recordings.LISTS['recorded']
                w.onAction(key(action_id))
                self.assertEqual(w.getFocusId(), base.SIDEBAR_END, action_id)
        finally:
            base.xbmc.getInfoLabel = label

    def test_select_leaves_the_focus_alone_as_it_opens_a_screen(self):
        label = base.xbmc.getInfoLabel
        base.xbmc.getInfoLabel = lambda name: ''  # empty for a moment while the next screen opens
        try:
            w = self.page()
            lists(w, {recordings.LISTS['recorded']: 1})
            w.setFocusId(recordings.LISTS['recorded'])
            w.on_action = lambda action_id, focus: None
            w.onAction(key(base.ACTION_SELECT))
            self.assertEqual(w.getFocusId(), recordings.LISTS['recorded'])
        finally:
            base.xbmc.getInfoLabel = label

    def test_coming_back_from_a_show_stays_on_a_list_with_something_in_it(self):
        """Control.IsVisible says no for a moment as a screen comes back: a list isn't judged by that."""
        w = self.page()
        lists(w, {recordings.LISTS['recorded']: 3})
        w.setFocusId(recordings.LISTS['recorded'])
        visible = base.xbmc.getCondVisibility
        base.xbmc.getCondVisibility = lambda condition: False
        try:
            w.keep_focus()
        finally:
            base.xbmc.getCondVisibility = visible
        self.assertEqual(w.getFocusId(), recordings.LISTS['recorded'])

    def test_with_something_left_the_focus_goes_to_what_is_left(self):
        w = self.page()
        w.shows = [{'key': 'a', 'recordingNow': False, 'counts': {'recorded': 0}, 'nextScheduled': 5}]
        lists(w, {recordings.LISTS['now']: 0, recordings.LISTS['recorded']: 0, recordings.LISTS['scheduled']: 1, recordings.SERIES: 0})
        w.setFocusId(recordings.LISTS['recorded'])
        w.keep_focus()
        self.assertEqual(w.getFocusId(), recordings.LISTS['scheduled'])

    def test_a_list_still_holding_something_keeps_the_focus(self):
        w = self.page()
        lists(w, {recordings.LISTS['recorded']: 2})
        w.setFocusId(recordings.LISTS['recorded'])
        moved = []
        w.focus_soon = moved.append
        w.keep_focus()
        self.assertEqual(moved, [])

    def test_a_dialog_on_top_is_left_alone(self):
        w = self.page()
        w.focus = 0
        visible = base.xbmc.getCondVisibility
        base.xbmc.getCondVisibility = lambda condition: condition == 'System.HasActiveModalDialog'
        try:
            w.keep_focus()
        finally:
            base.xbmc.getCondVisibility = visible
        self.assertEqual(w.getFocusId(), 0)

    def test_a_hidden_button_gives_up_the_focus(self):
        w = lists(screen(base.Screen, content_focus=811), {})
        w.default_focus = lambda: 800
        visible = base.xbmc.getCondVisibility
        base.xbmc.getCondVisibility = lambda condition: condition != 'Control.IsVisible(811)' and condition.startswith('Control.IsVisible')
        try:
            w.setFocusId(811)
            w.keep_focus()
        finally:
            base.xbmc.getCondVisibility = visible
        self.assertEqual(w.getFocusId(), 800)


class ChannelInContinueWatchingTests(unittest.TestCase):
    CHANNELS = [{'uuid': 'a', 'name': 'One'}, {'uuid': 'r', 'name': 'Radio One', 'radio': True}, {'uuid': 'b', 'name': 'Two'}]

    def setUp(self):
        kodistubs.NOTIFICATIONS.clear()
        self.w = screen(home.Home)
        self.played = []
        self.w.app.play_live = lambda channels, index, radio: self.played.append(([c['name'] for c in channels], index, radio))
        self.w.app.api.get = lambda path, **kw: {'channels': self.CHANNELS}
        self.opened = []
        self.w.open_child = self.opened.append
        self.w.getControl = lambda control_id: type('Row', (), {'getSelectedItem': lambda _self: None})()

    def select(self, card):
        self.w.selected = lambda control_id: card
        self.w.on_click(home.POSTER_ROW)

    def test_selecting_it_plays_it_with_the_tv_channels_after_it(self):
        self.select({'id': 0, 'type': 'channel', 'uuid': 'b', 'play': True, 'position': 0, 'title': 'Two'})
        self.assertEqual(self.played, [(['One', 'Two'], 1, False)])
        self.assertEqual(self.opened, [])

    def test_a_channel_no_longer_there_says_so(self):
        self.select({'id': 0, 'type': 'channel', 'uuid': 'gone', 'play': True, 'position': 0, 'title': 'Gone'})
        self.assertEqual(self.played, [])

    def test_the_menu_key_does_nothing_on_it_as_it_has_no_page(self):
        self.w.selected = lambda control_id: {'id': 0, 'type': 'channel', 'uuid': 'a'}
        self.w.on_context(home.POSTER_ROW)
        self.assertEqual(self.opened, [])


if __name__ == '__main__':
    unittest.main()
