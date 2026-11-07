# The Reelhouse screens' layouts: made from kodi/skin-src and up to date, and every texture and control the Python
# side asks for is there.
import os
import re
import subprocess
import sys
import unittest
from xml.etree import ElementTree

import helpers

ADDON = os.path.join(helpers.HERE, '..', 'plugin.video.reelhouse')
LAYOUTS = os.path.join(ADDON, 'resources', 'skins', 'Default', '1080i')
MEDIA = os.path.join(ADDON, 'resources', 'skins', 'Default', 'media')
WINDOWS = os.path.join(ADDON, 'resources', 'lib', 'ui', 'windows')


def layout(name):
    return ElementTree.parse(os.path.join(LAYOUTS, name)).getroot()


def constants(path):
    """A module's numeric constants: NAME = 1 and A, B = 1, 2 lines."""
    found = {}
    with open(path, encoding='utf-8') as f:
        lines = f.readlines()
    for line in lines:
        m = re.match(r'^([A-Z_]+(?:, [A-Z_]+)*) = (\d+(?:, \d+)*)', line)
        if m:
            found.update(zip([n.strip() for n in m.group(1).split(',')], [int(v) for v in m.group(2).split(',')]))
    return found


class SkinTests(unittest.TestCase):
    def test_the_layouts_are_made_from_skin_src(self):
        tool = os.path.join(helpers.HERE, '..', 'tools', 'build_skin.py')
        result = subprocess.run([sys.executable, tool, '--check'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_every_texture_named_is_in_the_media_folder(self):
        for name in os.listdir(LAYOUTS):
            with open(os.path.join(LAYOUTS, name), encoding='utf-8') as f:
                text = f.read()
            for ref in set(re.findall(r'(reelhouse/[\w/.-]+\.png)', text)):
                self.assertTrue(os.path.exists(os.path.join(MEDIA, ref)), '{}: {}'.format(name, ref))

    def test_every_screen_keeps_a_video_behind_it_playing(self):
        # Kodi's player stalls with nothing to draw its pictures: each screen has a video control, under its background.
        for name in os.listdir(LAYOUTS):
            if name == 'reelhouse-options.xml':
                continue  # a dialog: the screen under it goes on drawing
            controls = list(layout(name).find('controls'))
            self.assertEqual(controls[0].get('type'), 'videowindow', name)
            self.assertEqual(controls[1].find('width').text, '1920', '{}: the background covers it'.format(name))

    def test_no_button_in_a_row_traps_the_focus(self):
        # A grouplist moves the focus between its own children only: a button inside a group in it (the film page's ⋯,
        # in a group for its icon) needs its own way out, or the arrows do nothing on it.
        trapped = []
        for name in sorted(os.listdir(LAYOUTS)):
            root = layout(name)
            parent = {child: node for node in root.iter() for child in node}
            for button in root.iter('control'):
                if button.get('type') != 'button' or button.find('onleft') is not None:
                    continue
                up = parent.get(button)
                if up is None or up.get('type') == 'grouplist':
                    continue  # the row itself moves the focus on
                while up is not None and up.get('type') != 'grouplist':
                    up = parent.get(up)
                if up is not None:
                    trapped.append(f'{name}: {button.get("id")}')
        self.assertEqual(trapped, [])

    def test_the_python_side_finds_its_controls(self):
        # Each window module's control ids (by constant name, or as numbers) and the layout it opens.
        checks = {
            'home.py': ('reelhouse-home.xml', [310, 321, 340, 351, 9000]),
            'library.py': ('reelhouse-library.xml', ['GRID', 'SORT', 'FILTER', 'GENRE']),
            'item.py': ('reelhouse-item.xml', ['PLAY', 'AGAIN', 'WATCHED', 'MORE', 'INFO', 'SEASONS', 'EPISODES', 'CAST', 440, 443]),
            'person.py': ('reelhouse-person.xml', ['HERE', 'OTHERS']),
            'search.py': ('reelhouse-search.xml', ['BOX', 'MOVIES', 'SHOWS', 'EPISODES', 'PEOPLE']),
            'livetv.py': ('reelhouse-livetv.xml', ['DAYS', 9000]),
            'recordings.py': ('reelhouse-recordings.xml', [601, 602, 603, 604, 621, 622, 623, 624, 631, 632, 'WHOSE', 9000, 9002]),
            'recording_show.py': ('reelhouse-recording-show.xml', ['GRID', 'DELETE_SHOW', 9000, 9002]),
            'recording_series.py': ('reelhouse-recording-series.xml', ['GRID', 'DELETE_SERIES', 9000, 9002]),
            'options.py': ('reelhouse-options.xml', ['LIST']),
        }
        for module, (xml, wanted) in checks.items():
            names = constants(os.path.join(WINDOWS, module))
            ids = set(int(c.get('id')) for c in layout(xml).iter('control') if c.get('id', '').isdigit())
            for want in wanted:
                control = names.get(want) if isinstance(want, str) else want
                self.assertIsNotNone(control, '{}: no {}'.format(module, want))
                self.assertIn(control, ids, '{}: control {} ({}) not in {}'.format(module, control, want, xml))

    def test_the_menu_holds_enough_choices(self):
        items = list(layout('reelhouse-options.xml').iter('item'))
        with open(os.path.join(WINDOWS, 'options.py'), encoding='utf-8') as f:
            source = f.read()
        most = int(re.search(r'^MAX_CHOICES = (\d+)', source, re.M).group(1))
        self.assertEqual(len(items), most)
        self.assertEqual(items[3].find("property[@name='choice']").text, 'choice3')


if __name__ == '__main__':
    unittest.main()
