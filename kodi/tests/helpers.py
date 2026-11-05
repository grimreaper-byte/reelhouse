# Shared test setup: imports the add-on's modules and builds a Kodi 21 video database from the fixture schema.
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'plugin.video.reelhouse'))

SCHEMA = os.path.join(HERE, 'fixtures', 'myvideos131.sql')


def kodi_database(directory=None):
    """A fresh MyVideos131.db (Kodi 21's layout, exported from a real install) in a temp folder."""
    directory = directory or tempfile.mkdtemp(prefix='rh-kodi-')
    path = os.path.join(directory, 'MyVideos131.db')
    db = sqlite3.connect(path)
    with open(SCHEMA, encoding='utf-8') as f:
        db.executescript(f.read())
    db.close()
    return path


def rows(path, sql, *args):
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in db.execute(sql, args)]
    finally:
        db.close()


def movie(item_id=1, **over):
    item = {
        'id': item_id, 'type': 'movie', 'libraryId': 1, 'title': 'Heat', 'originalTitle': 'Heat (Original)', 'year': 1995,
        'premiered': '1995-12-15', 'overview': 'A crime saga.', 'tagline': 'A Los Angeles crime saga', 'contentRating': 'R',
        'rating': 7.9, 'genres': ['Crime', 'Drama'], 'directors': ['Michael Mann'], 'studio': 'Regency',
        'cast': [{'name': 'Al Pacino', 'role': 'Vincent Hanna', 'thumb': 'http://rh/al.jpg'}, {'name': 'Robert De Niro', 'role': 'Neil McCauley'}],
        'tmdbId': 949, 'imdbId': 'tt0113277', 'duration': 10200.5, 'addedAt': 1700000000000, 'checksum': '1',
        'images': {'poster': '/api/images/1/poster?v=1', 'backdrop': '/api/images/1/backdrop?v=1', 'thumb': '/api/images/1/thumb?v=1'},
        'streams': {
            'video': {'codec': 'hevc', 'width': 3840, 'height': 2160, 'aspect': 1.777778, 'hdr': 'HDR10'},
            'audio': [{'codec': 'truehd', 'channels': 8, 'language': 'eng'}, {'codec': 'ac3', 'channels': 6, 'language': 'fre'}],
            'subtitles': [{'language': 'eng'}],
        },
        'state': {'watched': False, 'viewCount': 0, 'position': 0, 'updatedAt': None},
    }
    item.update(over)
    return item


def show(item_id=10, **over):
    item = {
        'id': item_id, 'type': 'show', 'libraryId': 2, 'title': 'Breaking Bad', 'year': 2008, 'premiered': '2008-01-20',
        'overview': 'A teacher turns to crime.', 'contentRating': 'TV-MA', 'rating': 8.9, 'genres': ['Drama'], 'studio': 'AMC',
        'cast': [{'name': 'Bryan Cranston', 'role': 'Walter White'}], 'tmdbId': 1396, 'imdbId': 'tt0903747',
        'addedAt': 1700000000000, 'checksum': '1', 'images': {'poster': '/api/images/10/poster?v=1', 'backdrop': '/api/images/10/backdrop?v=1'},
    }
    item.update(over)
    return item


def season(item_id=11, show_id=10, number=1, **over):
    item = {'id': item_id, 'type': 'season', 'libraryId': 2, 'parentId': show_id, 'showId': show_id, 'title': 'Season {}'.format(number),
            'seasonNumber': number, 'checksum': '1', 'images': {'poster': '/api/images/{}/poster?v=1'.format(item_id)}}
    item.update(over)
    return item


def episode(item_id=12, season_id=11, show_id=10, number=1, **over):
    item = {
        'id': item_id, 'type': 'episode', 'libraryId': 2, 'parentId': season_id, 'showId': show_id, 'title': 'Pilot',
        'seasonNumber': 1, 'episodeNumber': number, 'airDate': '2008-01-20', 'overview': 'Walter is diagnosed.', 'rating': 8.2,
        'tmdbId': 62085, 'duration': 3480, 'addedAt': 1700000100000, 'checksum': '1', 'cast': [],
        'images': {'poster': '/api/images/{}/poster?v=1'.format(item_id), 'thumb': '/api/images/{}/thumb?v=1'.format(item_id)},
        'streams': {'video': {'codec': 'h264', 'width': 1920, 'height': 1080, 'aspect': 1.777778}, 'audio': [{'codec': 'aac', 'channels': 2, 'language': 'eng'}], 'subtitles': []},
        'state': {'watched': False, 'viewCount': 0, 'position': 0, 'updatedAt': None},
    }
    item.update(over)
    return item
