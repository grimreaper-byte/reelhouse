// Live TV's state: the Tvheadend connection from Settings → Live TV, and short-lived copies of what it says (channels,
// what its account may do, guide windows), so pages don't each wait for Tvheadend.
import { getSetting, settingsEvents } from '../settings.js';
import { Tvheadend, withRadio } from './tvheadend.js';
import { cachedIcon, clearIcons, prefetchIcons } from './icons.js';

const CHANNELS_MS = 10 * 60 * 1000;
const ACCOUNT_MS = 10 * 60 * 1000;
const GUIDE_MS = 5 * 60 * 1000;
const GUIDE_WINDOWS_KEPT = 24;
const UPCOMING_MS = 60 * 1000;
const GENRES_MS = 60 * 60 * 1000;
const REFRESH_LOGOS_WAIT_MS = 20 * 1000;
const DAY = 24 * 3600;

let client = null;
let clientKey = '';
let channelsCache = null; // { at, list, promise }
let accountCache = null; // { at, value: { canRecord, dvrConfigs }, promise }
let genresCache = null; // { at, value: { code: name }, promise }
const guideCache = new Map(); // "from-to" → { at, events | promise }
let upcomingCache = null; // { at, value: recordings still to come, promise }
// Channels found to be radio when played (no picture), for Tvheadends that don't tag them; until Reelhouse restarts.
const learnedRadio = new Set();

/** Live TV is on and has an address to reach Tvheadend at. */
export function liveTvOn() {
  const s = getSetting('liveTv');
  return !!(s?.enabled && s.url);
}

/** The Tvheadend client for the current settings (a new one when they change). */
const keyOf = (s) => JSON.stringify([s.url, s.username, s.password]);

export function tvheadend() {
  const s = getSetting('liveTv');
  const key = keyOf(s);
  if (!client || key !== clientKey) {
    client = new Tvheadend(s);
    clientKey = key;
    forgetAll();
  }
  return client;
}

function forgetAll() {
  channelsCache = null;
  accountCache = null;
  genresCache = null;
  guideCache.clear();
  upcomingCache = null;
}

settingsEvents.on('change', (changed) => {
  if (changed.liveTv) {
    client = null;
    forgetAll();
  }
});

/** Copies kept for `ms`; one request at a time, and a failed one isn't kept. */
async function cached(entry, set, ms, load) {
  if (entry?.value !== undefined && Date.now() - entry.at < ms) return entry.value;
  if (entry?.promise) return entry.promise;
  const fresh = { at: 0, promise: null };
  fresh.promise = load().then((value) => {
    Object.assign(fresh, { at: Date.now(), value, promise: null });
    return value;
  }, (err) => {
    set(null);
    throw err;
  });
  set(fresh);
  return fresh.promise;
}

/**
 * The channels the account may watch: [{ uuid, name, number, icon, iconSource, radio }]. Radio stations are told
 * apart by a channel tag with "radio" in its name (Tvheadend's type-based tags: "Radio channels"), else by their
 * service type when Tvheadend lets this account see services (admins), else once one plays without a picture.
 * Loading the list also fetches the logos not kept yet (server/livetv/icons.js).
 */
export function channels() {
  return cached(channelsCache, (v) => { channelsCache = v; }, CHANNELS_MS, async () => {
    const tvh = tvheadend();
    const result = await loadChannels(tvh);
    prefetchIcons(tvh, result).catch(() => {});
    return result;
  }).then((list) => list.map((c) => (learnedRadio.has(c.uuid) && !c.radio ? { ...c, radio: true } : c)));
}

async function loadChannels(tvh) {
  const [list, tags, radioServices] = await Promise.all([
    tvh.channels(), tvh.channelTags().catch(() => []), tvh.radioServices().catch(() => null),
  ]);
  return withRadio(list, tags, radioServices);
}

/** A channel turned out to have no picture: it's radio from now on. */
export function learnRadio(uuid) {
  learnedRadio.add(uuid);
}

export async function channelByUuid(uuid) {
  return (await channels()).find((c) => c.uuid === uuid) || null;
}

