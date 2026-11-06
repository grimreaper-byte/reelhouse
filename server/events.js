// Live updates for open web pages (Server-Sent Events): tells browsers when a library's contents
// change, so new files, removed files and freshly fetched posters show up without a reload.
import crypto from 'node:crypto';
import { canAccessLibrary } from './auth.js';

const PING_MS = 25000; // keeps proxies and NAT from dropping an idle stream
const METADATA_EVERY_MS = 15000; // while posters are being fetched, update pages at most this often

const clients = new Set();
// Changes on every event and on restart, so a reconnecting page can tell whether it missed anything.
const boot = crypto.randomBytes(4).toString('hex');
let counter = 0;
export const libraryVersion = () => `${boot}.${counter}`;

/**
 * Open an event stream on an Express response. `currentUser()` is re-checked before each event,
 * so a signed-out session or revoked library access stops receiving updates.
 */
export function openEventStream(req, res, currentUser) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform keeps the compression middleware from buffering the stream.
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // nginx: don't buffer
  });
  res.write(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ version: libraryVersion() })}\n\n`);
  const client = { res, currentUser };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  ping.unref();
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

function send(type, data, allowed) {
  for (const client of clients) {
    const user = client.currentUser();
    if (!user) {
      client.res.end();
      clients.delete(client);
      continue;
    }
    if (allowed && !allowed(user)) continue;
    client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/** A library's items changed: { added, updated, removed } counts when known. */
export function libraryChanged(libraryId, changes = {}) {
  counter++;
  const data = { libraryId, version: libraryVersion(), ...changes };
  // A deleted library is gone from everyone's access list, but every page should drop it; a new order is for everyone.
  send('library', data, changes.deleted || changes.order ? null : (user) => canAccessLibrary(user, libraryId));
}

/** Files new to a library being read (the top bar's "Adding …"), for those who can open it; see scanner/index.js. */
export function scanProgress(data) {
  send('scan', data, (user) => canAccessLibrary(user, data.libraryId));
}

/** A user's watch state changed for these items; only that user's pages and apps hear about it. */
export function stateChanged(userId, itemIds) {
  if (!itemIds?.length) return;
  send('state', { itemIds: itemIds.slice(0, 5000) }, (user) => user.id === userId);
}

/** The channels in someone's Continue Watching changed: their pages and apps look again, as for a title. */
export function recentChannelsChanged(userId) {
  send('state', { itemIds: [] }, (user) => user.id === userId);
}

/** A stream started or stopped: admins' pages update the count of what's being watched (server/activity.js). */
export function activityChanged(count) {
  send('activity', { count }, (user) => user.isAdmin);
}

/**
 * Live TV changed for someone (their account's switches) or everyone (turned on or off): pages ask /api/me again
 * and show or hide Live TV.
 */
export function liveTvChanged(userId = null) {
  send('livetv', {}, userId == null ? null : (user) => user.id === userId);
}

/**
 * The list of requested films changed, or Requests was turned on or off (server/requests.js requestsAccess:
 * { enabled, count, available }): everyone's Requests page and the sidebar's row update.
 */
export function requestsChanged(access) {
  send('requests', access);
}

/** The server-wide choices apps follow changed (see appDefaults in settings.js); everyone hears about it. */
export function defaultsChanged(defaults) {
  send('defaults', defaults);
}

/**
 * Progress callback for a metadata refresh: updates pages every so often while posters arrive,
 * and once more when it finishes.
 */
export function metadataProgress(libraryId, inner = () => {}) {
  let last = Date.now();
  let pending = false;
  return (done, total) => {
    inner(done, total);
    if (done > 0) pending = true;
    const finished = total > 0 && done >= total;
    if (pending && (finished || Date.now() - last >= METADATA_EVERY_MS)) {
      pending = false;
      last = Date.now();
      libraryChanged(libraryId, { metadata: true });
    }
  };
}

export const eventClientCount = () => clients.size;
