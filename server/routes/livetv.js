// Live TV from Tvheadend: the guide, playing a channel (server/transcode/live.js) and scheduling recordings, for
// accounts an admin allows (Settings → Users), while Live TV is on (Settings → Live TV).
import { Router } from 'express';
import { requireUser, clientIp, loadUser } from '../auth.js';
import { all, get, placeholders, run } from '../db.js';
import { getSetting } from '../settings.js';
import { qualityById } from '../transcode/profile.js';
import { activeTranscodeCount } from '../transcode/hls.js';
import { getLiveSession, startLiveSession } from '../transcode/live.js';
import {
  account, channelByUuid, channels, forgetGuide, genreNames, guideWindow, learnRadio, liveTvOn, tvheadend, upcomingRecordings,
} from '../livetv/guide.js';
import { channelIcon, iconVersion } from '../livetv/icons.js';
import { groupShows, prefetchPoster, recordingArt, seriesList, showKey } from '../livetv/recordings.js';
import { guideRecordingState, recordingTitle } from '../livetv/tvheadend.js';
import {
  clientName, endStream, logStreamLimit, reportStream, startStream, streamLimitMessage, streamLimitReached,
} from '../activity.js';
import { logger } from '../lib/log.js';

const log = logger('livetv');
const router = Router();

const HALF_HOUR = 1800;
const MAX_WINDOW = 24 * 3600;

function requireLiveTv(req, res, next) {
  if (!liveTvOn()) return res.status(404).json({ error: 'Live TV is turned off' });
  if (!req.user.liveTv) return res.status(403).json({ error: 'Your account can\'t watch live TV' });
  next();
}

