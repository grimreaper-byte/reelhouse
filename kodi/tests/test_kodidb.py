# The database writer, checked through Kodi's own views (movie_view, tvshow_view, season_view, episode_view),
# which are what Kodi's library screens, widgets and JSON-RPC read.
import os
import sqlite3
import tempfile
import unittest

from helpers import episode, kodi_database, movie, rows, season, show

from resources.lib.kodidb import KodiDbError, KodiVideoDb, find_database

ART = {'poster': 'http://rh/p.jpg?a=1&b=2', 'fanart': 'http://rh/f.jpg', 'thumb': 'http://rh/f.jpg'}


class MovieTests(unittest.TestCase):
    def setUp(self):
        self.path = kodi_database()
        self.db = KodiVideoDb(self.path)

    def tearDown(self):
        self.db.close()

    def add(self, item=None, existing=None, art=ART):
        with self.db.transaction():
            return self.db.upsert_movie(item or movie(), art, ['Movies'], existing)

    def test_movie_shows_up_in_kodis_movie_view(self):
        movie_id, file_id, _ = self.add()
        [m] = rows(self.path, 'SELECT * FROM movie_view')
        self.assertEqual(m['idMovie'], movie_id)
        self.assertEqual(m['c00'], 'Heat')
        self.assertEqual(m['c16'], 'Heat (Original)')
        self.assertEqual(m['c11'], '10200')
        self.assertEqual(m['c14'], 'Crime / Drama')
        self.assertEqual(m['premiered'], '1995-12-15')
        self.assertEqual(m['strFileName'], 'plugin://plugin.video.reelhouse/movies/?mode=play&id=1', 'the full URL: Kodi does not join plugin paths')
        self.assertEqual(m['strPath'], 'plugin://plugin.video.reelhouse/movies/')
        self.assertAlmostEqual(m['rating'], 7.9, places=5)
        self.assertEqual((m['uniqueid_type'], m['uniqueid_value']), ('tmdb', '949'))
        self.assertEqual(m['isDefaultVersion'], 1)
        self.assertIsNone(m['playCount'])
        self.assertIn('&amp;b=2', m['c08'], 'artwork URLs are XML-escaped in the thumbs column')

    def test_links_art_people_and_streams(self):
        movie_id, file_id, _ = self.add()
        art = {r['type']: r['url'] for r in rows(self.path, "SELECT * FROM art WHERE media_type = 'movie'")}
        self.assertEqual(art, ART)
        cast = rows(self.path, "SELECT a.name, l.role, l.cast_order FROM actor_link l JOIN actor a ON a.actor_id = l.actor_id WHERE media_type = 'movie' ORDER BY cast_order")
        self.assertEqual([(c['name'], c['role']) for c in cast], [('Al Pacino', 'Vincent Hanna'), ('Robert De Niro', 'Neil McCauley')])
        self.assertEqual(rows(self.path, "SELECT url FROM art WHERE media_type = 'actor'"), [{'url': 'http://rh/al.jpg'}])
        self.assertEqual([r['name'] for r in rows(self.path, 'SELECT name FROM genre ORDER BY name')], ['Crime', 'Drama'])
        self.assertEqual(len(rows(self.path, 'SELECT * FROM director_link')), 1)
        self.assertEqual(rows(self.path, 'SELECT t.name FROM tag t JOIN tag_link l ON l.tag_id = t.tag_id'), [{'name': 'Movies'}])
        self.assertEqual({r['type'] for r in rows(self.path, 'SELECT type FROM uniqueid')}, {'tmdb', 'imdb', 'reelhouse'})
        streams = rows(self.path, 'SELECT * FROM streamdetails WHERE idFile = ? ORDER BY iStreamType', file_id)
        self.assertEqual([s['iStreamType'] for s in streams], [0, 1, 1, 2])
        self.assertEqual((streams[0]['strVideoCodec'], streams[0]['iVideoWidth'], streams[0]['strHdrType']), ('hevc', 3840, 'hdr10'))
        self.assertEqual((streams[1]['strAudioCodec'], streams[1]['iAudioChannels'], streams[1]['strAudioLanguage']), ('truehd', 8, 'eng'))
        self.assertEqual(rows(self.path, 'SELECT * FROM videoversion'), [{'idFile': file_id, 'idMedia': movie_id, 'media_type': 'movie', 'itemType': 0, 'idType': 40400}])

    def test_updating_keeps_ids_and_replaces_links(self):
        first = self.add()
        second = self.add(movie(title='Heat (1995)', genres=['Thriller'], cast=[]), existing=first[:2])
        self.assertEqual(first, second)
        self.assertEqual(len(rows(self.path, 'SELECT * FROM movie')), 1)
        self.assertEqual(rows(self.path, 'SELECT c00 FROM movie'), [{'c00': 'Heat (1995)'}])
        genres = rows(self.path, "SELECT g.name FROM genre_link l JOIN genre g ON g.genre_id = l.genre_id WHERE media_type = 'movie'")
        self.assertEqual(genres, [{'name': 'Thriller'}])
        self.assertEqual(rows(self.path, "SELECT * FROM actor_link WHERE media_type = 'movie'"), [])
        self.assertEqual(len(rows(self.path, "SELECT * FROM art WHERE media_type = 'movie'")), 3)
        self.assertEqual(len(rows(self.path, 'SELECT * FROM rating')), 1)
        self.assertEqual(len(rows(self.path, 'SELECT * FROM videoversion')), 1)

    def test_watch_state(self):
        movie_id, file_id, _ = self.add(movie(state={'watched': False, 'viewCount': 0, 'position': 1200, 'updatedAt': 1700000500000}))
        [m] = rows(self.path, 'SELECT playCount, resumeTimeInSeconds, totalTimeInSeconds, lastPlayed FROM movie_view')
        self.assertEqual((m['playCount'], m['resumeTimeInSeconds'], m['totalTimeInSeconds']), (None, 1200.0, 10200.5))
        self.assertTrue(m['lastPlayed'])
        with self.db.transaction():
            self.db.set_state(file_id, {'watched': True, 'viewCount': 2, 'position': 0, 'updatedAt': 1700000600000}, None)
        [m] = rows(self.path, 'SELECT playCount, resumeTimeInSeconds FROM movie_view')
        self.assertEqual((m['playCount'], m['resumeTimeInSeconds']), (2, None))
        with self.db.transaction():
            self.db.set_state(file_id, {'watched': False, 'viewCount': 2, 'position': 60, 'updatedAt': 1700000700000}, None)
        [m] = rows(self.path, 'SELECT playCount, resumeTimeInSeconds, totalTimeInSeconds FROM movie_view')
        self.assertEqual((m['playCount'], m['resumeTimeInSeconds']), (None, 60.0))
        self.assertEqual(m['totalTimeInSeconds'], 10200, 'without a duration the runtime comes from the stream details')

    def test_remove_movie_leaves_nothing_behind(self):
        self.add(movie(state={'watched': False, 'viewCount': 0, 'position': 100, 'updatedAt': 1}))
        with self.db.transaction():
            self.db.remove_movie(1)
        for table in ('movie', 'files', 'actor_link', 'genre_link', 'studio_link', 'tag_link', 'director_link', 'rating',
                      'uniqueid', 'bookmark', 'streamdetails', 'videoversion'):
            self.assertEqual(rows(self.path, 'SELECT * FROM {}'.format(table)), [], table)
        self.assertEqual(rows(self.path, "SELECT * FROM art WHERE media_type = 'movie'"), [])

    def test_a_movie_without_optional_data(self):
        bare = {'id': 5, 'type': 'movie', 'title': 'Home Video', 'checksum': '1', 'images': {}}
        with self.db.transaction():
            self.db.upsert_movie(bare, {'poster': None}, [], None)
        [m] = rows(self.path, 'SELECT c00, premiered, rating, uniqueid_type FROM movie_view')
        self.assertEqual(m, {'c00': 'Home Video', 'premiered': None, 'rating': None, 'uniqueid_type': 'reelhouse'})


