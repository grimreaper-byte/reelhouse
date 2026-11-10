import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseJson, get, run } from '../db.js';
import { requireUser, requireAdmin, signPlayToken, verifyPlayToken, canAccessLibrary, clientIp } from '../auth.js';
import { getAccessibleItem, recordProgress, adjacentEpisodes, serializeMany, playableIdsUnder } from '../items.js';
import {
  decide, directContentType, qualitiesFor, QUALITIES, MAX_AUDIO_OFFSET_MS, MAX_SUBTITLE_OFFSET_MS,
} from '../transcode/profile.js';
import { copyFailedFor, copySegmentStarts, createSession, getSession, listSessions } from '../transcode/hls.js';
import { subtitleVtt } from '../transcode/subtitles.js';
import { mkvEncodedFor } from '../media/ffmpeg.js';
import { matroskaKeyframes } from '../media/matroska.js';
import { stateChanged } from '../events.js';
import {
  clientName, listStreams, logStreamLimit, reportStream, startStream, streamLimitMessage, streamLimitReached,
} from '../activity.js';
import { getSetting, settingsEvents } from '../settings.js';

const router = Router();

// ---------- now playing (admin dashboard, the top bar's count) ----------

router.get('/activity', requireAdmin, (req, res) => {
  res.json({
    sessions: listStreams(),
    transcodes: listSessions().map((s) => s.info()),
  });
});

/** What a stream is about, for the activity list and the log. */
function streamDetails(req, row) {
  const show = row.show_id ? get('SELECT title FROM items WHERE id = ?', row.show_id) : null;
  return {
    userId: req.user.id,
    username: req.user.username,
    itemId: row.id,
    title: row.title,
    grandparentTitle: show?.title || null,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
    episodeEnd: row.episode_end,
    ip: clientIp(req),
    client: clientName(req),
  };
}

router.get('/qualities', requireUser, (req, res) => res.json({ qualities: QUALITIES }));

// ---------- playback decision ----------

function playableItem(user, id) {
  const row = getAccessibleItem(user, id);
  if (!row || !row.file_path) return null;
  return row;
}

function subtitleTracks(row, media, token) {
  const tracks = [];
  for (const s of media.subtitles || []) {
    tracks.push({
      id: `s${s.index}`,
      streamIndex: s.index,
      language: s.language,
      title: s.title,
      codec: s.codec,
      forced: s.forced,
      isDefault: s.isDefault,
      external: false,
      kind: s.text ? 'text' : s.image ? 'image' : 'unsupported',
      url: s.text ? `/api/subtitles/${row.id}/s${s.index}.vtt?token=${token}` : null,
    });
  }
  parseJson(row.subs_json, []).forEach((x, i) => {
    tracks.push({
      id: `x${i}`,
      language: x.language,
      title: x.sdh ? 'SDH' : null,
      codec: x.format,
      forced: x.forced,
      isDefault: false,
      external: true,
      kind: 'text',
      url: `/api/subtitles/${row.id}/x${i}.vtt?token=${token}`,
    });
  });
  return tracks;
}

