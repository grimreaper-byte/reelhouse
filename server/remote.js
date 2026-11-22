// The phone as a remote (Android app 0.15.0 on). Reelhouse's own players listen on their event stream (events.js) as
// "targets": a web tab, Kodi with the add-on, the app on a TV box (or on a phone or tablet whose owner switched it
// on). The same person's phone lists those on the same network as itself and sends them commands (play, pause, seek,
// skip, stop, next, previous), which go down that one stream; the target answers each (done) and the answer goes back
// to the phone. What a target is playing comes from the progress reports every player already sends (activity.js),
// matched by the sign-in they came with.
//
// Only devices on the same network, checked when listing and again for every command (see networkOf). The person's
// own devices, and other people's that they've shared (since 0.26.0: the device's own switch, "Let anyone at home
// play on this"), which play under the device's own sign-in, and only what both people may see.
//
// Since 0.26.0 also live TV and radio channels (play { channel }; next/previous change channel while one plays), and
// the audio, subtitles and volume of what's playing: each device reports what it offers (its "controls",
// reportControls) and the phone picks from those.
//
// Not to be confused with server/remote/, which is about reaching Reelhouse from outside (the tunnel, UPnP, HTTPS).
import crypto from 'node:crypto';
import { clientIp, isPrivateIp, ipInCidr, loadUser } from './auth.js';
import { getSetting } from './settings.js';
import { tunnelClientAddress } from './remote/tunnel-identity.js';
import { peerEndpoint, refreshTunnelStatus } from './remote/apptunnel.js';
import { lastKnownPublicIp } from './remote/net.js';
import { sendTo, streamOpen } from './events.js';
import { browserName, listStreams, watchStreams } from './activity.js';
import { getAccessibleItem, adjacentEpisodes } from './items.js';
import { channels, channelByUuid, liveTvOn } from './livetv/guide.js';

/** What a target is: a browser tab, Kodi, the app on a TV box, the app on a phone or tablet. */
export const TARGET_KINDS = new Set(['web', 'kodi', 'tv', 'phone']);
/** What the app says a device is, for its icon in the phone's list (app 0.16.2+): a tablet, or a Fire TV. */
export const TARGET_FORMS = new Set(['tablet', 'firetv']);
export const COMMANDS = new Set([
  'play', 'pause', 'resume', 'seek', 'skip', 'stop', 'next', 'previous', 'audio', 'subtitle', 'volume', 'mute',
]);
const COMMANDS_PER_SECOND = 20; // more than any thumb, fewer than a stuck button
const ANSWER_WITHIN_MS = 30 * 1000;
const PROBLEM_LENGTH = 200;
const MAX_TRACKS = 30;
const LABEL_LENGTH = 80;
const TRACK_ID_LENGTH = 40;

// id → { id, kind, form, name, userId, username, sessionId, where, client, claim, shared, controls }
const targets = new Map();
const controllers = new Set(); // { client, userId, sessionId, where }
// command id → { senderUserId, senderSession, targetId, targetUserId, targetSession, at }
const commands = new Map();
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

/**
 * Whether phone [c] may see and control [target]: on the same network, not the same sign-in, and its owner's, or
 * shared by its owner with anyone at home.
 */
function canSee(c, target) {
  if (c.sessionId === target.sessionId || (c.userId !== target.userId && !target.shared)) return false;
  const network = networkOf(target.where);
  return !!network && networkOf(c.where) === network;
}

/**
 * Tells the phones that can see [target] to look at the list again (it came, went, or another tab of a browser took
 * over). Its owner's phones anywhere hear of it, so one that has just left the network drops it too.
 */
function nudge(target) {
  for (const c of controllers) {
    if ((c.userId === target.userId || canSee(c, target)) && alive(c)) sendTo(c.client, 'remote-targets', {});
  }
}

