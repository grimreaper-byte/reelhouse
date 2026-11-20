// The phone as a remote (Android app 0.15.0 on). Reelhouse's own players listen on their event stream (events.js) as
// "targets": a web tab, Kodi with the add-on, the app on a TV box (or on a phone or tablet whose owner switched it
// on). The same person's phone lists those on the same network as itself and sends them commands (play, pause, seek,
// skip, stop, next, previous), which go down that one stream; the target answers each (done) and the answer goes back
// to the phone. What a target is playing comes from the progress reports every player already sends (activity.js),
// matched by the sign-in they came with.
//
// Only devices on the same network, checked when listing and again for every command (see networkOf). Only the
// person's own devices: someone else's TV isn't listed, even on the same Wi-Fi.
//
// Not to be confused with server/remote/, which is about reaching Reelhouse from outside (the tunnel, UPnP, HTTPS).
import crypto from 'node:crypto';
import { clientIp, isPrivateIp, ipInCidr } from './auth.js';
import { getSetting } from './settings.js';
import { tunnelClientAddress } from './remote/tunnel-identity.js';
import { peerEndpoint, refreshTunnelStatus } from './remote/apptunnel.js';
import { lastKnownPublicIp } from './remote/net.js';
import { sendTo, streamOpen } from './events.js';
import { browserName, listStreams, watchStreams } from './activity.js';
import { getAccessibleItem, adjacentEpisodes } from './items.js';

/** What a target is: a browser tab, Kodi, the app on a TV box, the app on a phone or tablet. */
export const TARGET_KINDS = new Set(['web', 'kodi', 'tv', 'phone']);
export const COMMANDS = new Set(['play', 'pause', 'resume', 'seek', 'skip', 'stop', 'next', 'previous']);
const COMMANDS_PER_SECOND = 20; // more than any thumb, fewer than a stuck button
const ANSWER_WITHIN_MS = 30 * 1000;
const PROBLEM_LENGTH = 200;

const targets = new Map(); // id → { id, kind, name, userId, sessionId, where, client, claim }
const controllers = new Set(); // { client, userId, sessionId, where }
const commands = new Map(); // command id → { userId, targetId, from (the phone's sign-in), at }
const recent = new Map(); // userId → times of their last commands
let claims = 0;

// ---------- the same network ----------

/**
 * Where a request came from, as networkOf needs it: through the app tunnel ({ tunnel: the device's tunnel address }),
 * through the admin's own WireGuard ({ wireguard: true }: nothing tells where that device is), or straight
 * ({ ip }: on the home network, or through the web address).
 */
export function whereFrom(req) {
  const tunnel = tunnelClientAddress(req);
  if (tunnel) return { tunnel };
  const ip = clientIp(req);
  const wireguard = getSetting('wireguard');
  if (wireguard?.enabled && ipInCidr(ip, wireguard.subnet)) return { wireguard: true };
  return { ip };
}

