# Entry point when Kodi opens the add-on, plays a synced item, or runs one of its actions.
import sys

from resources.lib import plugin

plugin.run(sys.argv)