class TvTests(unittest.TestCase):
    def setUp(self):
        self.path = kodi_database()
        self.db = KodiVideoDb(self.path)
        with self.db.transaction():
            self.show_id, self.show_path_id = self.db.upsert_show(show(), {'poster': 'http://rh/s.jpg', 'fanart': 'http://rh/sf.jpg'}, ['TV'])
            self.season_id = self.db.upsert_season(season(), self.show_id, {'poster': 'http://rh/s1.jpg'})
            self.ep_ids = self.db.upsert_episode(episode(state={'watched': True, 'viewCount': 1, 'position': 0, 'updatedAt': 1700000000000}),
                                                 self.show_id, self.show_path_id, self.season_id, {'thumb': 'http://rh/e1.jpg'})
            self.db.upsert_episode(episode(13, number=2, title='Cat\'s in the Bag'), self.show_id, self.show_path_id, self.season_id, {'thumb': None})

    def tearDown(self):
        self.db.close()

    def test_show_season_and_episodes_in_kodis_views(self):
        [s] = rows(self.path, 'SELECT * FROM tvshow_view')
        self.assertEqual((s['c00'], s['totalCount'], s['watchedcount'], s['totalSeasons']), ('Breaking Bad', 2, 1, 1))
        self.assertEqual(s['strPath'], 'plugin://plugin.video.reelhouse/tvshows/10/')
        self.assertEqual((s['uniqueid_type'], s['uniqueid_value']), ('tmdb', '1396'))
        [season_row] = rows(self.path, 'SELECT * FROM season_view')
        self.assertEqual((season_row['season'], season_row['episodes'], season_row['playCount']), (1, 2, 1))
        eps = rows(self.path, 'SELECT * FROM episode_view ORDER BY c13')
        self.assertEqual([(e['c00'], e['c12'], e['c13'], e['strTitle']) for e in eps],
                         [('Pilot', '1', '1', 'Breaking Bad'), ("Cat's in the Bag", '1', '2', 'Breaking Bad')])
        self.assertEqual(eps[0]['c18'], 'plugin://plugin.video.reelhouse/tvshows/10/?mode=play&id=12')
        self.assertEqual(eps[0]['playCount'], 1)
        self.assertEqual(eps[0]['c09'], '3480')
        self.assertEqual(rows(self.path, 'SELECT season FROM seasons ORDER BY season'), [{'season': -1}, {'season': 1}])
        self.assertEqual(rows(self.path, "SELECT url FROM art WHERE media_type = 'season'"), [{'url': 'http://rh/s1.jpg'}])

    def test_named_seasons_keep_their_name(self):
        with self.db.transaction():
            self.db.upsert_season(season(14, number=2, title='The Final Season'), self.show_id, {}, None)
            self.db.upsert_season(season(15, number=0, title='Specials'), self.show_id, {}, None)
        names = {r['season']: r['name'] for r in rows(self.path, 'SELECT season, name FROM seasons')}
        self.assertEqual((names[1], names[2], names[0]), (None, 'The Final Season', None))

    def test_removing_episode_season_and_show(self):
        with self.db.transaction():
            self.db.remove_episode(12, 10)
        self.assertEqual(len(rows(self.path, 'SELECT * FROM episode')), 1)
        with self.db.transaction():
            self.db.remove_season(self.season_id, 10)
            self.db.remove_show(10)
        for table in ('tvshow', 'seasons', 'episode', 'files', 'tvshowlinkpath', 'uniqueid', 'rating'):
            self.assertEqual(rows(self.path, 'SELECT * FROM {}'.format(table)), [], table)
        self.assertEqual(rows(self.path, "SELECT strPath FROM path WHERE strPath LIKE '%/tvshows/10/'"), [])

    def test_removal_never_touches_another_items_reused_ids(self):
        # Kodi hands out freed ids again: what used to be episode 12's row may now be someone else's.
        with self.db.transaction():
            self.db.remove_show(10)
            other_show, other_path = self.db.upsert_show(show(20, title='The Wire'), {}, [])
            other_season = self.db.upsert_season(season(21, show_id=20), other_show, {})
            self.db.upsert_episode(episode(22, season_id=21, show_id=20, title='The Target'), other_show, other_path, other_season, {})
        with self.db.transaction():
            self.db.remove_episode(12, 10)
            self.db.remove_season(other_season, 10)
            self.db.remove_show(10)
        self.assertEqual([r['c00'] for r in rows(self.path, 'SELECT c00 FROM episode_view')], ['The Target'])
        self.assertEqual(len(rows(self.path, 'SELECT * FROM seasons WHERE season = 1')), 1)


