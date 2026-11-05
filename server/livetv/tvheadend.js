// Reelhouse's side of Tvheadend (Live TV): its HTTP JSON API (/api/…) and stream links, signed in with the account
// set in Settings → Live TV. Tvheadend asks for Digest by default (Basic in its "Plain" mode); either is answered
// from its challenge, and the challenge is reused so most requests need no extra round trip.
//
// Streams use Tvheadend's tickets: /playlist/ticket/channel/<uuid> answers with a link that carries a ticket (valid
// for a few minutes) instead of a password, so ffmpeg gets no credentials on its command line or in the log.
import { basicAuthorization, digestAuthorization, parseChallenges, pickDigest } from './digest.js';
import { imageKind } from '../avatars.js';

const TIMEOUT_MS = 10000;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
// DVB service types of radio: digital radio sound, FM radio, advanced codec digital radio sound.
const RADIO_SERVICE_TYPES = new Set([0x02, 0x07, 0x0a]);
// An autorec's "duplicate handling": skip what the guide's programme ids (else episode numbers, else subtitle and
// description) say is a repeat; skip the same episode number; as its recording profile says.
const RECORD_IF_UNIQUE = 14;
const RECORD_IF_NEW_EPISODE = 1;
const RECORD_AS_PROFILE = 15;

/** What a picture is, from its first bytes (Tvheadend's image cache sends no Content-Type): png, jpeg, gif, webp, svg or null. */
export function iconKind(body) {
  const kind = imageKind(body.subarray(0, 16));
  if (kind && kind !== 'heif') return kind;
  const text = body.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text) ? 'svg' : null;
}

export const ICON_TYPES = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

export class TvheadendError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * Settings → Live TV's "Test connection": what Tvheadend says to this account. Throws a readable error when it
 * can't be reached or refuses the login.
 */
export async function checkTvheadend(tvh) {
  let info;
  try {
    info = await tvh.serverInfo();
  } catch (err) {
    // Tvheadend answers a wrong password with 403 too (it falls back to its anonymous entry).
    if (err.status === 403) {
      throw new TvheadendError('Tvheadend refused this login: check the username and password, and that the account has the "Web interface" right', 403);
    }
    throw err;
  }
  const [list, tags, radioServices] = await Promise.all([
    tvh.channels(), tvh.channelTags().catch(() => []), tvh.radioServices().catch(() => null),
  ]);
  const channels = withRadio(list, tags, radioServices);
  const dvrConfigs = await tvh.dvrConfigs();
  // The recordings drive, for accounts that may record (Tvheadend only tells those).
  const diskSpace = dvrConfigs ? await tvh.diskSpace().catch(() => null) : null;
  let canStream = false;
  let streamProblem = channels.length ? null : 'Tvheadend has no channels this account may watch';
  if (channels.length) {
    try {
      await tvh.streamUrl(channels[0].uuid);
      canStream = true;
    } catch (err) {
      streamProblem = err.status === 403 ? 'This account has no "Streaming" right in Tvheadend' : err.message;
    }
  }
  return {
    name: info.name || 'Tvheadend', version: info.sw_version || null, apiVersion: info.api_version ?? null,
    channels: channels.length, radio: channels.filter((c) => c.radio).length,
    canStream, streamProblem, canRecord: !!dvrConfigs, dvrConfigs: dvrConfigs || [], diskSpace,
  };
}

/**
 * Marks the radio stations among channels(): tagged with a tag that has "radio" in its name (Tvheadend's
 * type-based tags: "Radio channels"), or, when this account may see services (`radioServices` not null), all of
 * whose services are radio.
 */
export function withRadio(list, tags, radioServices) {
  const radioTags = new Set(tags.filter((t) => /radio/i.test(t.name)).map((t) => t.uuid));
  return list.map((c) => ({
    ...c,
    radio: c.tags.some((t) => radioTags.has(t))
      || (!!radioServices && c.services.length > 0 && c.services.every((s) => radioServices.has(s))),
  }));
}

/**
 * A recording's show name, without the "New: " UK guides put in front of a new episode's ("New: Mock The Week"), so
 * new episodes and repeats are one show on the Recordings page (and TMDB is asked about the show's own name).
 */
export function recordingTitle(title) {
  return String(title || '').replace(/^\s*new\s*:\s*/i, '').trim() || 'Untitled';
}

/**
 * What a series recording looks for when the guide has no series link: the show's whole name, with or without "New: "
 * in front (so "News" doesn't catch "Newsnight"). Tvheadend ignores case here, and reads it as a regular expression.
 */
