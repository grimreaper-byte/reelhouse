# Opens what a sync needs: the Reelhouse API, Kodi's video database and the add-on's own records.
import os
import re
from contextlib import contextmanager

import xbmcvfs

from . import utils
from .api import Api
from .kodidb import KodiDbError, KodiVideoDb, find_database
from .syncdb import SyncDb


def api():
    return Api(utils.setting('server_url'), utils.setting('device_token'))


def records_path():
    return os.path.join(utils.profile_dir(), 'reelhouse.db')


def check_local_database():
    # A shared MySQL/MariaDB video database (advancedsettings.xml) isn't the local SQLite file this add-on writes.
    path = xbmcvfs.translatePath('special://userdata/advancedsettings.xml')
    if xbmcvfs.exists(path):
        f = xbmcvfs.File(path)
        try:
            text = f.read()
        finally:
            f.close()
        block = re.search(r'<videodatabase>(.*?)</videodatabase>', text, re.S | re.I)
        if block and re.search(r'<type>\s*mysql\s*</type>', block.group(1), re.I):
            raise KodiDbError('Kodi uses a shared MySQL video database, which this add-on does not support')


@contextmanager
def open_all():
    """Yields (api, kodi_db, records), closing the databases afterwards."""
    check_local_database()
    path, version = find_database(xbmcvfs.translatePath('special://database/'))
    kodi = KodiVideoDb(path)
    records = SyncDb(records_path())
    try:
        yield api(), kodi, records
    finally:
        records.close()
        kodi.close()