/** What the account may do: { canRecord, dvrConfigs }. */
export function account() {
  return cached(accountCache, (v) => { accountCache = v; }, ACCOUNT_MS, async () => {
    const dvrConfigs = await tvheadend().dvrConfigs();
    return { canRecord: !!dvrConfigs, dvrConfigs: dvrConfigs || [] };
  });
}

/**
 * Tvheadend's genre names ({ code: name }). A failure isn't kept (e.g. Tvheadend still starting when Reelhouse asked
 * first), so the next guide asks again; the guide shows without the names meanwhile.
 */
export function genreNames() {
  return cached(genresCache, (v) => { genresCache = v; }, GENRES_MS, () => tvheadend().genreNames());
}

/** Guide entries overlapping [from, to) (epoch seconds). */
export function guideWindow(from, to) {
  const key = `${from}-${to}`;
  if (guideCache.size > GUIDE_WINDOWS_KEPT) guideCache.delete(guideCache.keys().next().value);
  return cached(guideCache.get(key), (v) => (v ? guideCache.set(key, v) : guideCache.delete(key)), GUIDE_MS,
    () => tvheadend().guide(from, to));
}

/** The recordings still to come or under way, for what the guide has no word of: which series recording made one, or that it's skipped. */
export function upcomingRecordings() {
  return cached(upcomingCache, (v) => { upcomingCache = v; }, UPCOMING_MS, () => tvheadend().upcoming());
}

/** After scheduling or cancelling a recording: the guide shows it at once. */
export function forgetGuide() {
  guideCache.clear();
  upcomingCache = null;
}

let refreshing = null;

/**
 * Settings → Live TV's "Delete cached guide data and fetch again", for when the guide, the channels or their logos
 * look wrong: once Tvheadend has answered with its channel list (so nothing is lost while it's down or refusing the
 * login), forgets everything kept from it (channels, guide, what its account may do, stations learned to be radio,
 * the logos on disk) and fetches the logos and the next day's guide again. Resolves to what came back:
 * { channels, radio, withLogo, logos, logosPending, programmes, guideChannels, guideError, removedLogos }.
 */
export function refreshLiveTv() {
  refreshing ||= (async () => {
    const s = getSetting('liveTv');
    const tvh = new Tvheadend(s); // signs in afresh
    let list;
    try {
      list = await loadChannels(tvh);
    } catch (err) {
      throw new Error(`${err.message} (nothing was deleted)`);
    }
    client = tvh;
    clientKey = keyOf(s);
    forgetAll();
    learnedRadio.clear();
    const removedLogos = await clearIcons();
    channelsCache = { at: Date.now(), value: list, promise: null };

    const logos = prefetchIcons(tvh, list).then(() => true, () => true);
    const waited = new Promise((resolve) => setTimeout(() => resolve(false), REFRESH_LOGOS_WAIT_MS).unref());
    const from = Math.floor(Date.now() / 1000);
    const [logosDone, guide] = await Promise.all([
      Promise.race([logos, waited]),
      tvh.guide(from, from + DAY).then((events) => ({ events }), (err) => ({ error: err.message })),
    ]);
    return {
      channels: list.length,
      radio: list.filter((c) => c.radio).length,
      withLogo: list.filter((c) => c.icon || c.iconSource).length,
      logos: list.filter((c) => cachedIcon(c.uuid)).length,
      logosPending: !logosDone,
      programmes: guide.events?.length ?? null,
      guideChannels: guide.events ? new Set(guide.events.map((e) => e.channelUuid)).size : null,
      guideError: guide.error || null,
      removedLogos,
    };
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Live TV for a signed-in user, as /api/me tells pages: { available, canRecord }. Recording also needs Tvheadend's
 * account to allow it; if Tvheadend is slow to say, recording is left off for now (pages ask again later).
 */
export async function liveTvFor(user, { waitMs = 1500 } = {}) {
  const available = liveTvOn() && !!user?.liveTv;
  if (!available) return { available: false, canRecord: false, radio: false };
  const wait = (promise) => Promise.race([
    promise.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), waitMs).unref()),
  ]);
  const [list, acc] = await Promise.all([wait(channels()), user.liveTvRecord ? wait(account()) : null]);
  // Radio is offered unless the channel list is known to have none.
  return { available, canRecord: !!acc?.canRecord, radio: list ? list.some((c) => c.radio) : true };
}