export function seriesTitlePattern(name) {
  return `^(new *: *)?${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * A recording's series and episode numbers ({ season, episode }, either null): from Tvheadend's "Season 1.Episode 4"
 * (as its guide gave them), else from "S01E04" in the file's name.
 */
export function seasonEpisode(episodeDisp, filename) {
  const n = (m) => (m ? Number(m[1]) : null);
  const text = String(episodeDisp || '');
  let season = n(/season\s*(\d+)/i.exec(text));
  let episode = n(/episode\s*(\d+)/i.exec(text));
  if (season == null && episode == null) {
    const name = /S(\d{1,3})E(\d{1,4})/i.exec(String(filename || '').split(/[\\/]/).pop());
    if (name) [season, episode] = [Number(name[1]), Number(name[2])];
  }
  return { season, episode };
}

/** "http://192.168.1.50:9981" (and a web root, e.g. "/tvh"), from what someone typed; throws on anything else. */
export function tvheadendUrl(value) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Tvheadend\'s address must look like http://192.168.1.50:9981');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Tvheadend\'s address must start with http:// or https://');
  if (url.username || url.password) throw new Error('Put the Tvheadend username and password in their own boxes, not in the address');
  if (url.search || url.hash) throw new Error('Tvheadend\'s address can\'t have ? or # in it');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * A recording's state from Tvheadend's word for it in the guide: scheduled, recording (also its "recordingError", under
 * way but with a problem: waiting for a tuner or a stream), completed, or failed (its other "completed…" words).
 */
export function guideRecordingState(status) {
  const word = String(status || 'scheduled');
  if (word.startsWith('recording')) return 'recording';
  if (word.startsWith('completed')) return word === 'completed' ? 'completed' : 'failed';
  return word;
}

/** The uuid in Tvheadend's answer to making something, which some calls give in a list and some on its own. */
const uuidIn = (res) => (Array.isArray(res?.uuid) ? res.uuid[0] : res?.uuid) || null;

/** One of Tvheadend's DVR entries as recordings() has it. */
const recordingEntry = (e, state) => ({
  uuid: e.uuid,
  state,
  title: recordingTitle(e.disp_title),
  subtitle: e.disp_subtitle || null,
  description: e.disp_description || e.disp_summary || null,
  channel: e.channel || null,
  channelName: e.channelname || null,
  start: e.start,
  stop: e.stop,
  size: e.filesize > 0 ? e.filesize : null,
  status: e.status || null,
  eventId: e.broadcast || null,
  ...seasonEpisode(e.episode_disp, e.filename),
  image: e.image || e.fanart_image || null,
  series: e.autorec || null,
  skipped: e.enabled === false,
  problem: e.sched_status === 'recordingError', // under way, but `status` says what's wrong ("Waiting for stream")
});

const upcomingEntry = (e) => recordingEntry(e, guideRecordingState(e.sched_status) === 'recording' ? 'recording' : 'scheduled');

export class Tvheadend {
  /** `url` as tvheadendUrl gives it; no username means no sign-in (Tvheadend allowing anyone). */
  constructor({ url, username = '', password = '' }) {
    this.base = tvheadendUrl(url);
    this.origin = new URL(this.base).origin;
    this.username = username;
    this.password = password;
    this.digest = null; // the last Digest challenge's params
    this.nc = 0;
    this.basic = false;
  }

  authorization(method, url) {
    if (!this.username) return null;
    if (this.digest) {
      this.nc += 1;
      return digestAuthorization({
        params: this.digest, username: this.username, password: this.password, method, uri: url.pathname + url.search, nc: this.nc,
      });
    }
    return this.basic ? basicAuthorization(this.username, this.password) : null;
  }

  /** A request to Tvheadend: `path` relative to its address (e.g. "api/serverinfo"); `form` makes it a POST. */
  async request(path, { form = null, timeoutMs = TIMEOUT_MS, signal } = {}) {
    const url = new URL(`${this.base}/${path.replace(/^\/+/, '')}`);
    const method = form ? 'POST' : 'GET';
    let sentWith = null; // what the last attempt answered with: a Digest nonce, 'basic', or null
    const send = () => {
      const headers = { Accept: 'application/json, text/plain, */*', 'User-Agent': 'Reelhouse' };
      const auth = this.authorization(method, url);
      if (auth) headers.Authorization = auth;
      sentWith = !auth ? null : this.digest ? this.digest.nonce : 'basic';
      const body = form ? new URLSearchParams(Object.entries(form).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) : undefined;
      return fetch(url, { method, headers, body, signal: signal || AbortSignal.timeout(timeoutMs) });
    };
    let res;
    try {
      res = await send();
      // Asked to sign in: answer once, unless this very challenge was already answered (a wrong password). Requests
      // sent together all get a challenge; each answers with the newest one known.
      if (res.status === 401 && this.username) {
        const challenges = parseChallenges(res.headers.get('www-authenticate'));
        const digest = pickDigest(challenges);
        if (digest && digest.params.nonce !== sentWith) {
          if (!this.digest || this.digest.nonce !== digest.params.nonce) {
            this.digest = digest.params;
            this.nc = 0;
          }
          res = await send();
        } else if (!digest && challenges.some((c) => c.scheme === 'basic') && sentWith !== 'basic') {
          this.digest = null;
          this.basic = true;
          res = await send();
        }
      }
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new TvheadendError(`Tvheadend at ${this.base} didn't answer in time`);
      }
      const reason = err.cause?.code === 'ECONNREFUSED' ? 'nothing answers on that port'
        : err.cause?.code === 'ENOTFOUND' ? 'that name isn\'t known'
          : err.cause?.code === 'EHOSTUNREACH' || err.cause?.code === 'ENETUNREACH' ? 'that address can\'t be reached'
            : err.cause?.message || err.message;
      throw new TvheadendError(`Couldn't reach Tvheadend at ${this.base}: ${reason}`);
    }
    if (res.status === 401) {
      throw new TvheadendError(this.username ? 'Tvheadend didn\'t accept the username or password' : 'Tvheadend needs a username and password', 401);
    }
    if (res.status === 403) throw new TvheadendError('This Tvheadend account isn\'t allowed to do that', 403);
    if (res.status === 404) throw new TvheadendError(`Tvheadend has nothing at ${url.pathname} (is the address right, including any web root?)`, 404);
    if (!res.ok) throw new TvheadendError(`Tvheadend answered ${res.status} for ${url.pathname}`, 502);
    return res;
  }

  async api(path, form) {
    const res = await this.request(`api/${path}`, { form });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new TvheadendError(`Tvheadend sent something other than JSON for ${path} (is this Tvheadend's address?)`);
    }
  }

  /** { name, sw_version, api_version, capabilities }. Needs the account's "Web interface" right. */
  serverInfo() {
    return this.api('serverinfo');
  }

  /**
   * The channels this account may watch, by number: [{ uuid, name, number, icon, iconSource, tags, services }].
   * `icon` is where Tvheadend serves the logo (its image cache, "imagecache/12", or a full URL); `iconSource` is the
   * logo's own address (a picon file, or a web address), tried when the first fails.
   */
  async channels() {
    const grid = await this.api('channel/grid', { start: 0, limit: 100000, sort: 'number', dir: 'ASC' });
    return (grid.entries || [])
      .filter((c) => c.enabled !== false)
      .map((c) => ({
        uuid: c.uuid,
        name: c.name || 'Unnamed channel',
        number: Number(c.number) || null,
        icon: c.icon_public_url || c.icon || null,
        iconSource: c.icon || null,
        tags: c.tags || [],
        services: c.services || [],
      }))
      .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.name.localeCompare(b.name));
  }

  /**
   * Tvheadend's names for guide genres, { 16: 'Movie / Drama', 20: 'Comedy', … }: the content types of ETSI EN 300 468
   * that broadcasts carry (and XMLTV categories with those names become).
   */
  async genreNames() {
    const list = await this.api('epg/content_type/list', { full: 1 });
    return Object.fromEntries((list.entries || []).filter((e) => e.val).map((e) => [e.key, e.val]));
  }

  /** The channel tags this account can see: [{ uuid, name }] (e.g. "TV channels", "Radio channels"). */
  async channelTags() {
    const grid = await this.api('channeltag/grid', { start: 0, limit: 10000 });
    return (grid.entries || []).map((t) => ({ uuid: t.uuid, name: t.name || '' }));
  }

  /**
   * The services that are radio (by their DVB service type), as a Set of service uuids; null when this account may
   * not see services (only Tvheadend admins may).
   */
  async radioServices() {
    try {
      const grid = await this.api('mpegts/service/grid', { start: 0, limit: 100000 });
      return new Set((grid.entries || []).filter((s) => RADIO_SERVICE_TYPES.has(Number(s.dvb_servicetype))).map((s) => s.uuid));
    } catch (err) {
      if (err.status === 403) return null;
      throw err;
    }
  }

  /**
   * Guide entries overlapping [from, to) (epoch seconds), sorted by start. Asked for with Tvheadend's filter, and
   * filtered here as well in case an older Tvheadend ignores it.
   */
  async guide(from, to) {
    const filter = [
      { field: 'start', type: 'numeric', value: String(to), comparison: 'lt' },
      { field: 'stop', type: 'numeric', value: String(from), comparison: 'gt' },
    ];
    const grid = await this.api('epg/events/grid', { start: 0, limit: 100000, sort: 'start', dir: 'ASC', filter });
    return (grid.entries || []).filter((e) => e.start < to && e.stop > from).sort((a, b) => a.start - b.start);
  }

  /** The recording profiles, or null when this account may not record (no "Video recorder" right). */
  async dvrConfigs() {
    try {
      const grid = await this.api('dvr/config/grid', { start: 0, limit: 1000 });
      return (grid.entries || []).map((c) => ({ uuid: c.uuid, name: c.name || 'Default profile' }));
    } catch (err) {
      if (err.status === 403) return null;
      throw err;
    }
  }

  /**
   * The recordings drive as Tvheadend's own web interface shows it: { free, total, recordings } in bytes (recordings =
   * what its recordings take up), or null when this account may not record. Tvheadend has no API call for it: it's in
   * the message a newly opened web interface gets (`comet/poll`, which opens a mailbox Tvheadend drops once unused).
   */
  async diskSpace() {
    const res = await this.request('comet/poll', { form: {} });
    const body = await res.json().catch(() => ({}));
    const access = (body.messages || []).find((m) => m.notificationClass === 'accessUpdate');
    if (!(access?.totaldiskspace > 0) || !(access.freediskspace >= 0)) return null;
    return { free: access.freediskspace, total: access.totaldiskspace, recordings: access.useddiskspace ?? null };
  }

  /**
   * Schedules a guide entry; returns the new recording's uuid when Tvheadend says it. `comment` shows in Tvheadend's
   * own list of recordings (who asked for it in Reelhouse).
   */
  async record(eventId, configUuid = '', comment = '') {
    // Tvheadend needs config_uuid there, even empty (its default profile): without it the request is refused.
    const form = { event_id: String(eventId), config_uuid: configUuid || '' };
    if (comment) form.comment = comment;
    return uuidIn(await this.api('dvr/entry/create_by_event', form));
  }

  /**
   * The recordings this account may see (Tvheadend shows an account its own, or every one with its "all DVR entries"
   * right): [{ uuid, state, title, subtitle, description, channel, channelName, start, stop, size, status, eventId,
   * season, episode, image }]. `state` is where Tvheadend keeps it: scheduled or recording (its upcoming list),
   * recorded, or failed; `status` is Tvheadend's own word for it ("Completed OK", "Time missed"…); `size` in bytes, once
   * something is on disk; `image` the guide's picture for it, when the guide has one; `series` the series recording that
   * made it, while that's still there; `skipped` when it's been switched off (switchRecording).
   */
  async recordings() {
    const [upcoming, finished, failed] = await Promise.all(['grid_upcoming', 'grid_finished', 'grid_failed'].map((name) => this.dvrGrid(name)));
    return [
      ...upcoming.map(upcomingEntry),
      ...finished.map((e) => recordingEntry(e, 'recorded')),
      ...failed.map((e) => recordingEntry(e, 'failed')),
    ];
  }

  /** Those still to come or under way, as recordings() has them. */
  async upcoming() {
    return (await this.dvrGrid('grid_upcoming')).map(upcomingEntry);
  }

  async dvrGrid(name) {
    return (await this.api(`dvr/entry/${name}`, { start: 0, limit: 100000 })).entries || [];
  }

  /** A scheduled recording no longer wanted. */
  cancelRecording(uuid) {
    return this.api('dvr/entry/cancel', { uuid });
  }

  /**
   * Switches a scheduled recording off or back on. Cancelling one a series recording made doesn't last: Tvheadend keeps
   * no note of it and schedules it again the next time it checks; one switched off stays, and doesn't record.
   */
  switchRecording(uuid, on) {
    return this.api('idnode/save', { node: { uuid, enabled: !!on } });
  }

  /** Ends a recording under way early, keeping what's recorded. */
  stopRecording(uuid) {
    return this.api('dvr/entry/stop', { uuid });
  }

  /** Deletes a finished (or failed) recording: its file and its entry. */
  removeRecording(uuid) {
    return this.api('dvr/entry/remove', { uuid });
  }

  /** One guide entry, however far ahead (guide() and its copies only cover the hours asked for), or null. */
  async guideEntry(eventId) {
    return (await this.api('epg/events/load', { eventId })).entries?.[0] || null;
  }

  /**
   * The series recordings (Tvheadend's autorecs) this account may see: [{ uuid, title, channel, serieslink }]. `title`
   * is the name it was given, without "New: ", else what it looks for (one set in Tvheadend may have no name).
   */
  async seriesRecordings() {
    const grid = await this.api('dvr/autorec/grid', { start: 0, limit: 10000 });
    return (grid.entries || []).map((e) => ({
      uuid: e.uuid, title: recordingTitle(e.name || e.title), channel: e.channel || null, serieslink: e.serieslink || null,
    }));
  }

  /**
   * Tvheadend's setting for leaving out repeats, of those it has: by the guide's programme ids and episode numbers, else
   * by episode numbers alone, else what its recording profile says. It's asked rather than assumed, as Tvheadend stops
   * altogether if it comes across a setting it doesn't know.
   */
  async skipRepeatsSetting() {
    const props = (await this.api('idnode/class', { name: 'dvrautorec' })).props || [];
    const choices = props.find((p) => p.id === 'record')?.enum;
    const known = new Set(Array.isArray(choices) ? choices.map((c) => c.key) : []);
    return [RECORD_IF_UNIQUE, RECORD_IF_NEW_EPISODE].find((key) => known.has(key)) ?? RECORD_AS_PROFILE;
  }

  /**
   * Starts a series recording of a show on one channel: every episode from now on, by the guide's series link when it
   * has one, else by the show's name. Returns its uuid when Tvheadend says it.
   */
  async createSeries({ name, channel, serieslink = null, configUuid = '', comment = '' }) {
    const conf = {
      enabled: 1, name, title: seriesTitlePattern(name), channel, comment,
      record: await this.skipRepeatsSetting().catch(() => RECORD_AS_PROFILE),
    };
    if (serieslink) conf.serieslink = serieslink;
    if (configUuid) conf.config_name = configUuid;
    return uuidIn(await this.api('dvr/autorec/create', { conf }));
  }

  /** Ends a series recording: Tvheadend cancels what it had scheduled; what's recording or recorded stays. */
  removeSeries(uuid) {
    return this.api('idnode/delete', { uuid });
  }

  /**
   * A link ffmpeg can read the channel from (raw MPEG-TS, "pass" profile), with a ticket instead of a password.
   * Tvheadend writes links with the address it was asked on; they're pointed back at the configured one.
   */
  async streamUrl(channelUuid) {
    const res = await this.request(`playlist/ticket/channel/${encodeURIComponent(channelUuid)}`);
    const text = await res.text();
    const line = text.split(/\r?\n/).find((l) => /^https?:\/\//i.test(l.trim()));
    if (!line) throw new TvheadendError('Tvheadend gave no stream link for that channel', 404);
    const url = new URL(line.trim());
    const own = new URL(this.base);
    url.protocol = own.protocol;
    url.host = own.host;
    if (!url.searchParams.get('profile')) url.searchParams.set('profile', 'pass');
    return url.toString();
  }

  /**
   * A channel's logo: from Tvheadend's address for it (its image cache, signed in) or, failing that, the logo's own
   * web address (fetched without Tvheadend's credentials, which only ever go to Tvheadend). Picon files (file://)
   * are only reachable through Tvheadend. Returns { kind, type, body } or null; judged by its bytes, as Tvheadend's
   * image cache sends no Content-Type.
   */
  async icon(icon, iconSource = null) {
    for (const address of [...new Set([icon, iconSource].filter(Boolean))]) {
      const got = await this.iconFrom(address).catch(() => null);
      if (got) return got;
    }
    return null;
  }

  async iconFrom(address) {
    let res;
    const absolute = /^https?:\/\//i.test(address);
    if (absolute && new URL(address).origin !== this.origin) {
      res = await fetch(address, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'Reelhouse' } });
      if (!res.ok) return null;
    } else if (absolute || !/^[a-z][a-z0-9+.-]*:/i.test(address)) {
      const path = absolute ? new URL(address).pathname.slice(new URL(this.base).pathname.length) : address;
      res = await this.request(path.replace(/^\/+/, ''));
    } else {
      return null; // file://, picon://: only Tvheadend can read those
    }
    if (Number(res.headers.get('content-length')) > MAX_ICON_BYTES) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > MAX_ICON_BYTES) return null;
    const kind = iconKind(body);
    return kind ? { kind, type: ICON_TYPES[kind], body } : null;
  }
}
