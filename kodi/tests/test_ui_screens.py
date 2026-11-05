# What a Reelhouse screen does when Reelhouse goes away and comes back (a server being recreated while Kodi is open), and
# where the focus goes: tried with Kodi's window stubbed (kodistubs.py), as the logic is the screens' own.
import threading
import unittest

import helpers  # noqa: F401  (puts the add-on on sys.path)
import kodistubs

kodistubs.install()

from resources.lib.api import ApiError  # noqa: E402
from resources.lib.ui.windows import base, livetv, recordings, search  # noqa: E402


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


if __name__ == '__main__':
    unittest.main()