/** The first half (the network part) of an IPv6 address, "2001:db8:1:2::/64"; null if it isn't one. */
function ipv6Network(ip) {
  const parts = ip.toLowerCase().split('%')[0].split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (parts.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The network an address is on: "home" for the server's own network (a private address, or the server's public
 * address, which a router that loops connections back gives devices at home), else the address itself (IPv4: the
 * router of the house it's in) or its /64 (IPv6). Null when not known.
 */
export function networkOfIp(ip) {
  if (!ip) return null;
  const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isPrivateIp(plain)) return 'home';
  const own = lastKnownPublicIp();
  if (own && plain === own) return 'home';
  return plain.includes(':') ? ipv6Network(plain) : plain;
}

/**
 * The network a device is on (see whereFrom): through the tunnel, where its tunnel traffic comes from; through the
 * admin's WireGuard, unknown (null, which never matches anything).
 */
export function networkOf(where) {
  if (!where || where.wireguard) return null;
  return networkOfIp(where.tunnel ? peerEndpoint(where.tunnel) : where.ip);
}

// ---------- targets and phones on the event stream ----------

const alive = (entry) => streamOpen(entry.client) && entry.client.currentUser()?.id === entry.userId;

/** Tells the person's phones to look at the list again (a target came, went, or another tab of a browser took over). */
function nudge(userId) {
  for (const c of controllers) {
    if (c.userId === userId && alive(c)) sendTo(c.client, 'remote-targets', {});
  }
}

/**
 * An event stream opened (GET /api/events): `?target=web|kodi|tv|phone` makes it a target, `?controller=1` a phone
 * that wants to hear about its targets. A target hears its id first (remote-hello), for claim().
 */
export function joinStream(req, client, query = {}) {
  const sessionId = req.sessionId;
  if (!sessionId) return;
  const base = { client, userId: req.user.id, sessionId, where: whereFrom(req) };
  // The tunnel helper only says where devices are when asked: ask now, so the lists and relays below know.
  if (base.where.tunnel) refreshTunnelStatus().catch(() => {});
  if (TARGET_KINDS.has(query.target)) {
    const target = {
      ...base,
      id: crypto.randomBytes(9).toString('base64url'),
      kind: query.target,
      name: (req.device || browserName(req.headers?.['user-agent'])).slice(0, 80),
      claim: ++claims,
    };
    targets.set(target.id, target);
    client.remoteTarget = target;
    sendTo(client, 'remote-hello', { targetId: target.id });
    nudge(target.userId);
  }
  if (query.controller === '1' || query.controller === 'true') {
    const controller = { ...base };
    controllers.add(controller);
    client.remoteController = controller;
  }
}

/** The stream closed (events.js onClose). */
export function leaveStream(client) {
  if (client.remoteController) controllers.delete(client.remoteController);
  const target = client.remoteTarget;
  if (target && targets.delete(target.id)) nudge(target.userId);
}

/**
 * The tabs of one browser share a sign-in, so only one of them is listed: the one that last opened its stream or
 * claimed (the web app claims when a tab gets the focus). False for an unknown target or someone else's.
 */
export function claim(req, targetId) {
  const target = targets.get(String(targetId));
  if (!target || target.userId !== req.user.id || target.sessionId !== req.sessionId || !alive(target)) return false;
  target.claim = ++claims;
  nudge(target.userId);
  return true;
}

/** What a target is playing: its sign-in's latest stream (activity.js), or null. `age` is in milliseconds. */
function stateOf(target, now = Date.now()) {
  let latest = null;
  for (const s of listStreams()) {
    if (s.sessionId === target.sessionId && s.userId === target.userId && (!latest || s.updatedAt > latest.updatedAt)) latest = s;
  }
  if (!latest) return null;
  return {
    itemId: latest.itemId ?? null,
    title: latest.title ?? null,
    show: latest.grandparentTitle ?? null,
    season: latest.seasonNumber ?? null,
    episode: latest.episodeNumber ?? null,
    position: latest.position ?? null,
    duration: latest.duration ?? null,
    state: latest.state || 'playing',
    live: latest.mode === 'live',
    age: Math.max(0, now - latest.updatedAt),
  };
}

const describe = (t) => ({ id: t.id, kind: t.kind, name: t.name, state: stateOf(t) });

/** The person's targets on `network`, one per sign-in (its last claim), leaving out the asking device itself. */
function targetsOn(userId, network, exceptSession) {
  if (!network) return [];
  const bySession = new Map();
  for (const t of targets.values()) {
    if (t.userId !== userId || t.sessionId === exceptSession) continue;
    if (!alive(t)) {
      targets.delete(t.id);
      continue;
    }
    if (networkOf(t.where) !== network) continue;
    const seen = bySession.get(t.sessionId);
    if (!seen || t.claim > seen.claim) bySession.set(t.sessionId, t);
  }
  return [...bySession.values()].sort((a, b) => a.name.localeCompare(b.name) || a.claim - b.claim);
}

/** GET /api/remote/targets: what the asking phone may control. */
export async function listTargets(req) {
  await refreshTunnelStatus();
  return targetsOn(req.user.id, networkOf(whereFrom(req)), req.sessionId).map(describe);
}

// What a target is playing changed: its owner's phones on the same network hear it.
watchStreams((stream) => {
  if (!stream.sessionId) return;
  for (const t of targets.values()) {
    if (t.sessionId !== stream.sessionId || t.userId !== stream.userId || !alive(t)) continue;
    const network = networkOf(t.where);
    if (!network) continue;
    const state = stateOf(t);
    for (const c of controllers) {
      if (c.userId === t.userId && c.sessionId !== t.sessionId && alive(c) && networkOf(c.where) === network) {
        sendTo(c.client, 'remote-state', { targetId: t.id, state });
      }
    }
  }
});

// ---------- commands ----------

class RemoteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function tooMany(userId, now) {
  const times = (recent.get(userId) || []).filter((t) => now - t < 1000);
  times.push(now);
  recent.set(userId, times);
  return times.length > COMMANDS_PER_SECOND;
}

const number = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/** The episode before or after the one a target is playing, for next/previous (Kodi plays it; the apps go on). */
function neighbour(user, target, type) {
  const itemId = stateOf(target)?.itemId;
  const row = itemId && getAccessibleItem(user, itemId);
  if (!row || row.type !== 'episode') throw new RemoteError(409, `${target.name} isn't playing an episode.`);
  const { prev, next } = adjacentEpisodes(row);
  const other = type === 'next' ? next : prev;
  const playable = other && getAccessibleItem(user, other.id);
  if (!playable?.file_path) {
    throw new RemoteError(409, type === 'next' ? 'This is the last episode.' : 'This is the first episode.');
  }
  return playable.id;
}

/**
 * POST /api/remote/targets/:id/commands. Checks it's the person's own device, still there and on the same network as
 * the phone, then sends it down that device's stream; resolves to the command's id, which the device's answer
 * (remote-done) carries. Throws a RemoteError (status, message) otherwise.
 */
export async function sendCommand(req, targetId, body = {}) {
  const now = Date.now();
  if (tooMany(req.user.id, now)) throw new RemoteError(429, 'Too many commands at once.');
  const target = targets.get(String(targetId));
  if (!target || target.userId !== req.user.id || !alive(target)) {
    throw new RemoteError(404, "That device isn't there any more: is Reelhouse still open on it?");
  }
  const type = String(body.type || '');
  if (!COMMANDS.has(type)) throw new RemoteError(400, 'Unknown command.');
  await refreshTunnelStatus();
  const network = networkOf(whereFrom(req));
  if (!network || networkOf(target.where) !== network) {
    throw new RemoteError(403, `${target.name} isn't on the same network as this phone.`);
  }
  const command = { id: crypto.randomBytes(9).toString('base64url'), type };
  if (type === 'play') {
    const itemId = number(body.itemId);
    const row = Number.isInteger(itemId) && itemId > 0 ? getAccessibleItem(req.user, itemId) : null;
    if (!row?.file_path) throw new RemoteError(404, 'Not found');
    const start = number(body.start ?? 0);
    if (!Number.isFinite(start) || start < 0) throw new RemoteError(400, 'Bad start position.');
    Object.assign(command, { itemId, start });
  } else if (type === 'seek') {
    const position = number(body.position);
    if (!Number.isFinite(position) || position < 0) throw new RemoteError(400, 'Bad position.');
    command.position = position;
  } else if (type === 'skip') {
    const seconds = number(body.seconds);
    if (!Number.isFinite(seconds) || Math.abs(seconds) > 3600 || seconds === 0) throw new RemoteError(400, 'Bad skip.');
    command.seconds = seconds;
  } else if (type === 'next' || type === 'previous') {
    command.itemId = neighbour(req.user, target, type);
  }
  command.from = (req.device || browserName(req.headers?.['user-agent'])).slice(0, 80);
  for (const [id, c] of commands) if (now - c.at > ANSWER_WITHIN_MS) commands.delete(id);
  commands.set(command.id, { userId: req.user.id, targetId: target.id, from: req.sessionId, at: now });
  if (!sendTo(target.client, 'remote', command)) {
    commands.delete(command.id);
    throw new RemoteError(404, "That device isn't there any more: is Reelhouse still open on it?");
  }
  return command.id;
}

/**
 * POST /api/remote/commands/:id/done: a target's answer ({ ok, problem }: "blocked" when a browser wouldn't start
 * the video by itself, else a sentence), for the phone that sent the command. False for an unknown command, or one
 * for another device.
 */
export function commandDone(req, commandId, body = {}) {
  const command = commands.get(String(commandId));
  const target = command && targets.get(command.targetId);
  if (!command || command.userId !== req.user.id || (target && target.sessionId !== req.sessionId)) return false;
  commands.delete(String(commandId));
  const answer = {
    id: String(commandId),
    targetId: command.targetId,
    ok: body.ok !== false,
    problem: body.problem ? String(body.problem).slice(0, PROBLEM_LENGTH) : null,
  };
  for (const c of controllers) {
    if (c.userId === command.userId && c.sessionId === command.from && alive(c)) sendTo(c.client, 'remote-done', answer);
  }
  return true;
}

export { RemoteError };

/** For tests. */
export function clearRemote() {
  targets.clear();
  controllers.clear();
  commands.clear();
  recent.clear();
}
