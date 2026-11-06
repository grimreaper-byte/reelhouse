// The channels someone has been watching, for Continue Watching on Home when Settings → Live TV says to show them. A channel
// counts once it has been on for 30 seconds, as a film does, so flicking through channels adds nothing. Kept whether or
// not the option is on, so that turning it on shows what people have been watching straight away.
import { all, run } from '../db.js';
import { getSetting } from '../settings.js';
import { channels, liveTvOn, publicChannel } from './guide.js';

export const COUNTS_AFTER_MS = 30 * 1000;
const MOST_SHOWN = 8;
const WAIT_FOR_TVHEADEND_MS = 1000; // Home shouldn't wait long for them

export function noteChannelWatched(userId, uuid, at = Date.now()) {
  run(
    `INSERT INTO channel_views (user_id, channel_uuid, watched_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_uuid) DO UPDATE SET watched_at = excluded.watched_at`,
    userId,
    uuid,
    at,
  );
}

/**
 * The cards for someone's Continue Watching, newest first: { type: 'channel', title, channel, lastWatchedAt }. Only
 * channels still on Tvheadend's list, and none at all if it doesn't answer in time: Home goes ahead without them.
 */
export async function channelsToContinue(user) {
  if (!liveTvOn() || !user.liveTv || !getSetting('liveTv').inContinueWatching) return [];
  const views = all('SELECT channel_uuid, watched_at FROM channel_views WHERE user_id = ? ORDER BY watched_at DESC', user.id);
  if (!views.length) return [];
  const list = await Promise.race([
    channels().catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), WAIT_FOR_TVHEADEND_MS).unref()),
  ]);
  if (!list) return [];
  const byUuid = new Map(list.map((c) => [c.uuid, c]));
  const cards = [];
  for (const view of views) {
    const channel = byUuid.get(view.channel_uuid);
    // A station found to be radio since: it isn't something to carry on watching.
    if (channel && !channel.radio) {
      cards.push({ type: 'channel', title: channel.name, channel: publicChannel(channel), lastWatchedAt: view.watched_at });
    }
    if (cards.length === MOST_SHOWN) break;
  }
  return cards;
}