/**
 * An event stream opened (GET /api/events): `?target=web|kodi|tv|phone` makes it a target (`&shared=1`: anyone at
 * home may use it; `&form=tablet|firetv`: what it is, for its icon), `?controller=1` a phone that wants to hear about
 * its targets. A target hears its id first (remote-hello), for claim() and reportControls().
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
      form: TARGET_FORMS.has(query.form) ? query.form : null,
      name: (req.device || browserName(req.headers?.['user-agent'])).slice(0, 80),
      username: req.user.username,
      claim: ++claims,
      shared: query.shared === '1' || query.shared === 'true',
      controls: null,
    };
    targets.set(target.id, target);
    client.remoteTarget = target;
    sendTo(client, 'remote-hello', { targetId: target.id });
    nudge(target);
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
  if (target && targets.delete(target.id)) nudge(target);
}

/**
 * The tabs of one browser share a sign-in, so only one of them is listed: the one that last opened its stream or
 * claimed (the web app claims when a tab gets the focus). False for an unknown target or someone else's.
 */
export function claim(req, targetId) {
  const target = targets.get(String(targetId));
  if (!target || target.userId !== req.user.id || target.sessionId !== req.sessionId || !alive(target)) return false;
  target.claim = ++claims;
  nudge(target);
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
    // A film or episode's id (a channel's stream has "live:<uuid>", which apps don't take as an item: it's `channel`).
    itemId: latest.mode === 'live' ? null : latest.itemId ?? null,
    title: latest.title ?? null,
    show: latest.grandparentTitle ?? null,
    season: latest.seasonNumber ?? null,
    episode: latest.episodeNumber ?? null,
    position: latest.position ?? null,
    duration: latest.duration ?? null,
    state: latest.state || 'playing',
    live: latest.mode === 'live',
    // A channel: its id, radio or not, and the programme on when it started.
    channel: latest.mode === 'live' ? latest.channelUuid ?? null : null,
    radio: latest.mode === 'live' ? !!latest.radio : false,
    programme: latest.mode === 'live' ? latest.programme ?? null : null,
    age: Math.max(0, now - latest.updatedAt),
  };
}

/**
 * What [viewer] may know of what [target] plays ([state], its stateOf): everything on their own device; on someone
 * else's shared one, what they may see themselves (their libraries and content rating limit, Live TV), else only that
 * it plays or is paused, and how far in: no title, item or channel.
 */
export function stateFor(target, viewer, state = stateOf(target)) {
  if (!state || target.userId === viewer?.id) return state;
  const visible = state.live ? !!viewer?.liveTv : !!(viewer && state.itemId && getAccessibleItem(viewer, state.itemId));
  if (visible) return state;
  return { ...state, itemId: null, title: null, show: null, season: null, episode: null, channel: null, radio: false, programme: null };
}

/**
 * A target as a phone of [viewer] sees it: what it plays (stateFor), what can be changed (controls, as it reported
 * them), and, for someone else's shared device, whose it is.
 */
const describe = (t, viewer) => ({
  id: t.id,
  kind: t.kind,
  form: t.form,
  name: t.name,
  owner: t.userId === viewer.id ? null : t.username,
  state: stateFor(t, viewer),
  controls: t.controls,
});

/**
 * The targets a phone ([c]: its userId, sessionId and where) may control: the person's own on its network and the
 * ones shared there, one per sign-in (its last claim), leaving out the phone itself.
 */
function targetsFor(c) {
  const bySession = new Map();
  for (const t of targets.values()) {
    if (!alive(t)) {
      targets.delete(t.id);
      continue;
    }
    if (!canSee(c, t)) continue;
    const seen = bySession.get(t.sessionId);
    if (!seen || t.claim > seen.claim) bySession.set(t.sessionId, t);
  }
  // The person's own first, then other people's.
  return [...bySession.values()].sort((a, b) => (a.userId !== c.userId) - (b.userId !== c.userId)
    || a.name.localeCompare(b.name) || a.claim - b.claim);
}

/** GET /api/remote/targets: what the asking phone may control. */
export async function listTargets(req) {
  await refreshTunnelStatus();
  const asker = { userId: req.user.id, sessionId: req.sessionId, where: whereFrom(req) };
  return targetsFor(asker).map((t) => describe(t, req.user));
}

/** Tells the phones that can see [t] what it plays (as far as each may know: stateFor) and offers now (remote-state). */
function relayState(t) {
  const state = stateOf(t);
  for (const c of controllers) {
    if (!canSee(c, t) || !alive(c)) continue;
    sendTo(c.client, 'remote-state', { targetId: t.id, state: stateFor(t, c.client.currentUser(), state), controls: t.controls });
  }
}

