# Writes Reelhouse items straight into Kodi's video database (MyVideos<NN>.db), laid out the way Kodi's own
# scanner lays them out (checked against rows Kodi 21 writes for movie/tvshow/episode .nfo files), so skins,
# widgets, smart playlists and JSON-RPC all treat them as ordinary library items.
#
# Every item points at a plugin:// path of this add-on; playing it asks the add-on for the stream URL.
import glob
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from xml.sax.saxutils import escape

ADDON_PATH = 'plugin://plugin.video.reelhouse/'
MOVIES_PATH = ADDON_PATH + 'movies/'
SHOWS_PATH = ADDON_PATH + 'tvshows/'
MIN_VERSION = 119            # Kodi 19 "Matrix"
DEFAULT_VERSION_TYPE = 40400  # Kodi 21's built-in "Standard Edition" video version
SCRAPER = 'metadata.local'    # "Local information only": Kodi never tries to scrape these paths
REQUIRED_TABLES = {
    'path', 'files', 'movie', 'tvshow', 'tvshowlinkpath', 'seasons', 'episode', 'art', 'actor', 'actor_link',
    'director_link', 'writer_link', 'genre', 'genre_link', 'studio', 'studio_link', 'country', 'country_link',
    'tag', 'tag_link', 'rating', 'uniqueid', 'bookmark', 'streamdetails',
}


class KodiDbError(Exception):
    pass


def find_database(database_dir):
    """The newest MyVideos database (older ones stay behind after Kodi upgrades). Returns (path, version)."""
    found = []
    for path in glob.glob(os.path.join(database_dir, 'MyVideos*.db')):
        match = re.match(r'MyVideos(\d+)\.db$', os.path.basename(path))
        if match:
            found.append((int(match.group(1)), path))
    if not found:
        raise KodiDbError('no video database (MyVideos*.db) in {}'.format(database_dir))
    version, path = max(found)
    if version < MIN_VERSION:
        raise KodiDbError('video database version {} is too old; Kodi 19 or newer is needed'.format(version))
    return path, version


def play_url(folder, item_id):
    # For plugin:// folders Kodi uses files.strFilename as the whole path (it doesn't join it to the folder),
    # so the filename is the full URL Kodi calls to play the item.
    return '{}?mode=play&id={}'.format(folder, int(item_id))


def show_path(show_item_id):
    """The folder a show and its episodes live in."""
    return '{}{}/'.format(SHOWS_PATH, int(show_item_id))


def kodi_time(ms):
    """Reelhouse timestamps (ms) as Kodi's local "YYYY-MM-DD HH:MM:SS"."""
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ms / 1000.0)) if ms else None


def premiered(item):
    date = item.get('premiered') or item.get('airDate')
    if date and re.match(r'^\d{4}-\d{2}-\d{2}', date):
        return date[:10]
    return '{}-01-01'.format(item['year']) if item.get('year') else None


def thumb_xml(url, aspect=None, season=None):
    if not url:
        return ''
    attrs = ''
    if aspect:
        attrs += ' aspect="{}"'.format(aspect)
    if season is not None:
        attrs += ' type="season" season="{}"'.format(int(season))
    return '<thumb{}>{}</thumb>'.format(attrs, escape(url))


def fanart_xml(url):
    return '<fanart>{}</fanart>'.format(thumb_xml(url)) if url else ''


def unique(values):
    seen = set()
    out = []
    for v in values:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