async function requireRecording(req, res, next) {
  if (!req.user.liveTvRecord) return res.status(403).json({ error: 'Your account can\'t schedule recordings' });
  try {
    if (!(await account()).canRecord) {
      return res.status(403).json({ error: 'Tvheadend\'s account isn\'t allowed to record (give it the "Video recorder" right in Tvheadend)' });
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  next();
}

function requireSeries(req, res, next) {
  if (!req.user.liveTvSeries) return res.status(403).json({ error: 'Your account can\'t set series recordings' });
  next();
}

const fail = (res, err) => res.status(err.status && err.status < 600 ? err.status : 502).json({ error: err.message });

// The logo's address carries when it was fetched, so browsers keep it for long and still see a new one.
const publicChannel = (c) => {
  const v = iconVersion(c.uuid);
  return {
    uuid: c.uuid, name: c.name, number: c.number, radio: !!c.radio,
    icon: c.icon || c.iconSource || v ? `/api/livetv/channels/${c.uuid}/icon${v ? `?v=${v}` : ''}` : null,
  };
};

// `canChange` (the guide, for one person): whether they may cancel or stop its recording (see mayChange); `upcoming`:
// what Tvheadend's list of recordings says about it, by uuid, which the guide entry doesn't (see upcomingRecordings).
const publicEvent = (e, genres = {}, canChange = null, upcoming = new Map()) => ({
  id: e.eventId,
  channel: e.channelUuid,
  start: e.start,
  stop: e.stop,
  title: e.title || 'Untitled',
  subtitle: e.subtitle || null,
  summary: e.summary || null,
  description: e.description || null,
  season: e.seasonNumber ?? null,
  episode: e.episodeNumber ?? null,
  episodeLabel: e.episodeOnscreen || null,
  genre: e.genre || [],
  // The first genre Tvheadend has a name for (e.g. "Comedy"), else its group's ("Movie / Drama").
  genreName: (e.genre || []).map((g) => genres[g] || genres[g & 0xf0]).find(Boolean) || null,
  // Scheduled or recording in Tvheadend: { uuid, state: scheduled | recording | skipped | completed | failed, canChange, series },
  // `series` being the series recording that made it, if one did.
  dvr: e.dvrUuid ? {
    uuid: e.dvrUuid,
    state: upcoming.get(e.dvrUuid)?.skipped ? 'skipped' : guideRecordingState(e.dvrState),
    ...(canChange && { canChange: canChange(e.dvrUuid) }),
    series: upcoming.get(e.dvrUuid)?.series || null,
  } : null,
});

/** What's on a channel now and next (from a cached guide window). */
async function nowAndNext(channelUuid) {
  const now = Math.floor(Date.now() / 1000);
  const from = Math.floor(now / HALF_HOUR) * HALF_HOUR;
  const events = (await guideWindow(from, from + 6 * 3600).catch(() => [])).filter((e) => e.channelUuid === channelUuid);
  const current = events.find((e) => e.start <= now && e.stop > now) || null;
  const next = events.find((e) => e.start >= (current?.stop ?? now)) || null;
  return { now: current && publicEvent(current), next: next && publicEvent(next) };
}

router.get('/livetv/channels', requireUser, requireLiveTv, async (req, res) => {
  try {
    res.json({ channels: (await channels()).map(publicChannel) });
  } catch (err) {
    fail(res, err);
  }
});

// The guide for [from, to) in epoch seconds (from is rounded down to the half hour; at most a day at a time).
router.get('/livetv/guide', requireUser, requireLiveTv, async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const askedFrom = Number(req.query.from) || now;
  const from = Math.floor(askedFrom / HALF_HOUR) * HALF_HOUR;
  const to = Math.min(Math.max(Number(req.query.to) || from + 6 * 3600, from + HALF_HOUR), from + MAX_WINDOW);
  try {
    const [list, events, acc, genres] = await Promise.all([
      channels(), guideWindow(from, to), req.user.liveTvRecord ? account().catch(() => null) : null, genreNames().catch(() => ({})),
    ]);
    const scheduled = [...new Set(events.map((e) => e.dvrUuid).filter(Boolean))];
    const upcoming = scheduled.length ? await upcomingRecordings().catch(() => []) : [];
    adoptSeriesRecordings(upcoming);
    const owners = ownersOf(scheduled);
    const canChange = (uuid) => mayChange(req.user, owners.get(uuid) ?? null);
    const known = new Map(upcoming.map((r) => [r.uuid, r]));
    res.json({
      from, to, now,
      channels: list.map(publicChannel),
      events: events.map((e) => publicEvent(e, genres, canChange, known)),
      canRecord: !!(req.user.liveTvRecord && acc?.canRecord),
      canRecordSeries: !!(req.user.liveTvSeries && acc?.canRecord),
    });
  } catch (err) {
    fail(res, err);
  }
});

// A channel's logo, kept on disk (server/livetv/icons.js): from Tvheadend the first time, then from the copy.
router.get('/livetv/channels/:uuid/icon', requireUser, requireLiveTv, async (req, res) => {
  const channel = await channelByUuid(req.params.uuid).catch(() => null);
  const icon = channel ? await channelIcon(tvheadend(), channel) : null;
  if (!icon) return res.status(404).end();
  res.setHeader('Content-Type', icon.type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // An SVG logo opened on its own mustn't run anything on Reelhouse's address.
  if (icon.kind === 'svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  // Versioned addresses (?v=) don't change: kept a week; the plain one is checked daily.
  res.setHeader('Cache-Control', `private, max-age=${req.query.v ? 7 * 86400 : 86400}`);
  res.sendFile(icon.file, { cacheControl: false, dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

function streamDetails(req, channel, extra = {}) {
  return {
    userId: req.user.id,
    username: req.user.username,
    itemId: `live:${channel.uuid}`,
    title: channel.name,
    grandparentTitle: null,
    channelUuid: channel.uuid,
    radio: !!channel.radio,
    ip: clientIp(req),
    client: clientName(req),
    mode: 'live',
    ...extra,
  };
}

// Starts a channel for this player: answers once the first seconds are ready, or with why it can't play.
router.post('/livetv/play/:uuid', requireUser, requireLiveTv, async (req, res) => {
  const body = req.body || {};
  let channel;
  try {
    channel = await channelByUuid(req.params.uuid);
  } catch (err) {
    return fail(res, err);
  }
  if (!channel) return res.status(404).json({ error: 'No such channel' });
  // A channel change: the previous channel stops first (freeing its tuner) and counts as the same device.
  if (body.previousSession) {
    const prev = getLiveSession(body.previousSession);
    if (prev && prev.userId === req.user.id) {
      prev.destroy();
      endStream(prev.id, 'stopped');
    }
  }
  const details = streamDetails(req, channel);
  const limited = streamLimitReached(req.user.id, req.user.streamLimit, details);
  if (limited) {
    logStreamLimit(details, limited);
    return res.status(429).json({ error: streamLimitMessage(limited), code: 'stream_limit', limit: limited.limit });
  }
  const max = Number(getSetting('maxTranscodes')) || 0;
  if (max > 0 && activeTranscodeCount() >= max) {
    return res.status(503).json({ error: `The server is already converting ${max} video(s). Try again later.` });
  }
  const quality = qualityById(body.quality);
  // The player may stop waiting (a quick channel change, or leaving): what was started for it is then let go as soon
  // as it's ready, rather than holding a tuner and a place in the device limit until it goes quiet.
  let gone = false;
  res.on('close', () => {
    if (!res.writableFinished) gone = true;
  });
  let session;
  try {
    session = await startLiveSession({
      channel, quality, userId: req.user.id, streamUrl: () => tvheadend().streamUrl(channel.uuid),
      onRadio: () => learnRadio(channel.uuid),
    });
  } catch (err) {
    log.warn(`User "${req.user.username}" couldn't start live TV "${channel.name}": ${err.message}`);
    return fail(res, err);
  }
  const { now, next } = await nowAndNext(channel.uuid);
  if (gone) {
    log.debug(`Live TV "${channel.name}" let go: its player stopped waiting for it`);
    session.destroy();
    return;
  }
  startStream(session.id, {
    ...details, radio: session.radio, duration: null, quality: session.quality.id, qualityLabel: session.quality.label, reasons: [],
    programme: now?.title || null,
  });
  res.json({
    playId: session.id,
    url: `/api/live/${session.id}/index.m3u8`,
    // Radio (said by Tvheadend, or found now: no picture): the player shows the station instead of a picture.
    radio: session.radio,
    channel: { ...publicChannel(channel), radio: session.radio },
    // What it's converted at (a preset above the channel is the original), and what's worth offering for it.
    quality: session.quality.id,
    qualities: session.qualities().map((q) => q.id),
    now,
    next,
  });
});

// What's on now and next on a channel (the player refreshes it as programmes change).
router.get('/livetv/channels/:uuid/now', requireUser, requireLiveTv, async (req, res) => {
  res.json(await nowAndNext(req.params.uuid));
});

// The live player's heartbeat (every 10 s while open): keeps its conversion going and the activity list current.
router.post('/livetv/progress', requireUser, requireLiveTv, (req, res) => {
  const { playId, state } = req.body || {};
  const session = getLiveSession(playId);
  if (!session || session.userId !== req.user.id) return res.status(404).json({ error: 'Session expired' });
  session.touch();
  reportStream(playId, streamDetails(req, session.channel, {
    radio: session.radio,
    state: ['playing', 'paused', 'stopped'].includes(state) ? state : 'playing',
    position: null,
    quality: session.quality.id,
    qualityLabel: session.quality.label,
  }));
  // Stopping frees Tvheadend's tuner straight away rather than when the player goes quiet.
  if (state === 'stopped') session.destroy();
  res.json({ ok: true });
});

/** A guide entry from the cached windows, for the log's wording. */
async function knownEvent(eventId) {
  const now = Math.floor(Date.now() / 1000);
  const from = Math.floor(now / HALF_HOUR) * HALF_HOUR;
  const events = await guideWindow(from - 6 * 3600, from + MAX_WINDOW).catch(() => []);
  return events.find((e) => String(e.eventId) === String(eventId)) || null;
}

router.post('/livetv/record', requireUser, requireLiveTv, requireRecording, async (req, res) => {
  const eventId = Number(req.body?.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: 'eventId must be a guide entry\'s id' });
  try {
    const event = await knownEvent(eventId);
    const tvh = tvheadend();
    let dvrUuid = await tvh.record(eventId, getSetting('liveTv').dvrConfig, `Reelhouse: ${req.user.username}`);
    // A Tvheadend that doesn't say which recording it made: found by its guide entry.
    if (!dvrUuid) dvrUuid = (await tvh.recordings().catch(() => [])).find((r) => r.eventId === eventId && r.state === 'scheduled')?.uuid || null;
    if (dvrUuid) run('INSERT OR REPLACE INTO recordings (dvr_uuid, user_id, created_at) VALUES (?, ?, ?)', dvrUuid, req.user.id, Date.now());
    prefetchPoster(event?.title); // the Recordings page has its cover art at once
    forgetGuide();
    log.info(`User "${req.user.username}" scheduled ${event ? `"${event.title}" on ${event.channelName}` : `guide entry ${eventId}`} to record`);
    res.json({ dvrUuid });
  } catch (err) {
    fail(res, err);
  }
});

// ---------- the Recordings page: people see and change their own recordings, admins everyone's ----------

/** Who scheduled each of `uuids` through Reelhouse: Map uuid → user id (none for the others). */
function ownersOf(uuids) {
  if (!uuids.length) return new Map();
  const rows = all(`SELECT dvr_uuid, user_id FROM recordings WHERE dvr_uuid IN (${placeholders(uuids)})`, ...uuids);
  return new Map(rows.map((r) => [r.dvr_uuid, r.user_id]));
}

/** Whether `user` may cancel, stop or delete a recording: their own, or any for an admin. */
const mayChange = (user, ownerId) => user.isAdmin || ownerId === user.id;

/** Who set each series recording through Reelhouse: Map autorec uuid → user id. */
const seriesOwners = () => new Map(all('SELECT autorec_uuid, user_id FROM recording_series').map((r) => [r.autorec_uuid, r.user_id]));

/**
 * What a series recording made is its person's: noted here as it's seen, as Tvheadend stops saying which one made a
 * recording once that series recording has gone.
 */
function adoptSeriesRecordings(list) {
  const made = list.filter((r) => r.series);
  if (!made.length) return;
  const rules = seriesOwners();
  const known = ownersOf(made.map((r) => r.uuid));
  for (const r of made) {
    const ownerId = rules.get(r.series);
    if (ownerId != null && !known.has(r.uuid)) run('INSERT OR IGNORE INTO recordings (dvr_uuid, user_id, created_at) VALUES (?, ?, ?)', r.uuid, ownerId, Date.now());
  }
}

// Scheduled and recording, soonest first; then recorded and failed, newest first.
const recordingOrder = (a, b) => {
  const upcoming = (r) => r.state === 'scheduled' || r.state === 'recording';
  if (upcoming(a) !== upcoming(b)) return upcoming(a) ? -1 : 1;
  return upcoming(a) ? a.start - b.start : b.start - a.start;
};

// Yours, or (an admin asking for all) everyone's, with who scheduled each: null for ones Reelhouse didn't schedule or
// whose person's account is gone. `recordings` lists them all; `shows` groups them by show and series, with cover art
// (server/livetv/recordings.js), as the apps' Recordings pages show them; `series` the series recordings (seriesList), the
// same person's or everyone's; `drive` is how full Tvheadend's recordings drive is, as Settings → Live TV shows it (null
// when it won't say, which doesn't stop the list). An episode that's been skipped isn't among them: the guide offers it again.
router.get('/livetv/recordings', requireUser, requireLiveTv, requireRecording, async (req, res) => {
  const everyone = req.user.isAdmin && ['1', 'true'].includes(String(req.query.all));
  try {
    const [list, chans, drive, rules] = await Promise.all([
      tvheadend().recordings(), channels().catch(() => []), tvheadend().diskSpace().catch(() => null), tvheadend().seriesRecordings().catch(() => []),
    ]);
    adoptSeriesRecordings(list);
    const owners = ownersOf(list.map((r) => r.uuid));
    const people = new Map();
    const person = (id) => {
      if (!people.has(id)) {
        const u = loadUser(id);
        people.set(id, u && { id: u.id, username: u.username, avatar: u.avatar });
      }
      return people.get(id);
    };
    const byUuid = new Map(chans.map((c) => [c.uuid, c]));
    const recordings = list
      .filter((r) => !r.skipped && (everyone || owners.get(r.uuid) === req.user.id))
      .sort(recordingOrder)
      .map(({ skipped, ...r }) => {
        const ownerId = owners.get(r.uuid) ?? null;
        const channel = byUuid.get(r.channel);
        return {
          ...r,
          channel: channel ? publicChannel(channel) : r.channelName ? { uuid: r.channel, name: r.channelName, number: null, radio: false, icon: null } : null,
          owner: ownerId != null ? person(ownerId) : null,
          mine: ownerId === req.user.id,
          canChange: mayChange(req.user, ownerId),
        };
      });
    const ruleOwners = seriesOwners();
    const series = rules.filter((rule) => everyone || ruleOwners.get(rule.uuid) === req.user.id).map((rule) => {
      const ownerId = ruleOwners.get(rule.uuid) ?? null;
      const channel = byUuid.get(rule.channel);
      return {
        ...rule,
        channel: channel ? publicChannel(channel) : null,
        owner: ownerId != null ? person(ownerId) : null,
        mine: ownerId === req.user.id,
        canChange: mayChange(req.user, ownerId),
      };
    });
    const art = await recordingArt([...recordings, ...series]).catch(() => ({}));
    const shows = groupShows(recordings, art, (r) => `/api/livetv/recordings/${r.uuid}/image`);
    for (const r of recordings) delete r.image; // Tvheadend's own address for it: the route above serves it
    res.json({ recordings, shows, series: seriesList(series, recordings, shows, art), everyone, drive });
  } catch (err) {
    fail(res, err);
  }
});

// The guide's picture for a recording (when it has one and no TMDB poster was found), through Reelhouse: Tvheadend's
// image cache needs its sign-in, and pages may only show the server's own images.
router.get('/livetv/recordings/:uuid/image', requireUser, requireLiveTv, requireRecording, async (req, res) => {
  const { uuid } = req.params;
  if (!/^[0-9a-f]{32}$/i.test(uuid)) return res.status(400).end();
  if (!mayChange(req.user, ownersOf([uuid]).get(uuid) ?? null)) return res.status(404).end();
  try {
    const tvh = tvheadend();
    const rec = (await tvh.recordings()).find((r) => r.uuid === uuid);
    const picture = rec?.image ? await tvh.icon(rec.image) : null;
    if (!picture || picture.kind === 'svg') return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type(picture.type).send(picture.body);
  } catch {
    res.status(404).end();
  }
});

// Delete several finished recordings at once (a series, or a whole show: the apps send its recorded and failed ones;
// anything scheduled or recording here is left as it is, as is anything that isn't this person's to delete).
router.post('/livetv/recordings/delete', requireUser, requireLiveTv, requireRecording, async (req, res) => {
  const uuids = req.body?.uuids;
  if (!Array.isArray(uuids) || !uuids.length || uuids.length > 1000 || !uuids.every((u) => typeof u === 'string' && /^[0-9a-f]{32}$/i.test(u))) {
    return res.status(400).json({ error: 'uuids must be a list of recordings' });
  }
  try {
    const tvh = tvheadend();
    const finished = new Set((await tvh.recordings()).filter((r) => r.state === 'recorded' || r.state === 'failed').map((r) => r.uuid));
    const owners = ownersOf(uuids);
    let deleted = 0;
    const skipped = [];
    for (const uuid of new Set(uuids)) {
      if (!finished.has(uuid) || !mayChange(req.user, owners.get(uuid) ?? null)) {
        skipped.push(uuid);
        continue;
      }
      try {
        await tvh.removeRecording(uuid);
        deleted += 1;
      } catch (err) {
        if (err.status !== 404) {
          skipped.push(uuid);
          continue;
        }
      }
      run('DELETE FROM recordings WHERE dvr_uuid = ?', uuid);
    }
    forgetGuide();
    log.info(`User "${req.user.username}" deleted ${deleted} recording${deleted === 1 ? '' : 's'}`);
    res.json({ deleted, skipped });
  } catch (err) {
    fail(res, err);
  }
});

/** A recording still to come, or a 404 as Tvheadend would answer. */
async function stillToCome(tvh, uuid) {
  const found = (await tvh.upcoming()).find((r) => r.uuid === uuid);
  if (!found) throw Object.assign(new Error('Not in Tvheadend'), { status: 404 });
  return found;
}

// `call` returns what was done, when it depends. `gone`: Tvheadend no longer has it, so neither do we.
const ACTIONS = {
  // An episode of a series recording is skipped rather than cancelled: cancelled, Tvheadend would schedule it again. One
  // that has started by the time this arrives is stopped: what's recorded stays, and stays on the page.
  cancel: {
    call: async (tvh, uuid) => {
      const entry = await stillToCome(tvh, uuid);
      if (entry.state === 'recording') {
        await tvh.stopRecording(uuid);
        return { done: 'stopped', gone: false };
      }
      if (entry.series) {
        await tvh.switchRecording(uuid, false);
        return { done: 'skipped', gone: false };
      }
      await tvh.cancelRecording(uuid);
      return {};
    },
    done: 'cancelled',
    gone: true,
  },
  stop: { call: (tvh, uuid) => tvh.stopRecording(uuid), done: 'stopped', gone: false },
  delete: { call: (tvh, uuid) => tvh.removeRecording(uuid), done: 'deleted', gone: true },
  // An episode that was skipped, wanted after all.
  record: {
    call: async (tvh, uuid) => {
      await stillToCome(tvh, uuid);
      await tvh.switchRecording(uuid, true);
    },
    done: 'put back',
    gone: false,
  },
};

// Cancel a scheduled recording (skip it, if a series recording made it), put back one that was skipped, stop one under way
// (what's recorded stays), or delete a finished one with its file.
router.post('/livetv/recordings/:uuid/:action', requireUser, requireLiveTv, requireRecording, async (req, res) => {
  const { uuid, action } = req.params;
  if (!/^[0-9a-f]{32}$/i.test(uuid)) return res.status(400).json({ error: 'Not a recording' });
  const how = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!how) return res.status(404).json({ error: 'Not found' });
  const ownerId = get('SELECT user_id FROM recordings WHERE dvr_uuid = ?', uuid)?.user_id ?? null;
  if (!mayChange(req.user, ownerId)) return res.status(403).json({ error: 'Only the person who set this recording, or an admin, can change it' });
  const forget = () => run('DELETE FROM recordings WHERE dvr_uuid = ?', uuid);
  let outcome;
  try {
    outcome = { ...how, ...(await how.call(tvheadend(), uuid)) };
  } catch (err) {
    // Already gone from Tvheadend (deleted there, or by someone else just now).
    if (err.status === 404) {
      if (how.gone) forget();
      forgetGuide();
      return res.status(404).json({ error: 'That recording isn\'t in Tvheadend any more' });
    }
    return fail(res, err);
  }
  if (outcome.gone) forget();
  forgetGuide();
  log.info(`User "${req.user.username}" ${outcome.done} a recording (${uuid})`);
  res.json({ ok: true });
});

// ---------- series recordings: Tvheadend's autorecs, one person's for each show on a channel ----------

// Every episode of a guide entry's show on its channel, from now on. A show that already has one on that channel keeps
// that one (`already` says so): Tvheadend would give a second next to nothing, as an episode that's scheduled isn't
// scheduled twice. Unless the guide's series links differ, as a new series' can: Tvheadend goes by the link alone, so the
// old one won't catch it.
router.post('/livetv/series', requireUser, requireLiveTv, requireSeries, requireRecording, async (req, res) => {
  const eventId = Number(req.body?.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) return res.status(400).json({ error: 'eventId must be a guide entry\'s id' });
  try {
    const tvh = tvheadend();
    const event = await tvh.guideEntry(eventId);
    if (!event) return res.status(404).json({ error: 'That programme isn\'t in the guide any more' });
    const name = recordingTitle(event.title);
    const owners = seriesOwners();
    const rules = await tvh.seriesRecordings();
    const sameSeries = (r) => r.channel === event.channelUuid
      && (event.serieslinkUri && r.serieslink ? r.serieslink === event.serieslinkUri : showKey(r.title) === showKey(name));
    const existing = rules.find(sameSeries);
    if (existing) {
      const ownerId = owners.get(existing.uuid);
      if (ownerId === req.user.id) return res.json({ uuid: existing.uuid, already: true });
      const who = ownerId != null ? loadUser(ownerId)?.username : null;
      return res.status(409).json({ error: `${who || 'Tvheadend'} already has a series recording of “${name}” on this channel` });
    }
    const uuid = await tvh.createSeries({
      name, channel: event.channelUuid, serieslink: event.serieslinkUri || null,
      configUuid: getSetting('liveTv').dvrConfig, comment: `Reelhouse: ${req.user.username}`,
    }) || (await tvh.seriesRecordings()).find(sameSeries)?.uuid;
    if (!uuid) return res.status(502).json({ error: 'Tvheadend didn\'t say it had set the series recording' });
    run('INSERT OR REPLACE INTO recording_series (autorec_uuid, user_id, created_at) VALUES (?, ?, ?)', uuid, req.user.id, Date.now());
    prefetchPoster(name);
    forgetGuide();
    adoptSeriesRecordings(await tvh.upcoming().catch(() => []));
    log.info(`User "${req.user.username}" set a series recording of "${name}" on ${event.channelName}`);
    res.json({ uuid });
  } catch (err) {
    fail(res, err);
  }
});

// Ends a series recording: what it had scheduled goes (Tvheadend cancels them), what's recording or recorded stays and
// stays its person's. Only for the series recordings Tvheadend lists: the call behind it can delete anything of Tvheadend's.
router.post('/livetv/series/:uuid/cancel', requireUser, requireLiveTv, requireRecording, async (req, res) => {
  const { uuid } = req.params;
  if (!/^[0-9a-f]{32}$/i.test(uuid)) return res.status(400).json({ error: 'Not a series recording' });
  const ownerId = get('SELECT user_id FROM recording_series WHERE autorec_uuid = ?', uuid)?.user_id ?? null;
  if (!mayChange(req.user, ownerId)) return res.status(403).json({ error: 'Only the person who set this series recording, or an admin, can cancel it' });
  const forget = () => run('DELETE FROM recording_series WHERE autorec_uuid = ?', uuid);
  try {
    const tvh = tvheadend();
    const rule = (await tvh.seriesRecordings()).find((r) => r.uuid === uuid);
    if (!rule) {
      forget();
      forgetGuide();
      return res.status(404).json({ error: 'That series recording isn\'t in Tvheadend any more' });
    }
    adoptSeriesRecordings(await tvh.recordings());
    await tvh.removeSeries(uuid);
    forget();
    forgetGuide();
    log.info(`User "${req.user.username}" cancelled the series recording of "${rule.title}"`);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
});

// ---------- the live playlist and its segments (the session id is the key, as for /api/hls) ----------

router.get('/live/:sid/index.m3u8', (req, res) => {
  const session = getLiveSession(req.params.sid);
  if (!session) return res.status(404).send('Session expired');
  session.touch();
  if (!session.proc && session.procError) return res.status(410).send(session.procError);
  const text = session.playlist();
  if (!text) return res.status(404).send('Not ready');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(text);
});

router.get('/live/:sid/:segment', (req, res) => {
  const session = getLiveSession(req.params.sid);
  const file = session?.segmentPath(req.params.segment);
  if (!file) return res.status(404).end();
  session.touch();
  res.setHeader('Content-Type', 'video/mp2t');
  res.sendFile(file, { cacheControl: false, dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

router.delete('/live/:sid', requireUser, (req, res) => {
  const session = getLiveSession(req.params.sid);
  if (session && (session.userId === req.user.id || req.user.isAdmin)) {
    session.destroy();
    endStream(session.id, 'stopped');
  }
  res.json({ ok: true });
});

export default router;