// What a target is playing changed: the phones that can see it hear it.
watchStreams((stream) => {
  if (!stream.sessionId) return;
  for (const t of targets.values()) {
    if (t.sessionId !== stream.sessionId || t.userId !== stream.userId || !alive(t)) continue;
    relayState(t);
  }
});

// ---------- what a target offers ----------

const text = (v, max) => (v == null ? null : String(v).slice(0, max));

function tracksIn(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_TRACKS)
    .filter((t) => t && t.id != null && String(t.id).length > 0)
    .map((t) => ({ id: text(t.id, TRACK_ID_LENGTH), label: text(t.label, LABEL_LENGTH) || String(t.id).slice(0, LABEL_LENGTH) }));
}

/** A report as kept: what a phone may choose from. Null for an empty one (nothing playing). */
export function cleanControls(body = {}) {
  const audio = tracksIn(body.audio);
  const subtitles = tracksIn(body.subtitles);
  const volume = body.volume == null || body.volume === '' ? null : Number(body.volume);
  const hasVolume = Number.isFinite(volume);
  if (!audio.length && !subtitles.length && !hasVolume && body.canPause == null) return null;
  const audioId = text(body.audioId, TRACK_ID_LENGTH);
  const subtitleId = text(body.subtitleId, TRACK_ID_LENGTH);
  return {
    audio,
    audioId: audio.some((t) => t.id === audioId) ? audioId : null,
    subtitles,
    subtitleId: subtitles.some((t) => t.id === subtitleId) ? subtitleId : null,
    volume: hasVolume ? Math.round(Math.min(100, Math.max(0, volume))) : null,
    muted: !!body.muted,
    canPause: body.canPause !== false,
  };
}

/**
 * POST /api/remote/status: a target says what it offers now (audio and subtitle tracks, which are on, its volume,
 * whether it can pause), or nothing (an empty report: nothing playing). For its own sign-in's targets: the one named
 * ([targetId], a browser tab, as a browser's tabs share a sign-in), or all of them (Kodi, the app). False when it
 * isn't a target.
 */
export function reportControls(req, body = {}) {
  const controls = cleanControls(body);
  let found = false;
  for (const t of targets.values()) {
    if (t.sessionId !== req.sessionId || t.userId !== req.user.id) continue;
    if (body.targetId && t.id !== String(body.targetId)) continue;
    found = true;
    if (JSON.stringify(t.controls) === JSON.stringify(controls)) continue;
    t.controls = controls;
    relayState(t);
  }
  return found;
}

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

/**
 * The episode before or after the one a target is playing, for next/previous (Kodi plays it; the apps go on); one
 * all of [users] may open (the phone's person, and the device's when it's someone else's).
 */
function neighbour(users, target, type) {
  const itemId = stateOf(target)?.itemId;
  const row = itemId && getAccessibleItem(users[0], itemId);
  if (!row || row.type !== 'episode') throw new RemoteError(409, `${target.name} isn't playing an episode.`);
  const { prev, next } = adjacentEpisodes(row);
  const other = type === 'next' ? next : prev;
  const playable = other && users.every((u) => getAccessibleItem(u, other.id)) ? getAccessibleItem(users[0], other.id) : null;
  if (!playable?.file_path) {
    throw new RemoteError(409, type === 'next' ? 'This is the last episode.' : 'This is the first episode.');
  }
  return playable.id;
}

/** Whether Live TV is there for all of [users] (it's on, and each may watch it). */
const liveTvFor = (users) => liveTvOn() && users.every((u) => u?.liveTv);

/** The channel to play: { channel, radio, name }, after checking Live TV and the channel. */
async function channelCommand(users, uuid) {
  if (!liveTvFor(users)) throw new RemoteError(403, 'Live TV isn’t available for this.');
  const channel = await channelByUuid(String(uuid)).catch(() => null);
  if (!channel) throw new RemoteError(404, 'That channel isn’t there any more.');
  return { channel: channel.uuid, radio: !!channel.radio, name: channel.name };
}

/**
 * The channel after or before the one a target plays (channel up/down): the next of the same kind (TV or radio) in
 * the channel list's order, round from the end to the start, as the players' own channel buttons go.
 */