class GeneralTests(unittest.TestCase):
    def test_remove_everything_only_touches_reelhouse_items(self):
        path = kodi_database()
        db = KodiVideoDb(path)
        with db.transaction():
            db.upsert_movie(movie(), ART, [], None)
            show_id, path_id = db.upsert_show(show(), {}, [], None)
            season_id = db.upsert_season(season(), show_id, {}, None)
            db.upsert_episode(episode(), show_id, path_id, season_id, {}, None)
            # Something Kodi itself scanned from a disk.
            own_path = db.q("INSERT INTO path (strPath, strContent) VALUES ('D:\\Movies\\', 'movies')").lastrowid
            own_file = db.q("INSERT INTO files (idPath, strFilename) VALUES (?, 'Alien.mkv')", own_path).lastrowid
            db.q("INSERT INTO movie (idFile, c00) VALUES (?, 'Alien')", own_file)
        with db.transaction():
            removed = db.remove_everything()
        db.close()
        self.assertEqual(removed, 3)
        self.assertEqual(rows(path, 'SELECT c00 FROM movie'), [{'c00': 'Alien'}])
        self.assertEqual(rows(path, 'SELECT strFilename FROM files'), [{'strFilename': 'Alien.mkv'}])
        self.assertEqual(rows(path, 'SELECT * FROM tvshow'), [])
        self.assertEqual(rows(path, "SELECT * FROM path WHERE strPath LIKE 'plugin://%'"), [])

    def test_finds_the_newest_database(self):
        directory = tempfile.mkdtemp(prefix='rh-kodi-')
        for name in ('MyVideos119.db', 'MyVideos131.db', 'MyVideos121.db', 'MyMusic83.db'):
            open(os.path.join(directory, name), 'w').close()
        self.assertEqual(find_database(directory), (os.path.join(directory, 'MyVideos131.db'), 131))
        empty = tempfile.mkdtemp(prefix='rh-kodi-')
        with self.assertRaises(KodiDbError):
            find_database(empty)
        old = tempfile.mkdtemp(prefix='rh-kodi-')
        open(os.path.join(old, 'MyVideos116.db'), 'w').close()
        with self.assertRaises(KodiDbError):
            find_database(old)

    def test_refuses_an_unknown_layout(self):
        path = os.path.join(tempfile.mkdtemp(prefix='rh-kodi-'), 'MyVideos131.db')
        sqlite3.connect(path).execute('CREATE TABLE movie (idMovie INTEGER)').connection.close()
        with self.assertRaises(KodiDbError):
            KodiVideoDb(path)

    def test_works_without_video_versions_like_kodi_20(self):
        path = kodi_database()
        raw = sqlite3.connect(path)
        # Kodi 20 has no videoversion table (nor the view/trigger parts that use it).
        raw.executescript('''
            DROP VIEW movie_view; DROP TRIGGER delete_movie; DROP TRIGGER delete_file;
            DROP TABLE videoversion; DROP TABLE videoversiontype;''')
        raw.close()
        db = KodiVideoDb(path)
        self.assertFalse(db.has_videoversion)
        with db.transaction():
            db.upsert_movie(movie(), ART, [], None)
        db.close()
        self.assertEqual(rows(path, 'SELECT c00 FROM movie'), [{'c00': 'Heat'}])


if __name__ == '__main__':
    unittest.main()
