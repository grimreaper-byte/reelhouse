# The sync engine against a fake Reelhouse API and a real (fixture) Kodi database.
import copy
import os
import tempfile
import unittest

from helpers import episode, kodi_database, movie, rows, season, show

from resources.lib.kodidb import KodiVideoDb
from resources.lib.sync import Syncer
from resources.lib.syncdb import SyncDb


class FakeApi(object):
    """Holds a pretend server's libraries and items; counts the detail requests a sync makes."""

    def __init__(self):
        self.base_url = 'http://rh:8484'
        self.token = 'tok'
        self.libraries_list = [{'id': 1, 'name': 'Movies', 'type': 'movie'}, {'id': 2, 'name': 'TV', 'type': 'show'}]
        self.store = {}
        self.detail_calls = []
        heat = movie(1, cast=[{'name': 'Al Pacino', 'role': 'Vincent Hanna', 'profile': '/api/tmdb-image/profile/al.jpg'}])
        for item in (heat, movie(2, title='Alien', tmdbId=348, cast=[]), show(10, cast=[]), season(11), episode(12), episode(13, number=2, title='Two')):
            self.put(item)

    def put(self, item):
        self.store[item['id']] = copy.deepcopy(item)

    def libraries(self):
        return {'libraries': copy.deepcopy(self.libraries_list)}

    def library_items(self, library_id):
        out = []
        for item in sorted(self.store.values(), key=lambda i: ({'show': 0, 'season': 1}.get(i['type'], 2), i['id'])):
            if item['libraryId'] == library_id:
                entry = {'id': item['id'], 'type': item['type'], 'checksum': item['checksum'],
                         'parentId': item.get('parentId'), 'showId': item.get('showId')}
                if 'state' in item:
                    entry['state'] = item['state']
                out.append(entry)
        return out

    def items(self, ids):
        self.detail_calls.append(list(ids))
        return [copy.deepcopy(self.store[i]) for i in ids if i in self.store]

    def states(self, ids):
        return [{'id': i, 'state': self.store[i]['state']} for i in ids if i in self.store]

    def media_url(self, path, **params):
        return '{}{}{}w={}&X-Reelhouse-Token={}'.format(self.base_url, path, '&' if '?' in path else '?', params.get('w'), self.token)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.path = kodi_database()
        self.api = FakeApi()
        self.records = SyncDb(os.path.join(tempfile.mkdtemp(prefix='rh-sync-'), 'reelhouse.db'))
        self.kodi = KodiVideoDb(self.path)

    def tearDown(self):
        self.kodi.close()
        self.records.close()

    def sync(self, library_id=None):
        self.api.detail_calls = []
        return Syncer(self.api, self.kodi, self.records).run(library_id)

    def titles(self, view='movie_view'):
        return sorted(r['c00'] for r in rows(self.path, 'SELECT c00 FROM {}'.format(view)))

    def test_first_sync_adds_everything(self):
        stats = self.sync()
        self.assertEqual(stats, {'added': 5, 'updated': 0, 'removed': 0, 'states': 0})
        self.assertEqual(self.titles(), ['Alien', 'Heat'])
        self.assertEqual(self.titles('tvshow_view'), ['Breaking Bad'])
        self.assertEqual(self.titles('episode_view'), ['Pilot', 'Two'])
        art = rows(self.path, "SELECT url FROM art WHERE media_type = 'movie' AND type = 'poster' ORDER BY url")
        self.assertEqual(art[0]['url'], 'http://rh:8484/api/images/1/poster?v=1&w=1000&X-Reelhouse-Token=tok')
        # Cast photos come from the server as relative paths and get the address and token added.
        self.assertEqual(rows(self.path, "SELECT url FROM art WHERE media_type = 'actor'"),
                         [{'url': 'http://rh:8484/api/tmdb-image/profile/al.jpg?w=300&X-Reelhouse-Token=tok'}])

    def test_nothing_changed_means_no_detail_requests(self):
        self.sync()
        stats = self.sync()
        self.assertEqual(stats, {'added': 0, 'updated': 0, 'removed': 0, 'states': 0})
        self.assertEqual(self.api.detail_calls, [])

    def test_only_changed_items_are_fetched_and_rewritten(self):
        self.sync()
        movie_id = rows(self.path, "SELECT idMovie FROM movie WHERE c00 = 'Heat'")[0]['idMovie']
        self.api.put(movie(1, title='Heat (Director\'s Cut)', checksum='2'))
        stats = self.sync()
        self.assertEqual(stats['updated'], 1)
        self.assertEqual(self.api.detail_calls, [[1]])
        self.assertEqual(self.titles(), ['Alien', "Heat (Director's Cut)"])
        self.assertEqual(rows(self.path, "SELECT idMovie FROM movie WHERE c00 LIKE 'Heat%'")[0]['idMovie'], movie_id, 'same Kodi id')

    def test_watch_state_changes_need_no_details(self):
        self.sync()
        item = self.api.store[12]
        item['state'] = {'watched': True, 'viewCount': 1, 'position': 0, 'updatedAt': 1700000000000}
        stats = self.sync()
        self.assertEqual((stats['states'], stats['updated']), (1, 0))
        self.assertEqual(self.api.detail_calls, [])
        played = rows(self.path, "SELECT playCount FROM episode_view WHERE c00 = 'Pilot'")
        self.assertEqual(played, [{'playCount': 1}])

    def test_removed_on_the_server_is_removed_from_kodi(self):
        self.sync()
        del self.api.store[2]
        del self.api.store[13]
        stats = self.sync()
        self.assertEqual(stats['removed'], 2)
        self.assertEqual(self.titles(), ['Heat'])
        self.assertEqual(self.titles('episode_view'), ['Pilot'])

    def test_a_library_that_disappears_is_removed(self):
        self.sync()
        self.api.libraries_list = [lib for lib in self.api.libraries_list if lib['id'] != 2]
        stats = self.sync()
        self.assertEqual(stats['removed'], 3)
        self.assertEqual(rows(self.path, 'SELECT * FROM tvshow'), [])
        self.assertEqual(rows(self.path, 'SELECT * FROM seasons'), [])
        self.assertEqual(self.titles(), ['Alien', 'Heat'])

    def test_items_deleted_in_kodi_are_written_again(self):
        self.sync()
        raw = self.kodi.conn
        raw.execute("DELETE FROM movie WHERE c00 = 'Alien'")
        stats = self.sync()
        self.assertEqual(stats['updated'], 1)
        self.assertEqual(self.titles(), ['Alien', 'Heat'])

    def test_a_new_token_rewrites_artwork_urls(self):
        self.sync()
        self.api.token = 'new-token'
        stats = self.sync()
        self.assertEqual(stats['updated'], 5)
        urls = [r['url'] for r in rows(self.path, "SELECT url FROM art WHERE media_type IN ('movie', 'tvshow', 'season', 'episode')")]
        self.assertTrue(urls and all('new-token' in u for u in urls))

    def test_live_state_updates(self):
        self.sync()
        self.api.store[1]['state'] = {'watched': False, 'viewCount': 0, 'position': 600, 'updatedAt': 1700000000000}
        changed = Syncer(self.api, self.kodi, self.records).apply_states([1, 2, 999])
        self.assertEqual(changed, 1)
        self.assertEqual(rows(self.path, "SELECT resumeTimeInSeconds FROM movie_view WHERE c00 = 'Heat'"), [{'resumeTimeInSeconds': 600.0}])
        self.assertEqual(Syncer(self.api, self.kodi, self.records).apply_states([1]), 0, 'already up to date')

    def test_new_episode_in_an_existing_show(self):
        self.sync()
        self.api.put(episode(14, number=3, title='Three'))
        stats = self.sync(library_id=2)
        self.assertEqual(stats['added'], 1)
        self.assertEqual(self.titles('episode_view'), ['Pilot', 'Three', 'Two'])

    def test_remove_all(self):
        self.sync()
        removed = Syncer(self.api, self.kodi, self.records).remove_all()
        self.assertEqual(removed, 5)
        self.assertEqual(self.records.count(), 0)
        self.assertEqual(rows(self.path, 'SELECT * FROM files'), [])

    def counts(self):
        return {t: rows(self.path, 'SELECT COUNT(*) AS n FROM {}'.format(t))[0]['n']
                for t in ('movie', 'tvshow', 'seasons', 'episode', 'files', 'videoversion')}

    def test_lost_records_do_not_duplicate_anything(self):
        # E.g. the add-on reinstalled with its data deleted, while its items stayed in Kodi.
        self.sync()
        before = self.counts()
        movie_ids = sorted(r['idMovie'] for r in rows(self.path, 'SELECT idMovie FROM movie'))
        self.records.close()
        self.records = SyncDb(os.path.join(tempfile.mkdtemp(prefix='rh-sync-'), 'reelhouse.db'))
        stats = self.sync()
        self.assertEqual(stats['added'], 5)  # new to the records, but already in Kodi
        self.assertEqual(self.counts(), before)
        self.assertEqual(sorted(r['idMovie'] for r in rows(self.path, 'SELECT idMovie FROM movie')), movie_ids)
        self.assertEqual(self.titles(), ['Alien', 'Heat'])
        self.assertEqual(self.titles('episode_view'), ['Pilot', 'Two'])

    def test_ids_reused_for_other_kinds_of_items_replace_the_old_rows(self):
        # Reelhouse set up again from scratch: ids start over, so 1 is now a show and 10 an episode.
        self.sync()
        self.api.base_url, self.api.token = 'http://new-server:8484', 'tok2'
        self.api.store = {}
        for item in (show(1, title='The Wire', cast=[]), season(2, show_id=1), episode(10, season_id=2, show_id=1, title='The Target'),
                     movie(11, title='Up', tmdbId=14160, cast=[])):
            self.api.put(item)
        self.sync()
        self.assertEqual(self.titles(), ['Up'])
        self.assertEqual(self.titles('tvshow_view'), ['The Wire'])
        self.assertEqual(self.titles('episode_view'), ['The Target'])
        self.assertEqual(self.counts(), {'movie': 1, 'tvshow': 1, 'seasons': 2, 'episode': 1, 'files': 2, 'videoversion': 1})
        episode_show = rows(self.path, 'SELECT strTitle FROM episode_view')
        self.assertEqual(episode_show, [{'strTitle': 'The Wire'}])

    def test_a_renamed_library_retags_its_items(self):
        self.sync()
        self.api.libraries_list[0]['name'] = 'Films'
        stats = self.sync()
        self.assertEqual(stats['updated'], 2)
        tags = rows(self.path, "SELECT DISTINCT t.name FROM tag t JOIN tag_link l ON l.tag_id = t.tag_id WHERE l.media_type = 'movie'")
        self.assertEqual(tags, [{'name': 'Films'}])
        self.assertEqual(self.sync()['updated'], 0, 'only once')

    def test_live_state_updates_are_requested_in_server_sized_chunks(self):
        from resources.lib import sync as sync_module
        self.sync()
        asked = []
        original = self.api.states
        self.api.states = lambda ids: asked.append(list(ids)) or original(ids)
        saved, sync_module.STATES_BATCH = sync_module.STATES_BATCH, 1
        try:
            Syncer(self.api, self.kodi, self.records).apply_states([1, 2, 12])
        finally:
            sync_module.STATES_BATCH = saved
        self.assertEqual(sorted(asked), [[1], [2], [12]])


if __name__ == '__main__':
    unittest.main()