router.post('/playback/:id', requireUser, async (req, res) => {
  const row = playableItem(req.user, req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // An admin can limit how many devices someone plays on at once (Settings → Users).
  const details = streamDetails(req, row);
  const limited = streamLimitReached(req.user.id, req.user.streamLimit, details);
  if (limited) {
    logStreamLimit(details, limited);
    return res.status(429).json({ error: streamLimitMessage(limited), code: 'stream_limit', limit: limited.limit });
  }
  const media = parseJson(row.media_json, null);
  if (!media) return res.status(409).json({ error: 'Media info is missing for this file. Rescan the library.' });
  if (!fs.existsSync(row.file_path)) {
    return res.status(410).json({ error: 'The file is not available right now (is the drive connected?)' });
  }
  // MKVs scanned before Reelhouse checked their track encoding: check once now (reads the first few MB).
  if ((media.container === 'mkv' || media.container === 'webm') && media.mkvEncoded === undefined) {
    const streams = [
      media.video && [media.video.index, 'video'],
      ...(media.audio || []).map((a) => [a.index, 'audio']),
      ...(media.subtitles || []).map((s) => [s.index, 'subtitle']),
    ].filter(Boolean);
    media.mkvEncoded = await mkvEncodedFor(row.file_path, streams);
    run('UPDATE items SET media_json = ? WHERE id = ?', JSON.stringify(media), row.id);
  }
  const body = req.body || {};
  if (body.previousSession) {
    const prev = getSession(body.previousSession);
    if (prev && prev.userId === req.user.id) prev.destroy();
  }
  const decision = decide(media, body.caps || {}, {
    quality: body.quality,
    audioIndex: body.audioIndex,
    burnSubtitle: body.burnSubtitle,
    audioOffsetMs: body.audioOffsetMs,
    subtitleOffsetMs: body.subtitleOffsetMs,
    forceTranscode: !!body.forceTranscode,
    direct: body.direct === true,
  });
  if (decision.mode === 'hls' && !media.video) {
    return res.status(415).json({ error: 'This file has no video stream' });
  }
  // Copying the picture cuts the segments at the file's own keyframes, from its index (see transcode/hls.js); without
  // one, with keyframes too far apart, or once copying this file has failed, the picture is converted (or, when it
  // was only to be copied for even frame times, the file is played as it is).
  if (decision.videoCopy) {
    const keyframes = copyFailedFor(row.id) ? null : await matroskaKeyframes(row.file_path).catch(() => null);
    const starts = keyframes?.length ? copySegmentStarts(keyframes, media.duration || row.duration, media.bitrate) : null;
    if (starts) decision.segmentStarts = starts;
    else if (decision.directIfNoCopy) Object.assign(decision, { mode: 'direct', reasons: [], videoCopy: false });
    else decision.videoCopy = false;
  }
  const token = signPlayToken(req.user.id, row.id);
  let url;
  let playId;
  if (decision.mode === 'direct') {
    url = `/api/stream/${row.id}?token=${token}`;
    playId = crypto.randomBytes(12).toString('hex');
  } else {
    const session = createSession({ item: row, media, decision, userId: req.user.id });
    url = `/api/hls/${session.id}/index.m3u8`;
    playId = session.id;
  }
  // Logged as started (or as switched, for a new decision on something already playing), see server/activity.js.
  startStream(playId, {
    ...streamDetails(req, row),
    duration: media.duration || row.duration,
    mode: decision.mode,
    quality: decision.quality.id,
    qualityLabel: decision.quality.label,
    reasons: decision.reasons,
    videoCopy: decision.videoCopy,
  });

  let next = null;
  let prev = null;
  if (row.type === 'episode') {
    const adj = adjacentEpisodes(row);
    if (adj.next) next = serializeMany(req.user.id, [adj.next])[0];
    if (adj.prev) prev = serializeMany(req.user.id, [adj.prev])[0];
  }

  res.json({
    playId,
    mode: decision.mode,
    url,
    sessionId: decision.mode === 'hls' ? playId : null,
    reasons: decision.reasons,
    // Converting only the sound (or the file around the picture): the picture is copied as it is.
    videoCopy: decision.mode === 'hls' && decision.videoCopy,
    // Where the stream's time 0 is in the film (seconds): a copied picture starts with the film's first keyframe,
    // a little after 0 in some films (see copySegmentStarts).
    timelineStart: decision.mode === 'hls' && decision.videoCopy ? decision.segmentStarts[0] : 0,
    quality: decision.quality.id,
    // The qualities to offer for this file: the original and the presets below it.
    qualities: qualitiesFor(media).map((q) => q.id),
    duration: media.duration || row.duration,
    audioIndex: decision.audio?.index ?? null,
    burnSubtitle: decision.burnSubtitle,
    // Offsets the server applied (audio, and burned-in subtitles); text subtitles shift in the player.
    audioOffsetMs: decision.audioOffsetMs,
    subtitleOffsetMs: decision.subtitleOffsetMs,
    offsetLimits: { audioMs: MAX_AUDIO_OFFSET_MS, subtitleMs: MAX_SUBTITLE_OFFSET_MS },
    audioTracks: (media.audio || []).map((a) => ({
      index: a.index,
      codec: a.codec,
      channels: a.channels,
      language: a.language,
      title: a.title,
      isDefault: a.isDefault,
    })),
    subtitleTracks: subtitleTracks(row, media, token),
    chapters: media.chapters || [],
    video: media.video ? { codec: media.video.codec, width: media.video.width, height: media.video.height, hdr: media.video.hdr } : null,
    next,
    prev,
  });
});

// ---------- direct streaming ----------

// Downloads being sent right now: turning downloads off stops these too, not only new ones.
const openDownloads = new Set();
settingsEvents.on('change', (changed) => {
  if (!('allowDownloads' in changed) || changed.allowDownloads) return;
  for (const res of openDownloads) res.destroy();
  openDownloads.clear();
});

function streamUser(req, itemId) {
  if (req.user) return req.user;
  return verifyPlayToken(req.query.token, itemId);
}

router.get('/stream/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = streamUser(req, id);
  if (!user) return res.status(401).end();
  const row = get('SELECT * FROM items WHERE id = ?', id);
  if (!row?.file_path || !canAccessLibrary(user, row.library_id)) return res.status(404).end();
  if (req.query.download) {
    if (!getSetting('allowDownloads')) return res.status(403).end();
    res.attachment(path.basename(row.file_path));
    openDownloads.add(res);
    res.on('close', () => openDownloads.delete(res));
  } else {
    res.setHeader('Content-Type', directContentType(row.container, row.file_path));
  }
  res.sendFile(row.file_path, { acceptRanges: true, cacheControl: false, dotfiles: 'allow', lastModified: true }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).end();
  });
});