class KodiVideoDb(object):
    def __init__(self, path):
        self.path = path
        # Kodi keeps the database open too: wait for its locks rather than failing.
        self.conn = sqlite3.connect(path, timeout=60, isolation_level=None)
        tables = {r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        missing = REQUIRED_TABLES - tables
        if missing:
            raise KodiDbError('unexpected video database layout (missing {})'.format(', '.join(sorted(missing))))
        self.has_videoversion = 'videoversion' in tables
        self.stream_columns = {r[1] for r in self.conn.execute('PRAGMA table_info(streamdetails)')}
        self.version_type = None
        if self.has_videoversion:
            self.version_type = self.one('SELECT id FROM videoversiontype WHERE id = ?', DEFAULT_VERSION_TYPE) \
                or self.one('SELECT MIN(id) FROM videoversiontype WHERE itemType = 0') or DEFAULT_VERSION_TYPE

    def close(self):
        self.conn.close()

    @contextmanager
    def transaction(self):
        # Short write transactions, so Kodi's own reads are never blocked for long.
        self.conn.execute('BEGIN IMMEDIATE')
        try:
            yield self
        except BaseException:
            self.conn.execute('ROLLBACK')
            raise
        self.conn.execute('COMMIT')

    # ---------- small helpers ----------

    def q(self, sql, *args):
        return self.conn.execute(sql, args)

    def one(self, sql, *args):
        row = self.conn.execute(sql, args).fetchone()
        return row[0] if row else None

    def exists(self, table, column, value):
        return value is not None and self.one('SELECT 1 FROM {} WHERE {} = ?'.format(table, column), value) is not None

    def path_id(self, path, parent_id=None, content=None):
        path_id = self.one('SELECT idPath FROM path WHERE strPath = ?', path)
        if path_id is None:
            path_id = self.q(
                'INSERT INTO path (strPath, strContent, strScraper, scanRecursive, useFolderNames, noUpdate, exclude, '
                'allAudio, dateAdded, idParentPath) VALUES (?, ?, ?, 0, 0, 1, 0, 0, ?, ?)',
                path, content, SCRAPER if content else None, kodi_time(time.time() * 1000), parent_id,
            ).lastrowid
        return path_id

    def file_id(self, path_id, filename, date_added, existing=None):
        if existing is not None and self.exists('files', 'idFile', existing):
            self.q('UPDATE files SET idPath = ?, strFilename = ?, dateAdded = ? WHERE idFile = ?', path_id, filename, date_added, existing)
            return existing
        file_id = self.one('SELECT idFile FROM files WHERE idPath = ? AND strFilename = ?', path_id, filename)
        if file_id is None:
            return self.q('INSERT INTO files (idPath, strFilename, dateAdded) VALUES (?, ?, ?)', path_id, filename, date_added).lastrowid
        self.q('UPDATE files SET dateAdded = ? WHERE idFile = ?', date_added, file_id)
        return file_id

    # ---------- watch state ----------

    def set_state(self, file_id, state, duration):
        """Play count, last played and resume point, from Reelhouse's watch state for this user."""
        state = state or {}
        watched = bool(state.get('watched'))
        position = float(state.get('position') or 0)
        playcount = max(int(state.get('viewCount') or 0), 1) if watched else None
        last = kodi_time(state.get('updatedAt')) if (watched or position) else None
        self.q('UPDATE files SET playCount = ?, lastPlayed = ? WHERE idFile = ?', playcount, last, file_id)
        self.q('DELETE FROM bookmark WHERE idFile = ? AND type = 1', file_id)
        if position > 0 and not watched:
            if not duration:
                duration = self.one('SELECT iVideoDuration FROM streamdetails WHERE idFile = ? AND iStreamType = 0', file_id) or 0
            self.q(
                'INSERT INTO bookmark (idFile, timeInSeconds, totalTimeInSeconds, thumbNailImage, player, playerState, type) '
                "VALUES (?, ?, ?, NULL, 'VideoPlayer', '', 1)",
                file_id, position, float(duration or 0),
            )

    # ---------- shared metadata ----------

    def set_art(self, media_id, media_type, art):
        self.q('DELETE FROM art WHERE media_id = ? AND media_type = ?', media_id, media_type)
        for kind, url in art.items():
            if url:
                self.q('INSERT INTO art (media_id, media_type, type, url) VALUES (?, ?, ?, ?)', media_id, media_type, kind, url)

    def person_id(self, name, thumb=None):
        person_id = self.one('SELECT actor_id FROM actor WHERE name = ?', name)
        if person_id is None:
            person_id = self.q('INSERT INTO actor (name, art_urls) VALUES (?, ?)', name, thumb_xml(thumb) or None).lastrowid
        elif thumb:
            self.q('UPDATE actor SET art_urls = ? WHERE actor_id = ?', thumb_xml(thumb), person_id)
        if thumb:
            self.set_art(person_id, 'actor', {'thumb': thumb})
        return person_id

    def set_cast(self, media_id, media_type, cast):
        self.q('DELETE FROM actor_link WHERE media_id = ? AND media_type = ?', media_id, media_type)
        seen = set()
        for order, person in enumerate(cast or []):
            name = (person.get('name') or '').strip()
            role = person.get('role') or ''
            if not name or (name, role) in seen:
                continue
            seen.add((name, role))
            self.q(
                'INSERT OR IGNORE INTO actor_link (actor_id, media_id, media_type, role, cast_order) VALUES (?, ?, ?, ?, ?)',
                self.person_id(name, person.get('thumb')), media_id, media_type, role, order,
            )

    def set_crew(self, table, media_id, media_type, names):
        """Directors (director_link) or writers (writer_link): people from the actor table."""
        self.q('DELETE FROM {} WHERE media_id = ? AND media_type = ?'.format(table), media_id, media_type)
        for name in unique((n or "").strip() for n in names or []):
            self.q('INSERT OR IGNORE INTO {} (actor_id, media_id, media_type) VALUES (?, ?, ?)'.format(table),
                   self.person_id(name), media_id, media_type)

    def set_links(self, kind, media_id, media_type, names):
        """genre, studio, country or tag links (the tables are named after the kind)."""
        self.q('DELETE FROM {}_link WHERE media_id = ? AND media_type = ?'.format(kind), media_id, media_type)
        for name in unique((n or "").strip() for n in names or []):
            link_id = self.one('SELECT {0}_id FROM {0} WHERE name = ?'.format(kind), name)
            if link_id is None:
                link_id = self.q('INSERT INTO {} (name) VALUES (?)'.format(kind), name).lastrowid
            self.q('INSERT OR IGNORE INTO {0}_link ({0}_id, media_id, media_type) VALUES (?, ?, ?)'.format(kind),
                   link_id, media_id, media_type)

    def set_rating(self, media_id, media_type, rating):
        self.q('DELETE FROM rating WHERE media_id = ? AND media_type = ?', media_id, media_type)
        if rating is None:
            return None
        return self.q(
            "INSERT INTO rating (media_id, media_type, rating_type, rating, votes) VALUES (?, ?, 'themoviedb', ?, 0)",
            media_id, media_type, float(rating),
        ).lastrowid

    def set_uniqueids(self, media_id, media_type, ids):
        """ids: [(type, value), ...], the first present one being the default. Returns the default's row id."""
        self.q('DELETE FROM uniqueid WHERE media_id = ? AND media_type = ?', media_id, media_type)
        default = None
        for kind, value in ids:
            if value:
                row_id = self.q('INSERT INTO uniqueid (media_id, media_type, value, type) VALUES (?, ?, ?, ?)',
                                media_id, media_type, str(value), kind).lastrowid
                default = default or row_id
        return default

    def set_streams(self, file_id, streams, duration):
        self.q('DELETE FROM streamdetails WHERE idFile = ?', file_id)
        if not streams:
            return

        def insert(values):
            cols = [c for c in values if c in self.stream_columns]
            self.q('INSERT INTO streamdetails ({}) VALUES ({})'.format(', '.join(cols), ', '.join('?' * len(cols))),
                   *[values[c] for c in cols])

        video = streams.get('video')
        if video:
            insert({
                'idFile': file_id, 'iStreamType': 0, 'strVideoCodec': video.get('codec'), 'fVideoAspect': video.get('aspect'),
                'iVideoWidth': video.get('width'), 'iVideoHeight': video.get('height'), 'iVideoDuration': int(duration or 0),
                'strHdrType': HDR_TYPES.get(video.get('hdr') or '', ''),
            })
        for audio in streams.get('audio') or []:
            insert({'idFile': file_id, 'iStreamType': 1, 'strAudioCodec': audio.get('codec'),
                    'iAudioChannels': audio.get('channels'), 'strAudioLanguage': audio.get('language') or ''})
        for sub in streams.get('subtitles') or []:
            insert({'idFile': file_id, 'iStreamType': 2, 'strSubtitleLanguage': sub.get('language') or ''})

    # ---------- movies ----------

    def upsert_movie(self, item, art, tags=(), existing=None):
        """Adds or updates a movie. existing: (idMovie, idFile) from an earlier sync. Returns (idMovie, idFile, idPath)."""
        existing = existing or (None, None)
        path_id = self.path_id(MOVIES_PATH, None, 'movies')
        file_id = self.file_id(path_id, play_url(MOVIES_PATH, item['id']), kodi_time(item.get('addedAt')), existing[1])
        movie_id = existing[0] if self.exists('movie', 'idMovie', existing[0]) else None
        if movie_id is None:
            # Already in Kodi without a record of it (the add-on's records were lost): update it, don't add it twice.
            movie_id = self.one('SELECT idMovie FROM movie WHERE idFile = ?', file_id)
        columns = {
            'idFile': file_id,
            'c00': item.get('title') or '',
            'c01': item.get('overview') or '',
            'c02': '',
            'c03': item.get('tagline') or '',
            'c06': '',
            'c08': thumb_xml(art.get('poster'), 'poster'),
            'c10': '',
            'c11': str(int(item.get('duration') or 0)),
            'c12': item.get('contentRating') or '',
            'c14': ' / '.join(item.get('genres') or []),
            'c15': ' / '.join(item.get('directors') or []),
            'c16': item.get('originalTitle') or '',
            'c18': item.get('studio') or '',
            'c20': fanart_xml(art.get('fanart')),
            'c21': '',
            'c22': MOVIES_PATH,
            'c23': str(path_id),
            'premiered': premiered(item),
        }
        movie_id = self._save('movie', 'idMovie', movie_id, columns)
        rating_id = self.set_rating(movie_id, 'movie', item.get('rating'))
        uid = self.set_uniqueids(movie_id, 'movie', [('tmdb', item.get('tmdbId')), ('imdb', item.get('imdbId')), ('reelhouse', item['id'])])
        self.q('UPDATE movie SET c05 = ?, c09 = ? WHERE idMovie = ?', rating_id, uid, movie_id)
        self.set_art(movie_id, 'movie', art)
        self.set_cast(movie_id, 'movie', item.get('cast'))
        self.set_crew('director_link', movie_id, 'movie', item.get('directors'))
        self.set_links('genre', movie_id, 'movie', item.get('genres'))
        self.set_links('studio', movie_id, 'movie', [item.get('studio')])
        self.set_links('tag', movie_id, 'movie', tags)
        self.set_streams(file_id, item.get('streams'), item.get('duration'))
        self.set_state(file_id, item.get('state'), item.get('duration'))
        if self.has_videoversion:
            # Kodi 21 lists a movie only through its video version (movie_view joins on it).
            self.q('INSERT OR REPLACE INTO videoversion (idFile, idMedia, media_type, itemType, idType) VALUES (?, ?, ?, 0, ?)',
                   file_id, movie_id, 'movie', self.version_type)
        return movie_id, file_id, path_id

    # Removals find rows by this add-on's own play URLs and folders, never by a remembered Kodi id alone: Kodi
    # reuses ids, so an outdated record must not be able to delete some other item's rows. Kodi's triggers
    # remove the links, art, ratings, ids, versions, bookmarks and stream details.

    def remove_movie(self, item_id):
        filename = play_url(MOVIES_PATH, item_id)
        self.q('DELETE FROM movie WHERE idFile IN (SELECT idFile FROM files WHERE strFilename = ?)', filename)
        self.q('DELETE FROM files WHERE strFilename = ?', filename)

    # ---------- TV ----------

    def upsert_show(self, item, art, tags=(), existing=None):
        """Returns (idShow, idPath of the show's folder)."""
        root_id = self.path_id(SHOWS_PATH, None, 'tvshows')
        path_id = self.path_id(show_path(item['id']), root_id)
        show_id = existing if self.exists('tvshow', 'idShow', existing) else None
        if show_id is None:
            show_id = self.one('SELECT idShow FROM tvshowlinkpath WHERE idPath = ?', path_id)
        columns = {
            'c00': item.get('title') or '',
            'c01': item.get('overview') or '',
            'c02': '',
            'c05': premiered(item),
            'c06': thumb_xml(art.get('poster'), 'poster'),
            'c08': ' / '.join(item.get('genres') or []),
            'c09': item.get('originalTitle') or '',
            'c11': fanart_xml(art.get('fanart')),
            'c13': item.get('contentRating') or '',
            'c14': item.get('studio') or '',
            'c15': '',
        }
        show_id = self._save('tvshow', 'idShow', show_id, columns)
        self.q('DELETE FROM tvshowlinkpath WHERE idShow = ?', show_id)
        self.q('INSERT OR IGNORE INTO tvshowlinkpath (idShow, idPath) VALUES (?, ?)', show_id, path_id)
        rating_id = self.set_rating(show_id, 'tvshow', item.get('rating'))
        uid = self.set_uniqueids(show_id, 'tvshow', [('tmdb', item.get('tmdbId')), ('imdb', item.get('imdbId')), ('reelhouse', item['id'])])
        self.q('UPDATE tvshow SET c04 = ?, c12 = ? WHERE idShow = ?', rating_id, uid, show_id)
        self.set_art(show_id, 'tvshow', art)
        self.set_cast(show_id, 'tvshow', item.get('cast'))
        self.set_links('genre', show_id, 'tvshow', item.get('genres'))
        self.set_links('studio', show_id, 'tvshow', [item.get('studio')])
        self.set_links('tag', show_id, 'tvshow', tags)
        # The "All seasons" entry Kodi shows above a show's seasons.
        if self.one('SELECT 1 FROM seasons WHERE idShow = ? AND season = -1', show_id) is None:
            self.q('INSERT INTO seasons (idShow, season) VALUES (?, -1)', show_id)
        return show_id, path_id

    def upsert_season(self, item, show_id, art, existing=None):
        number = int(item.get('seasonNumber') or 0)
        # The show's row for this season number comes first, so a season is never added twice; the earlier row
        # is used when the season was renumbered.
        season_id = self.one('SELECT idSeason FROM seasons WHERE idShow = ? AND season = ?', show_id, number)
        if season_id is None and self.exists('seasons', 'idSeason', existing):
            season_id = existing
        default_name = 'Specials' if number == 0 else 'Season {}'.format(number)
        name = item.get('title') if item.get('title') and item.get('title') != default_name else None
        if season_id is None:
            season_id = self.q('INSERT INTO seasons (idShow, season, name) VALUES (?, ?, ?)', show_id, number, name).lastrowid
        else:
            self.q('UPDATE seasons SET idShow = ?, season = ?, name = ? WHERE idSeason = ?', show_id, number, name, season_id)
        self.set_art(season_id, 'season', art)
        return season_id

    def upsert_episode(self, item, show_id, show_path_id, season_id, art, existing=None):
        """existing: (idEpisode, idFile). Returns (idEpisode, idFile)."""
        existing = existing or (None, None)
        show_path = self.one('SELECT strPath FROM path WHERE idPath = ?', show_path_id)
        filename = play_url(show_path, item['id'])
        file_id = self.file_id(show_path_id, filename, kodi_time(item.get('addedAt')), existing[1])
        episode_id = existing[0] if self.exists('episode', 'idEpisode', existing[0]) else None
        if episode_id is None:
            episode_id = self.one('SELECT idEpisode FROM episode WHERE idFile = ?', file_id)
        columns = {
            'idFile': file_id,
            'c00': item.get('title') or '',
            'c01': item.get('overview') or '',
            'c04': '',
            'c05': (item.get('airDate') or '')[:10],
            'c06': thumb_xml(art.get('thumb')),
            'c09': str(int(item.get('duration') or 0)),
            'c10': '',
            'c12': str(int(item.get('seasonNumber') or 0)),
            'c13': str(int(item.get('episodeNumber') or 0)),
            'c14': item.get('originalTitle') or '',
            'c15': '-1',
            'c16': '-1',
            'c17': '-1',
            'c18': filename,
            'c19': str(show_path_id),
            'idShow': show_id,
            'idSeason': season_id,
        }
        episode_id = self._save('episode', 'idEpisode', episode_id, columns)
        rating_id = self.set_rating(episode_id, 'episode', item.get('rating'))
        uid = self.set_uniqueids(episode_id, 'episode', [('tmdb', item.get('tmdbId')), ('reelhouse', item['id'])])
        self.q('UPDATE episode SET c03 = ?, c20 = ? WHERE idEpisode = ?', rating_id, uid, episode_id)
        self.set_art(episode_id, 'episode', art)
        self.set_cast(episode_id, 'episode', item.get('cast'))
        self.set_crew('director_link', episode_id, 'episode', item.get('directors'))
        self.set_streams(file_id, item.get('streams'), item.get('duration'))
        self.set_state(file_id, item.get('state'), item.get('duration'))
        return episode_id, file_id

    def remove_episode(self, item_id, show_item_id):
        if show_item_id is None:
            return
        filename = play_url(show_path(show_item_id), item_id)
        self.q('DELETE FROM episode WHERE idFile IN (SELECT idFile FROM files WHERE strFilename = ?)', filename)
        self.q('DELETE FROM files WHERE strFilename = ?', filename)

    def show_ids(self, show_item_id):
        """Kodi's idShow for a Reelhouse show, found through the show's folder."""
        return [r[0] for r in self.q(
            'SELECT idShow FROM tvshowlinkpath WHERE idPath IN (SELECT idPath FROM path WHERE strPath = ?)', show_path(show_item_id))]

    def remove_season(self, season_id, show_item_id):
        # Only while that season row still belongs to the show it was written for.
        if season_id is None or show_item_id is None:
            return
        for show_id in self.show_ids(show_item_id):
            self.q('DELETE FROM seasons WHERE idSeason = ? AND idShow = ?', season_id, show_id)

    def remove_show(self, item_id):
        """The show with all its seasons and episodes."""
        folder = show_path(item_id)
        for show_id in self.show_ids(item_id):
            self.q('DELETE FROM episode WHERE idShow = ?', show_id)
            self.q('DELETE FROM tvshow WHERE idShow = ?', show_id)
        self.q('DELETE FROM files WHERE idPath IN (SELECT idPath FROM path WHERE strPath = ?)', folder)
        self.q('DELETE FROM path WHERE strPath = ?', folder)

    def remove_everything(self):
        """Removes every item this add-on ever added, found by its plugin:// paths (works without the add-on's own records)."""
        like = ADDON_PATH + '%'
        files = 'SELECT idFile FROM files WHERE idPath IN (SELECT idPath FROM path WHERE strPath LIKE ?)'
        removed = self.one('SELECT COUNT(*) FROM movie WHERE idFile IN ({})'.format(files), like) or 0
        removed += self.one('SELECT COUNT(*) FROM episode WHERE idFile IN ({})'.format(files), like) or 0
        self.q('DELETE FROM movie WHERE idFile IN ({})'.format(files), like)
        self.q('DELETE FROM episode WHERE idFile IN ({})'.format(files), like)
        shows = [r[0] for r in self.q(
            'SELECT idShow FROM tvshowlinkpath WHERE idPath IN (SELECT idPath FROM path WHERE strPath LIKE ?)', like)]
        for show_id in shows:
            self.q('DELETE FROM tvshow WHERE idShow = ?', show_id)
        removed += len(shows)
        self.q('DELETE FROM files WHERE idPath IN (SELECT idPath FROM path WHERE strPath LIKE ?)', like)
        self.q('DELETE FROM path WHERE strPath LIKE ?', like)
        return removed

    # ---------- internals ----------

    def _save(self, table, key, row_id, columns):
        names = list(columns)
        if row_id is None:
            return self.q('INSERT INTO {} ({}) VALUES ({})'.format(table, ', '.join(names), ', '.join('?' * len(names))),
                          *[columns[n] for n in names]).lastrowid
        self.q('UPDATE {} SET {} WHERE {} = ?'.format(table, ', '.join('{} = ?'.format(n) for n in names), key),
               *([columns[n] for n in names] + [row_id]))
        return row_id


# Reelhouse's HDR labels as Kodi's stream detail values.
HDR_TYPES = {'HDR10': 'hdr10', 'HDR10+': 'hdr10', 'DV': 'dolbyvision', 'HLG': 'hlg'}