async function nextChannel(users, target, type) {
  const now = stateOf(target);
  if (!liveTvFor(users)) throw new RemoteError(403, 'Live TV isn’t available for this.');
  const list = (await channels().catch(() => [])).filter((c) => !!c.radio === !!now.radio || c.uuid === now.channel);
  const i = list.findIndex((c) => c.uuid === now.channel);
  if (i < 0 || list.length < 2) throw new RemoteError(409, 'There’s no other channel to go to.');
  const step = type === 'next' ? 1 : -1;
  const other = list[(i + step + list.length) % list.length];
  return { channel: other.uuid, radio: !!other.radio, name: other.name };
}

/** A track id the target offered ([kind]: audio | subtitles), or a 409. */
function offered(target, kind, id) {
  const list = target.controls?.[kind] || [];
  const found = list.find((t) => t.id === String(id));
  if (!found) throw new RemoteError(409, `That isn’t on ${target.name} any more.`);
  return found.id;
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
  const gone = "That device isn't there any more: is Reelhouse still open on it?";
  if (!target || (target.userId !== req.user.id && !target.shared) || !alive(target)) throw new RemoteError(404, gone);
  const type = String(body.type || '');
  if (!COMMANDS.has(type)) throw new RemoteError(400, 'Unknown command.');
  await refreshTunnelStatus();
  const network = networkOf(whereFrom(req));
  if (!network || networkOf(target.where) !== network) {
    throw new RemoteError(403, `${target.name} isn't on the same network as this phone.`);
  }
  // Someone else's shared device plays as its own account: only what both may see.
  const owner = target.userId === req.user.id ? null : loadUser(target.userId);
  if (target.userId !== req.user.id && !owner) throw new RemoteError(404, gone);
  const users = owner ? [req.user, owner] : [req.user];
  const command = { id: crypto.randomBytes(9).toString('base64url'), type };
  if (type === 'play' && body.channel != null) {
    Object.assign(command, await channelCommand(users, body.channel));
  } else if (type === 'play') {
    const itemId = number(body.itemId);
    const row = Number.isInteger(itemId) && itemId > 0 && users.every((u) => getAccessibleItem(u, itemId)) ? getAccessibleItem(req.user, itemId) : null;
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
    // While a channel plays: channel up and down, sent as a play of that channel (zap: in the player already open).
    if (stateOf(target)?.live) Object.assign(command, { type: 'play', zap: true }, await nextChannel(users, target, type));
    else command.itemId = neighbour(users, target, type);
  } else if (type === 'audio') {
    command.track = offered(target, 'audio', body.track);
  } else if (type === 'subtitle') {
    command.track = body.track == null ? null : offered(target, 'subtitles', body.track);
  } else if (type === 'volume') {
    const level = number(body.level);
    if (!Number.isFinite(level) || level < 0 || level > 100) throw new RemoteError(400, 'The volume goes from 0 to 100.');
    if (target.controls?.volume == null) throw new RemoteError(409, `${target.name}'s volume can't be changed from here.`);
    command.level = Math.round(level);
  } else if (type === 'mute') {
    command.muted = !!body.muted;
  }
  const device = (req.device || browserName(req.headers?.['user-agent'])).slice(0, 80);
  command.from = owner ? `${req.user.username}'s ${device}`.slice(0, 80) : device;
  for (const [id, c] of commands) if (now - c.at > ANSWER_WITHIN_MS) commands.delete(id);
  commands.set(command.id, {
    senderUserId: req.user.id,
    senderSession: req.sessionId,
    targetId: target.id,
    targetUserId: target.userId,
    targetSession: target.sessionId,
    at: now,
  });
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
  // Only from the device it went to (its own sign-in: the owner's, for a shared device of someone else's).
  if (!command || command.targetUserId !== req.user.id || command.targetSession !== req.sessionId) return false;
  commands.delete(String(commandId));
  const answer = {
    id: String(commandId),
    targetId: command.targetId,
    ok: body.ok !== false,
    problem: body.problem ? String(body.problem).slice(0, PROBLEM_LENGTH) : null,
  };
  for (const c of controllers) {
    if (c.userId === command.senderUserId && c.sessionId === command.senderSession && alive(c)) sendTo(c.client, 'remote-done', answer);
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
