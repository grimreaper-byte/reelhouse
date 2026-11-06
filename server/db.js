import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './lib/paths.js';

let db;
const stmtCache = new Map();

const MIGRATIONS = [
  // v1: initial schema
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE users (
    id             INTEGER PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT NOT NULL,
    is_admin       INTEGER NOT NULL DEFAULT 0,
    library_access TEXT,              -- JSON array of library ids; NULL = all libraries
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE libraries (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('movie', 'show')),
    paths      TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    scanned_at INTEGER
  );

  CREATE TABLE items (
    id             INTEGER PRIMARY KEY,
    library_id     INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    type           TEXT NOT NULL CHECK (type IN ('movie', 'show', 'season', 'episode')),
    parent_id      INTEGER REFERENCES items(id) ON DELETE CASCADE,
    show_id        INTEGER REFERENCES items(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    sort_title     TEXT NOT NULL,
    original_title TEXT,
    year           INTEGER,
    overview       TEXT,
    tagline        TEXT,
    season_number  INTEGER,
    episode_number INTEGER,
    episode_end    INTEGER,
    air_date       TEXT,
    rating         REAL,
    content_rating TEXT,
    genres         TEXT,              -- JSON array
    cast_json      TEXT,              -- JSON array of {name, role, profile}
    directors      TEXT,              -- JSON array
    studio         TEXT,
    poster         TEXT,              -- image ref: "file:<path>" | "tmdb:<path>"
    backdrop       TEXT,
    thumb          TEXT,
    tmdb_id        INTEGER,
    imdb_id        TEXT,
    match_locked   INTEGER NOT NULL DEFAULT 0,
    metadata_at    INTEGER,
    folder_path    TEXT,              -- show/season folder (identity key for shows)
    file_path      TEXT,
    file_size      INTEGER,
    file_mtime     INTEGER,
    duration       REAL,
    bitrate        INTEGER,
    container      TEXT,
    video_codec    TEXT,
    width          INTEGER,
    height         INTEGER,
    audio_codec    TEXT,
    media_json     TEXT,              -- ffprobe summary
    subs_json      TEXT,              -- external subtitle files
    added_at       INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX items_file ON items(library_id, file_path) WHERE file_path IS NOT NULL;
  CREATE INDEX items_lib_type ON items(library_id, type);
  CREATE INDEX items_parent ON items(parent_id);
  CREATE INDEX items_show ON items(show_id);
  CREATE INDEX items_added ON items(added_at);

  CREATE TABLE user_state (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    position   REAL NOT NULL DEFAULT 0,
    watched    INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
  CREATE INDEX user_state_recent ON user_state(user_id, updated_at);
  `,
  // v2: "Recently Added" hubs sort a library's episodes/movies by date.
  `
  CREATE INDEX items_lib_type_added ON items(library_id, type, added_at);
  `,
  // v3: local .nfo metadata is remembered per item, so rescans notice new/edited/removed NFO files
  // and online metadata refreshes can keep the NFO's values on top.
  `
  ALTER TABLE items ADD COLUMN nfo_json TEXT;      -- column values the item's .nfo sets (JSON object)
  ALTER TABLE items ADD COLUMN nfo_mtime INTEGER;  -- that .nfo's modified time; NULL = no .nfo
  `,
  // v4: artwork an admin picked by hand ({"poster": ref, "backdrop": ref, "thumb": ref}); refreshes keep it.
  `
  ALTER TABLE items ADD COLUMN art_json TEXT;
  `,
  // v5: sessions signed in from an app (e.g. the Kodi add-on) carry the device's name and last much longer.
  `
  ALTER TABLE sessions ADD COLUMN device TEXT;
  `,
  // v6: pairing the Reelhouse app (one-time codes) and each paired device's key for the built-in app tunnel.
  `
  CREATE TABLE tunnel_peers (
    id             TEXT PRIMARY KEY,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    public_key     TEXT NOT NULL UNIQUE,
    preshared_key  TEXT NOT NULL,
    address        TEXT NOT NULL UNIQUE,
    created_at     INTEGER NOT NULL,
    pending_until  INTEGER            -- set until a pairing is used; the key is dropped if it never is
  );
  CREATE TABLE pairings (
    code_hash    TEXT PRIMARY KEY,
    id           TEXT NOT NULL UNIQUE,  -- a handle for the pairing screen to follow it (not the code)
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    tunnel_peer  TEXT REFERENCES tunnel_peers(id) ON DELETE SET NULL,
    used_at      INTEGER,               -- kept until it expires, so the pairing screen sees it being used
    device       TEXT
  );
  ALTER TABLE sessions ADD COLUMN tunnel_peer TEXT REFERENCES tunnel_peers(id) ON DELETE SET NULL;
  `,
  // v7: Home's "Watched by Others" row; anyone can keep what they watch out of it.
  `
  ALTER TABLE users ADD COLUMN share_watching INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX user_state_updated ON user_state(updated_at);
  `,
  // v8: the picture someone chose for their account (server/avatars.js keeps it in avatars/<id>.jpg).
  `
  ALTER TABLE users ADD COLUMN avatar_at INTEGER; -- when it was last set; NULL = no picture
  `,
  // v9: how many devices someone may play on at once, set by an admin (server/activity.js enforces it). Everyone,
  // existing accounts included, starts at 2.
  `
  ALTER TABLE users ADD COLUMN stream_limit INTEGER DEFAULT 2; -- NULL = no limit
  `,
  // v10: Live TV from Tvheadend, per account (admins can always): watching it, on for everyone to start with, and
  // scheduling recordings, off until an admin allows it.
  `
  ALTER TABLE users ADD COLUMN live_tv INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE users ADD COLUMN live_tv_record INTEGER NOT NULL DEFAULT 0;
  `,
  // v11: the libraries' order, set in Settings → Libraries (the sidebar, Home and the apps list them so). Existing
  // libraries keep the order they had, by name.
  `
  ALTER TABLE libraries ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  UPDATE libraries SET position = (
    SELECT n FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY name COLLATE NOCASE, id) - 1 AS n FROM libraries) o
     WHERE o.id = libraries.id);
  `,
  // v12: copies of one film in a library (an SD and an HD file) shown as one: the others point at the best copy
  // (server/versions.js). Filled in when the server starts and after each scan.
  `
  ALTER TABLE items ADD COLUMN version_of INTEGER REFERENCES items(id) ON DELETE SET NULL;
  CREATE INDEX items_version_of ON items(version_of);
  `,
  // v13: films people ask for (server/requests.js): one per film, picked from TMDB, kept until the person who asked or
  // an admin removes it, or the film turns up in a library they can open.
  `
  CREATE TABLE requests (
    id         INTEGER PRIMARY KEY,
    tmdb_id    INTEGER NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    year       INTEGER,
    poster     TEXT,                    -- TMDB's poster path ("/abc.jpg"), shown through the image cache
    overview   TEXT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX requests_user ON requests(user_id);
  `,
  // v14: the icon an admin picked for a library (server/libraries.js LIBRARY_ICONS); none shows its type's.
  `
  ALTER TABLE libraries ADD COLUMN icon TEXT;
  `,
  // v15: who scheduled each Live TV recording through Reelhouse (Tvheadend records them all under Reelhouse's one
  // account, so it can't tell): the Recordings page shows people their own. Ones scheduled before this, or whose
  // person's account was deleted, have no row: only admins see those.
  `
  CREATE TABLE recordings (
    dvr_uuid   TEXT PRIMARY KEY,        -- Tvheadend's recording (its DVR entry's uuid)
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX recordings_user ON recordings(user_id);
  `,
  // v16: the Recordings page's cover art, found on TMDB by a show's name (server/livetv/recordings.js) and kept, so TMDB
  // is asked once per show. No poster means TMDB had no show or film by that name (asked again after a week).
  `
  CREATE TABLE recording_art (
    title_key  TEXT PRIMARY KEY,        -- the show's name, as showKey() writes it
    poster     TEXT,                    -- TMDB's poster path ("/abc.jpg"), shown through the image cache
    tmdb_id    INTEGER,
    kind       TEXT,                    -- tv or movie
    checked_at INTEGER NOT NULL
  );
  `,
  // v17: the Recordings page's series covers and episode pictures, from TMDB for shows found there (asked once, and
  // again a day later at the soonest when a recording's series or episode isn't among them).
  `
  ALTER TABLE recording_art ADD COLUMN seasons_json TEXT;   -- { series number: poster path }
  ALTER TABLE recording_art ADD COLUMN seasons_at INTEGER;
  CREATE TABLE recording_stills (
    title_key   TEXT NOT NULL,
    season      INTEGER NOT NULL,
    stills_json TEXT,                    -- { episode number: still path }
    checked_at  INTEGER NOT NULL,
    PRIMARY KEY (title_key, season)
  );
  `,
  // v18: downloads are off by default on a new server; one already in use, still on the old default, keeps them on.
  `
  INSERT OR IGNORE INTO settings (key, value) SELECT 'allowDownloads', 'true' WHERE EXISTS (SELECT 1 FROM users);
  `,
  // v19: series recordings (Tvheadend's autorecs): an admin's switch for each account, off until allowed, and who set each
  // one through Reelhouse (as for recordings: Tvheadend has them all under Reelhouse's one account). One with no row (set
  // in Tvheadend itself, or its person's account was deleted) only shows to admins.
  `
  ALTER TABLE users ADD COLUMN live_tv_series INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE recording_series (
    autorec_uuid TEXT PRIMARY KEY,      -- Tvheadend's autorec
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX recording_series_user ON recording_series(user_id);
  `,
  // v20: the channels each person has been watching, for Continue Watching on Home (server/livetv/recent-channels.js).
  `
  CREATE TABLE channel_views (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_uuid TEXT NOT NULL,         -- Tvheadend's channel
    watched_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_uuid)
  );
  `,
];

export function openDb(file = path.join(DATA_DIR, 'reelhouse.db')) {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate();
  return db;
}

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export const all = (sql, ...params) => stmt(sql).all(...params);
export const get = (sql, ...params) => stmt(sql).get(...params);
export const run = (sql, ...params) => stmt(sql).run(...params);

let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

// Builds "?, ?, ?" for IN clauses.
export const placeholders = (arr) => arr.map(() => '?').join(', ');

export function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function closeDb() {
  stmtCache.clear();
  db?.close();
}
