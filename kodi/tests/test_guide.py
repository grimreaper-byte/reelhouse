# The Live TV guide's geometry and arrow keys, as the web app's guide moves.
import unittest

import helpers  # noqa: F401  (puts the add-on on sys.path)

from resources.lib.ui.guide import Guide, half_hour

H = 3600
CHANNELS = [{'uuid': 'one'}, {'uuid': 'two'}, {'uuid': 'empty'}, {'uuid': 'three'}]


def ev(id_, channel, start, stop):
    return {'id': id_, 'channel': channel, 'start': start, 'stop': stop}


def guide():
    events = [
        ev(1, 'one', 0, H), ev(2, 'one', H, 2 * H), ev(3, 'one', 2 * H, 3 * H),
        ev(4, 'two', 0, 1800), ev(5, 'two', 1800, 2 * H),
        ev(6, 'three', 3000, 5400),
    ]
    return Guide(CHANNELS, events, rows=2, span=2 * H, start=0)


class LayoutTests(unittest.TestCase):
    def test_blocks_are_placed_by_time_and_cut_at_the_window(self):
        g = guide()
        g.start = 1800
        blocks = g.blocks('one', 400, 1440)  # 2 hours in 1440 px: 0.2 px a second
        self.assertEqual([(e['id'], x, w) for e, x, w in blocks], [(1, 400, 360), (2, 760, 720), (3, 1480, 360)])

    def test_the_now_line(self):
        g = guide()
        self.assertEqual(g.x_of(H, 400, 1440), 1120)
        self.assertIsNone(g.x_of(3 * H, 400, 1440))

    def test_the_first_highlight_is_whats_on_now(self):
        self.assertEqual(guide().first_highlight(4000)['id'], 2)
        self.assertEqual(guide().first_highlight(-100)['id'], 1)  # nothing on yet: the first programme

    def test_rows_on_screen(self):
        g = guide()
        g.top = 1
        self.assertEqual([c['uuid'] for c in g.visible_channels()], ['two', 'empty'])


class MoveTests(unittest.TestCase):
    def test_left_and_right_along_a_channel(self):
        g = guide()
        self.assertEqual(g.move(g.by_id[2], 'right', None, 0)[0]['id'], 3)
        self.assertEqual(g.move(g.by_id[2], 'left', None, 0)[0]['id'], 1)
        self.assertIsNone(g.move(g.by_id[3], 'right', None, 0)[0])

    def test_up_and_down_keep_to_one_time_and_pass_empty_channels(self):
        g = guide()
        now = 2000
        # From what's on now on "one" (anchor: now) to what's on then on "two", past the empty channel to "three".
        target, anchor = g.move(g.by_id[1], 'down', None, now)
        self.assertEqual((target['id'], anchor), (5, now))
        target, anchor = g.move(target, 'down', anchor, now)
        self.assertEqual(target['id'], 6)
        target, anchor = g.move(target, 'up', anchor, now)
        self.assertEqual(target['id'], 5)  # the same time, not where "three"'s programme starts
        self.assertIsNone(g.move(g.by_id[1], 'up', None, now)[0])

    def test_a_later_programme_anchors_at_its_start(self):
        g = guide()
        target, anchor = g.move(g.by_id[3], 'down', None, 100)
        self.assertEqual(anchor, 2 * H)
        self.assertEqual(target['id'], 5)  # nearest on "two": it ended at 2 h


class RevealTests(unittest.TestCase):
    def test_a_row_below_brings_the_rows_down(self):
        g = guide()
        self.assertTrue(g.reveal(g.by_id[6]))
        self.assertEqual(g.top, 2)
        self.assertFalse(g.reveal(g.by_id[6]))

    def test_a_programme_near_the_end_moves_the_hours_on(self):
        g = guide()
        self.assertTrue(g.reveal(g.by_id[3]))  # starts at 2 h, the window's end
        self.assertEqual(g.start, 2 * H - 1800)
        self.assertTrue(g.reveal(g.by_id[1], floor=0))  # back to the start, not before the floor
        self.assertEqual(g.start, 0)

    def test_half_hours(self):
        self.assertEqual(half_hour(1799), 0)
        self.assertEqual(half_hour(5400), 5400)


if __name__ == '__main__':
    unittest.main()
