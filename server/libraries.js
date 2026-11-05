// Libraries with the same name and type are one library: folders on different drives (two "Movies" folders) show up
// together. Adding a library under a name that's already taken adds its folders to that library, and two that
// already exist can be merged without losing watch history (their items move rather than being rescanned).
import { all, get, run, tx, parseJson } from './db.js';
import { logger } from './lib/log.js';
import { regroupVersions } from './versions.js';

const log = logger('libraries');

const sameName = (a, b) => String(a).trim().toLocaleLowerCase() === String(b).trim().toLocaleLowerCase();

/** How libraries are listed everywhere (the sidebar, Home, the apps): their order from Settings → Libraries. */
export const LIBRARY_ORDER = 'position, name COLLATE NOCASE, id';

/**
 * The icons a library can be given in Settings → Libraries (the web's icon names, web/js/dom.js; the apps draw the
 * same). One without its own shows its type's: film for movies, tv for shows.
 */
export const LIBRARY_ICONS = ['film', 'tv', 'tvRecord', 'tvOld', 'tvFlat', 'tvPlay', 'clapperboard', 'movieCamera', 'trophy', 'heart'];

/** The icon a library shows. */
export const libraryIcon = (lib) => (LIBRARY_ICONS.includes(lib.icon) ? lib.icon : lib.type === 'movie' ? 'film' : 'tv');

/**
 * An icon as an admin picked it, to keep: null for none (or the type's own, so it stays the default). Throws, with a
 * status of 400, for one that isn't in LIBRARY_ICONS.
 */
export function pickedIcon(icon, type) {
  if (icon == null || icon === '' || icon === libraryIcon({ type })) return null;
  if (!LIBRARY_ICONS.includes(icon)) throw Object.assign(new Error('There’s no such library icon'), { status: 400 });
  return icon;
}

/**
 * Puts the libraries in this order, first to last, and keeps it in the database: those named, then any others as
 * they were (e.g. one added meanwhile). Returns the ids in their new order.
 */
export function orderLibraries(ids) {
  const current = all(`SELECT id FROM libraries ORDER BY ${LIBRARY_ORDER}`).map((r) => r.id);
  const named = [...new Set(ids.map(Number))].filter((id) => current.includes(id));
  const order = [...named, ...current.filter((id) => !named.includes(id))];
  tx(() => order.forEach((id, i) => run('UPDATE libraries SET position = ? WHERE id = ?', i, id)));
  return order;
}

/** The library already called [name] with this [type] (another than [exceptId]), or null. */
export function sameNamedLibrary(name, type, exceptId = null) {
  return all('SELECT * FROM libraries WHERE type = ? AND id IS NOT ? ORDER BY id', type, exceptId)
    .find((lib) => sameName(lib.name, name)) || null;
}

/** Adds folders to a library (ones it already has are skipped). Returns the folders it has now. */
export function addLibraryPaths(libraryId, paths) {
  const lib = get('SELECT paths FROM libraries WHERE id = ?', libraryId);
  const have = parseJson(lib?.paths, []);
  const next = [...have, ...paths.filter((p) => !have.includes(p))];
  run('UPDATE libraries SET paths = ? WHERE id = ?', JSON.stringify(next), libraryId);
  return next;
}

/**
 * Merges library [sourceId] into [targetId] (same type): its folders and items move over, items keep their ids (so
 * watch history and resume points stay), and anyone allowed to see either library can see the merged one. The
 * source library is removed. Returns { target, moved } or throws for libraries that can't be merged.
 */
export function mergeLibraries(sourceId, targetId) {
  return tx(() => {
    const source = get('SELECT * FROM libraries WHERE id = ?', sourceId);
    const target = get('SELECT * FROM libraries WHERE id = ?', targetId);
    if (!source || !target) throw Object.assign(new Error('No such library'), { status: 404 });
    if (source.id === target.id) throw Object.assign(new Error('That’s the same library'), { status: 400 });
    if (source.type !== target.type) throw Object.assign(new Error('Only libraries of the same kind can be merged'), { status: 400 });
    addLibraryPaths(target.id, parseJson(source.paths, []));
    // A folder that was in both: the merged library keeps the copy it has of each file.
    run(
      `DELETE FROM items WHERE library_id = ? AND file_path IS NOT NULL
         AND file_path IN (SELECT file_path FROM items WHERE library_id = ? AND file_path IS NOT NULL)`,
      source.id,
      target.id,
    );
    const moved = run('UPDATE items SET library_id = ? WHERE library_id = ?', target.id, source.id).changes;
    // Restricted users who could see the source keep seeing those titles, in the merged library.
    for (const user of all('SELECT id, library_access FROM users WHERE library_access IS NOT NULL')) {
      const access = parseJson(user.library_access, null);
      if (!Array.isArray(access) || !access.includes(source.id)) continue;
      const next = [...new Set(access.map((id) => (id === source.id ? target.id : id)))];
      run('UPDATE users SET library_access = ? WHERE id = ?', JSON.stringify(next), user.id);
    }
    run('DELETE FROM libraries WHERE id = ?', source.id);
    if (target.type === 'movie') regroupVersions(target.id); // the same film in both: one film with two copies
    log.info(`Merged library "${source.name}" (#${source.id}, ${moved} items) into "${target.name}" (#${target.id})`);
    return { target: get('SELECT * FROM libraries WHERE id = ?', target.id), moved };
  });
}
