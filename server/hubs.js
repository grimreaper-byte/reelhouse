// Home's "Watched by Others" row: what other people on the server have been watching.
import { all, placeholders } from './db.js';
import { serializeMany } from './items.js';

const OTHERS_DAYS = 60;
const OTHERS_LIMIT = 24;

/**
 * What other people on the server have watched lately (finished, or at least 30 s in), most recent first: one card
 * per movie or show, with who (`watchedBy`, most recent first) and when (`watchedAt`). Only titles in the viewer's
 * libraries; people who keep their viewing to themselves (share_watching = 0) are left out.
 */
export function watchedByOthers(user, libIds) {
  if (!libIds.length) return [];
  const rows = all(
    `SELECT us.item_id, us.updated_at, u.username, i.type, i.show_id
       FROM user_state us JOIN users u ON u.id = us.user_id JOIN items i ON i.id = us.item_id
      WHERE us.user_id != ? AND u.share_watching = 1 AND (us.watched = 1 OR us.position >= 30)
        AND i.type IN ('movie', 'episode') AND i.library_id IN (${placeholders(libIds)}) AND us.updated_at > ?
      ORDER BY us.updated_at DESC LIMIT 3000`,
    user.id,
    ...libIds,
    Date.now() - OTHERS_DAYS * 24 * 3600 * 1000,
  );
  const cards = new Map(); // movie or show id → { at, people }
  for (const r of rows) {
    const id = r.type === 'episode' ? r.show_id : r.item_id;
    if (!id) continue;
    let card = cards.get(id);
    if (!card) {
      if (cards.size >= OTHERS_LIMIT) continue;
      card = { at: r.updated_at, people: [] };
      cards.set(id, card);
    }
    if (!card.people.includes(r.username)) card.people.push(r.username);
  }
  if (!cards.size) return [];
  const ids = [...cards.keys()];
  const byId = new Map(all(`SELECT * FROM items WHERE id IN (${placeholders(ids)})`, ...ids).map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  const out = serializeMany(user.id, ordered);
  ordered.forEach((r, i) => {
    out[i].watchedBy = cards.get(r.id).people;
    out[i].watchedAt = cards.get(r.id).at;
  });
  return out;
}