// ---------- HLS ----------

router.get('/hls/:sid/index.m3u8', (req, res) => {
  const session = getSession(req.params.sid);
  if (!session) return res.status(404).send('Session expired');
  session.touch();
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(session.playlist());
});

router.get('/hls/:sid/:segment', async (req, res) => {
  const session = getSession(req.params.sid);
  const m = /^(\d+)\.ts$/.exec(req.params.segment);
  if (!session || !m) return res.status(404).end();
  try {
    const file = await session.getSegment(Number(m[1]));
    res.setHeader('Content-Type', 'video/mp2t');
    res.sendFile(file, { cacheControl: false, dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).send(err.message);
  }
});

router.delete('/hls/:sid', requireUser, (req, res) => {
  const session = getSession(req.params.sid);
  if (session && (session.userId === req.user.id || req.user.isAdmin)) session.destroy();
  res.json({ ok: true });
});

// ---------- subtitles ----------

router.get('/subtitles/:id/:file', async (req, res) => {
  const id = Number(req.params.id);
  const user = streamUser(req, id);
  if (!user) return res.status(401).end();
  const row = get('SELECT * FROM items WHERE id = ?', id);
  if (!row || !canAccessLibrary(user, row.library_id)) return res.status(404).end();
  const key = req.params.file.replace(/\.vtt$/, '');
  try {
    const file = await subtitleVtt(row, key);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, { cacheControl: false, dotfiles: 'allow' });
  } catch (err) {
    res.status(err.status || 500).send(err.message);
  }
});

// ---------- progress ----------

router.post('/progress', requireUser, (req, res) => {
  const { itemId, position, duration, state, playId, mode, quality, age } = req.body || {};
  const row = playableItem(req.user, itemId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const pos = Math.max(0, Number(position) || 0);
  // A report sent late (made offline, e.g. watching a download) says how old it is, in milliseconds: an age rather
  // than a time, so the phone's clock doesn't matter.
  const madeAt = Number.isFinite(age) && age >= 0 ? Date.now() - age : null;
  const result = recordProgress(req.user.id, row, pos, Number(duration) || row.duration, state === 'ended', madeAt);
  // Other devices (e.g. Kodi) pick up resume points and watched marks; not on every playing heartbeat.
  if (state !== 'playing') stateChanged(req.user.id, playableIdsUnder(row));
  if (playId) getSession(playId)?.touch();
  // Live reports only: a late one (made offline) is about something that has already happened.
  if (playId && madeAt == null) {
    const session = getSession(playId);
    reportStream(playId, {
      ...streamDetails(req, row),
      position: pos,
      duration: Number(duration) || row.duration,
      state,
      mode,
      quality,
      reasons: session?.decision.reasons || [],
      qualityLabel: session?.decision.quality.label,
      videoCopy: !!session?.copy,
    });
  }
  res.json(result);
});

export default router;
