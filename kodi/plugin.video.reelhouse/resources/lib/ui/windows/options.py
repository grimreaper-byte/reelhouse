# A small menu over the screen (⋯ on a page, Play version…, sort and filter choices, a programme's Record…).
# choose() returns the chosen one's index, or None. Kodi doesn't draw changes made to a dialog once it's open, so its
# words go in as window properties before it opens and its list is a fixed one in the layout (reelhouse-options.xml).
import xbmc
import xbmcgui

from .base import ADDON_PATH, BACK, ACTION_SELECT

SELECT = (ACTION_SELECT, 100)  # the Select button, a mouse click

LIST = 800
MAX_CHOICES = 40   # entries in the layout's list
MAX_ROWS = 7       # the box's tallest size; more choices scroll


class Options(xbmcgui.WindowXMLDialog):
    def onInit(self):
        self.setFocusId(LIST)

    def onAction(self, action):
        # A fixed list's entries don't report clicks (no onClick) or their position to Python, so Select is taken
        # here and the entry's number read from its "choice" property ("choice3": a bare number would be read as
        # one of Kodi's own texts).
        if action.getId() in SELECT and self.getFocusId() == LIST:
            value = xbmc.getInfoLabel('Container({}).ListItem.Property(choice)'.format(LIST))
            number = value[len('choice'):] if value.startswith('choice') else ''
            self.result = int(number) if number.isdigit() else None
            self.close()
        elif action.getId() in BACK:
            self.close()


def choose(heading, choices, subheading=None, owner=None):
    """choices: [{'label', 'label2' (a line of detail), 'tag' (on the right, e.g. 'Plays by default')}]. owner: who set
    a recording, under the headings ({'names', 'letter', 'avatar'}, as model.set_by with the picture's address)."""
    choices = list(choices)[:MAX_CHOICES]
    if not choices:
        return None
    dialog = Options('reelhouse-options.xml', ADDON_PATH, 'Default', '1080i')
    dialog.setProperty('heading', heading or '')
    dialog.setProperty('subheading', subheading or '')
    for key in ('names', 'letter', 'avatar'):
        dialog.setProperty('owner.' + key, (owner or {}).get(key) or '')
    dialog.setProperty('count', str(min(len(choices), MAX_ROWS)))
    for n, c in enumerate(choices):
        dialog.setProperty('option.{}.label'.format(n), c.get('label') or ' ')
        dialog.setProperty('option.{}.label2'.format(n), c.get('label2') or '')
        dialog.setProperty('option.{}.tag'.format(n), c.get('tag') or '')
    dialog.result = None
    dialog.doModal()
    result = dialog.result
    del dialog
    return result if result is not None and 0 <= result < len(choices) else None
