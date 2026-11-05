# The add-on's own records: which Kodi rows belong to which Reelhouse item, with the checksum and watch state
# last written, so a sync only touches what changed. Lives in the add-on's profile folder.
import json
import sqlite3

SCHEMA = '''
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,        -- Reelhouse item id
  type TEXT NOT NULL,            -- movie | show | season | episode
  library_id INTEGER,
  parent_id INTEGER,             -- Reelhouse parent (season of an episode, show of a season)
  show_id INTEGER,
  kodi_id INTEGER,               -- idMovie / idShow / idSeason / idEpisode
  kodi_file_id INTEGER,          -- idFile (movies, episodes)
  kodi_path_id INTEGER,          -- idPath of a show's folder
  checksum TEXT,
  state TEXT                     -- watch state JSON as last written to Kodi
);
CREATE INDEX IF NOT EXISTS items_kodi ON items (type, kodi_id);
CREATE INDEX IF NOT EXISTS items_library ON items (library_id);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
'''

FIELDS = ('id', 'type', 'library_id', 'parent_id', 'show_id', 'kodi_id', 'kodi_file_id', 'kodi_path_id', 'checksum', 'state')
KODI_TYPES = {'movie': 'movie', 'tvshow': 'show', 'season': 'season', 'episode': 'episode'}


def state_key(state):
    """A stable string for a watch state, to tell whether it changed."""
    state = state or {}
    return json.dumps([bool(state.get('watched')), int(state.get('viewCount') or 0), round(float(state.get('position') or 0))])


class SyncDb(object):
    def __init__(self, path):
        self.conn = sqlite3.connect(path, timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)

    def close(self):
        self.conn.close()

    def commit(self):
        self.conn.commit()

    def get(self, item_id):
        row = self.conn.execute('SELECT * FROM items WHERE id = ?', (int(item_id),)).fetchone()
        return dict(row) if row else None

    def by_kodi(self, kodi_type, kodi_id):
        """The Reelhouse record behind a Kodi library item ("movie", "tvshow", "season", "episode")."""
        kind = KODI_TYPES.get(kodi_type)
        row = self.conn.execute('SELECT * FROM items WHERE type = ? AND kodi_id = ?', (kind, int(kodi_id))).fetchone() if kind else None
        return dict(row) if row else None

    def for_library(self, library_id):
        return {r['id']: dict(r) for r in self.conn.execute('SELECT * FROM items WHERE library_id = ?', (library_id,))}

    def library_ids(self):
        return {r[0] for r in self.conn.execute('SELECT DISTINCT library_id FROM items')}

    def ids(self, item_ids):
        out = {}
        item_ids = [int(i) for i in item_ids]
        for i in range(0, len(item_ids), 500):
            chunk = item_ids[i:i + 500]
            sql = 'SELECT * FROM items WHERE id IN ({})'.format(','.join('?' * len(chunk)))
            for r in self.conn.execute(sql, chunk):
                out[r['id']] = dict(r)
        return out

    def save(self, **record):
        values = [record.get(f) for f in FIELDS]
        self.conn.execute(
            'INSERT OR REPLACE INTO items ({}) VALUES ({})'.format(', '.join(FIELDS), ', '.join('?' * len(FIELDS))), values)

    def set_state(self, item_id, state):
        self.conn.execute('UPDATE items SET state = ? WHERE id = ?', (state_key(state), int(item_id)))

    def delete(self, item_id):
        self.conn.execute('DELETE FROM items WHERE id = ?', (int(item_id),))

    def clear(self):
        self.conn.execute('DELETE FROM items')
        self.conn.commit()

    def forget_checksums(self):
        """Makes the next sync rewrite every item (e.g. after the server address or sign-in changed)."""
        self.conn.execute('UPDATE items SET checksum = NULL')
        self.conn.commit()

    def count(self):
        return self.conn.execute('SELECT COUNT(*) FROM items').fetchone()[0]

    def meta(self, key, default=None):
        row = self.conn.execute('SELECT value FROM meta WHERE key = ?', (key,)).fetchone()
        return row[0] if row else default

    def set_meta(self, key, value):
        self.conn.execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', (key, value))
        self.conn.commit()
