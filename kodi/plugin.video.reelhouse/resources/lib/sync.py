# Brings Kodi's library in line with Reelhouse: compares each item's checksum and watch state with what was last
# written, fetches details only for what changed, and writes them through KodiVideoDb. Kodi-free, so it can be
# tested on its own.
import hashlib

from .syncdb import state_key

BATCH = 100
STATES_BATCH = 1000
POSTER_WIDTH = 1000
FANART_WIDTH = 1920
THUMB_WIDTH = 1280
PROFILE_WIDTH = 300
# Children go before parents when removing, parents before children when adding.
REMOVE_ORDER = {'episode': 0, 'season': 1, 'movie': 2, 'show': 3}
COUNTED = ('movie', 'show', 'episode')


class SyncAborted(Exception):
    pass


class Syncer(object):
    def __init__(self, api, kodi, records, progress=None, aborted=None):
        self.api = api
        self.kodi = kodi
        self.records = records
        self.progress = progress or (lambda percent, message: None)
        self.aborted = aborted or (lambda: False)
        self.stats = {'added': 0, 'updated': 0, 'removed': 0, 'states': 0}

    def check_abort(self):
        if self.aborted():
            raise SyncAborted()

    # ---------- the whole library ----------

    def run(self, library_id=None):
        """Syncs every library the user can see (or just one). Returns counts of what changed."""
        libraries = self.api.libraries()['libraries']
        self.forget_if_connection_changed()
        wanted = [lib for lib in libraries if library_id is None or lib['id'] == library_id]
        for index, lib in enumerate(wanted):
            self.check_abort()
            self.sync_library(lib, index, len(wanted))
        if library_id is None:
            # Libraries that were deleted, or that this user lost access to.
            for gone in self.records.library_ids() - {lib['id'] for lib in libraries}:
                self.remove(list(self.records.for_library(gone).values()))
        self.progress(100, '')
        return self.stats

    def forget_if_connection_changed(self):
        # Artwork URLs embed the server address and this device's token: if either (or Kodi's database) changed,
        # every item has to be written again.
        signature = hashlib.sha1('|'.join([self.api.base_url, self.api.token or '', self.kodi.path]).encode('utf-8')).hexdigest()
        if self.records.meta('signature') != signature:
            self.records.forget_checksums()
            self.records.set_meta('signature', signature)

    def sync_library(self, lib, index=0, total=1):
        remote = self.api.library_items(lib['id'])
        known = self.records.for_library(lib['id'])
        present = self.kodi_presence()
        # The library's name is a tag on every item in it, so a renamed library rewrites them all.
        name_key = 'library_name.{}'.format(lib['id'])
        renamed = self.records.meta(name_key) != lib['name']
        changed, states = [], []
        for entry in remote:
            record = known.get(entry['id'])
            if renamed or not record or record['checksum'] != entry['checksum'] or not self.in_kodi(record, present):
                changed.append(entry)
            elif 'state' in entry and record['state'] != state_key(entry['state']):
                states.append((record, entry['state']))

        # Remote items come parents first (shows, seasons, episodes), and batches keep that order.
        for start in range(0, len(changed), BATCH):
            self.check_abort()
            batch = changed[start:start + BATCH]
            details = {d['id']: d for d in self.api.items([e['id'] for e in batch])}
            with self.kodi.transaction():
                for entry in batch:
                    if entry['id'] in details:
                        # A record from another library is still this item's (or one that had its id before).
                        self.write(details[entry['id']], lib, known.get(entry['id']) or self.records.get(entry['id']))
            self.records.commit()
            done = (start + len(batch)) / float(len(changed))
            self.progress(int(100 * (index + done) / total), lib['name'])

        if states:
            with self.kodi.transaction():
                for record, state in states:
                    self.kodi.set_state(record['kodi_file_id'], state, None)
                    self.records.set_state(record['id'], state)
            self.records.commit()
            self.stats['states'] += len(states)

        remote_ids = {e['id'] for e in remote}
        self.remove([r for item_id, r in known.items() if item_id not in remote_ids])
        if renamed:
            self.records.set_meta(name_key, lib['name'])

    def kodi_presence(self):
        """Which Kodi rows exist, so items removed from Kodi by hand (or a cleaned library) are written again."""
        q = self.kodi.q
        return {
            'movie': {r[0] for r in q('SELECT idMovie FROM movie')},
            'show': {r[0] for r in q('SELECT idShow FROM tvshow')},
            'season': {r[0] for r in q('SELECT idSeason FROM seasons')},
            'episode': {r[0] for r in q('SELECT idEpisode FROM episode')},
        }

    @staticmethod
    def in_kodi(record, present):
        return record.get('kodi_id') in present.get(record['type'], ())

    # ---------- one item ----------

    def art_url(self, path, width):
        return self.api.media_url(path, w=width) if path else None

    def art(self, item):
        images = item.get('images') or {}
        kind = item['type']
        if kind == 'movie':
            fanart = self.art_url(images.get('backdrop'), FANART_WIDTH)
            return {
                'poster': self.art_url(images.get('poster'), POSTER_WIDTH),
                'fanart': fanart,
                'thumb': fanart or self.art_url(images.get('thumb'), THUMB_WIDTH),
            }
        if kind == 'show':
            return {'poster': self.art_url(images.get('poster'), POSTER_WIDTH), 'fanart': self.art_url(images.get('backdrop'), FANART_WIDTH)}
        if kind == 'season':
            return {'poster': self.art_url(images.get('poster'), POSTER_WIDTH)}
        return {'thumb': self.art_url(images.get('thumb'), THUMB_WIDTH)}

    def with_cast_photos(self, item):
        cast = [{'name': c.get('name'), 'role': c.get('role'), 'thumb': self.art_url(c.get('profile'), PROFILE_WIDTH)}
                for c in item.get('cast') or []]
        return dict(item, cast=cast)

    def write(self, item, lib, record):
        kind = item['type']
        if record and record['type'] != kind:
            # The id belonged to another kind of item (Reelhouse was set up again and reused it): writing over
            # those Kodi rows would mix two items up, so they go and this one is added fresh.
            self.remove_rows(record)
            self.records.delete(record['id'])
            record = None
        tags = [lib['name']]
        art = self.art(item)
        data = self.with_cast_photos(item)
        base = {'id': item['id'], 'type': kind, 'library_id': lib['id'], 'parent_id': item.get('parentId'),
                'show_id': item.get('showId'), 'checksum': item['checksum'], 'state': state_key(item.get('state'))}
        if kind == 'movie':
            existing = (record['kodi_id'], record['kodi_file_id']) if record else None
            movie_id, file_id, path_id = self.kodi.upsert_movie(data, art, tags, existing)
            self.records.save(kodi_id=movie_id, kodi_file_id=file_id, kodi_path_id=path_id, **base)
        elif kind == 'show':
            show_id, path_id = self.kodi.upsert_show(data, art, tags, record['kodi_id'] if record else None)
            self.records.save(kodi_id=show_id, kodi_path_id=path_id, **base)
        elif kind == 'season':
            show = self.records.get(item.get('showId') or item.get('parentId'))
            if not show or show.get('kodi_id') is None:
                return  # its show failed to sync; tried again next time
            season_id = self.kodi.upsert_season(data, show['kodi_id'], art, record['kodi_id'] if record else None)
            self.records.save(kodi_id=season_id, **base)
        elif kind == 'episode':
            show = self.records.get(item.get('showId'))
            season = self.records.get(item.get('parentId'))
            if not show or not season or show.get('kodi_id') is None or season.get('kodi_id') is None:
                return
            existing = (record['kodi_id'], record['kodi_file_id']) if record else None
            episode_id, file_id = self.kodi.upsert_episode(data, show['kodi_id'], show['kodi_path_id'], season['kodi_id'], art, existing)
            self.records.save(kodi_id=episode_id, kodi_file_id=file_id, **base)
        else:
            return
        if kind in COUNTED:
            self.stats['updated' if record else 'added'] += 1

    # ---------- removal and watch state ----------

    def remove(self, records):
        if not records:
            return
        with self.kodi.transaction():
            for r in sorted(records, key=lambda r: REMOVE_ORDER.get(r['type'], 9)):
                self.remove_rows(r)
                self.records.delete(r['id'])
                if r['type'] in COUNTED:
                    self.stats['removed'] += 1
        self.records.commit()

    def remove_rows(self, r):
        """Takes one recorded item out of Kodi (inside the caller's transaction)."""
        if r['type'] == 'movie':
            self.kodi.remove_movie(r['id'])
        elif r['type'] == 'episode':
            self.kodi.remove_episode(r['id'], r['show_id'])
        elif r['type'] == 'season':
            self.kodi.remove_season(r['kodi_id'], r['show_id'] or r['parent_id'])
        elif r['type'] == 'show':
            self.kodi.remove_show(r['id'])

    def apply_states(self, item_ids):
        """After a live "state" event: refreshes play counts and resume points of these items. Returns how many changed."""
        records = {i: r for i, r in self.records.ids(item_ids).items() if r.get('kodi_file_id')}
        if not records:
            return 0
        changed = 0
        ids = list(records)
        states = []
        for start in range(0, len(ids), STATES_BATCH):  # the server answers up to 2000 at a time
            states.extend(self.api.states(ids[start:start + STATES_BATCH]))
        with self.kodi.transaction():
            for entry in states:
                record = records.get(entry['id'])
                if record and record['state'] != state_key(entry['state']):
                    self.kodi.set_state(record['kodi_file_id'], entry['state'], None)
                    self.records.set_state(record['id'], entry['state'])
                    changed += 1
        self.records.commit()
        self.stats['states'] += changed
        return changed

    def remove_all(self):
        with self.kodi.transaction():
            removed = self.kodi.remove_everything()
        self.records.clear()
        return removed
