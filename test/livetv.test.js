// Live TV from Tvheadend: settings, the connection test, who may watch and record, the guide, recording, and live
// playback, against a fake Tvheadend that answers like the real one (Digest sign-in, a wrong password getting 403,
// ticket links, a broadcast-like interlaced MPEG-2 + MP2 stream). Needs ffmpeg and ffprobe on the PATH.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-livetv-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { liveLimits, startLiveManager, stopAllLiveSessions, listLiveSessions, liveQualities } = await import('../server/transcode/live.js');
const { listStreams, clearStreams } = await import('../server/activity.js');
const { recentLogs } = await import('../server/lib/log.js');
const { canDrawSvg } = await import('../server/livetv/icons.js');
const { seriesTitlePattern } = await import('../server/livetv/tvheadend.js');
const { forgetGuide } = await import('../server/livetv/guide.js');

const H = { 'x-requested-with': 'reelhouse', 'content-type': 'application/json' };
const ONE = 'a'.repeat(32);
const TWO = 'b'.repeat(32);
const PROFILE = 'c'.repeat(32);
const RADIO = 'e'.repeat(32); // tagged "Radio channels"
const UNTAGGED = 'f'.repeat(32); // radio Tvheadend doesn't say is radio: no picture
const RADIO_TAG = '1'.repeat(32);
// A real PNG (1×1), as Tvheadend's image cache serves it: with no Content-Type.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
  + '1f15c4890000000d49444154789c6360000000000200012be4c7e40000000049454e44ae426082', 'hex');
const NONCE = 'n0nce';

// ---------- the fake Tvheadend ----------

const tvh = {
  users: { reelhouse: { password: 'right horse', recorder: true }, viewer: { password: 'viewer pass', recorder: false } },
  calls: [], // [path, form]
  lastFilter: null,
  openStreams: 0,
  iconFetches: 0,
  iconsDown: false,
  channelsDown: false,
  genresDown: false,
  radioIcon: null,
  dvr: new Map(), // eventId → { uuid, state: scheduled | recording | recorded | failed, event (its guide entry), autorec, enabled }
  autorecs: new Map(), // uuid → its settings, as dvr/autorec/create was given them
  recordChoices: [15, 0, 14, 1],
};
let tvhServer;
let tvhUrl;
let tsFile;
let radioFile;

function events(now) {
  const start = Math.floor(now / 1800) * 1800 - 1800;
  const list = [];
  for (const [i, channel] of [[0, ONE], [1, TWO]]) {
    for (let k = 0; k < 8; k++) {
      const id = 1000 + i * 100 + k;
      const dvr = tvh.dvr.get(id);
      list.push({
        eventId: id, channelUuid: channel, channelName: i ? 'Two' : 'One', start: start + k * 1800, stop: start + (k + 1) * 1800,
        title: `Show ${k}`, subtitle: `Part ${k}`, description: 'A test programme', seasonNumber: 1, episodeNumber: k + 1,
        // A show with a series link, its new episodes called "New: …" as UK guides do.
        ...(tvh.seriesEvents?.channel === channel && k % 2 ? { title: `${k % 4 === 1 ? 'New: ' : ''}${tvh.seriesEvents.title}`, serieslinkUri: tvh.seriesEvents.link || 'crid://test/soap' } : {}),
        episodeOnscreen: `S01E0${k + 1}`, ...(dvr ? { dvrUuid: dvr.uuid, dvrState: dvr.problem ? 'recordingError' : { recorded: 'completed', failed: 'completedError' }[dvr.state] || dvr.state } : {}),
        // Comedy (0x14), a user-defined type Tvheadend has no name for (0xC1), or none.
        ...[{ genre: [20] }, { genre: [0xc1] }, {}][k % 3],
      });
    }
  }
  return list;
}

function signedInAs(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Digest ')) return { status: 'none' };
  const p = {};
  for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) p[m[1]] = m[2] ?? m[3];
  const user = tvh.users[p.username];
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  if (!user || p.nonce !== NONCE || p.uri !== req.url) return { status: 'wrong' };
  const expected = md5(`${md5(`${p.username}:tvheadend:${user.password}`)}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${md5(`${req.method}:${p.uri}`)}`);
  return expected === p.response ? { status: 'ok', name: p.username, ...user } : { status: 'wrong' };
}

function streamTs(req, res, file = tsFile) {
  tvh.openStreams++;
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  const data = fs.readFileSync(file);
  let at = 0;
  // Faster than real time (a few times over), looping like a channel that never ends.
  const timer = setInterval(() => {
    const chunk = data.subarray(at, at + 188 * 700);
    at = at + chunk.length >= data.length ? 0 : at + chunk.length;
    res.write(chunk);
  }, 40);
  // The response's close is the connection going (a request's close only means its body was read).
  res.on('close', () => {
    clearInterval(timer);
    tvh.openStreams--;
  });
}

// A logo somewhere else on the web (a radio station's): an SVG.
let iconServer;
function fakeIconSite(req, res) {
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
}

function fakeTvheadend(req, res) {
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const form = Object.fromEntries(new URLSearchParams(body));
    if (url.pathname.startsWith('/stream/channelid/')) {
      if (url.searchParams.get('ticket') !== 'T1') return res.writeHead(401).end();
      if (url.pathname.endsWith('/2')) return res.writeHead(503).end('No free adapter');
      if (url.pathname.endsWith('/3') || url.pathname.endsWith('/4')) return streamTs(req, res, radioFile);
      return streamTs(req, res);
    }
    const who = signedInAs(req);
    if (who.status === 'none') {
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="tvheadend", qop="auth", nonce="${NONCE}", opaque="op", algorithm=MD5` });
      return res.end();
    }
    if (who.status === 'wrong') return res.writeHead(403).end('Forbidden'); // as Tvheadend does
    const json = (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    tvh.calls.push([url.pathname, form]);
    switch (url.pathname) {
      case '/api/serverinfo':
        return json({ name: 'Tvheadend', sw_version: '4.3-2347~g1dc8ffe78', api_version: 19, capabilities: [] });
      case '/api/channel/grid':
        if (tvh.channelsDown) return res.writeHead(500).end();
        return json({ entries: [
          { uuid: TWO, enabled: true, name: 'Two', number: 2, tags: ['2'.repeat(32)] },
          { uuid: ONE, enabled: true, name: 'One', number: 1, icon: 'file:///picons/one.png', icon_public_url: 'imagecache/1', tags: ['2'.repeat(32)] },
          { uuid: 'd'.repeat(32), enabled: false, name: 'Off', number: 3 },
          { uuid: RADIO, enabled: true, name: 'Radio One', number: 701, icon: tvh.radioIcon, icon_public_url: tvh.radioIcon, tags: [RADIO_TAG] },
          { uuid: UNTAGGED, enabled: true, name: 'Quiet FM', number: 702, tags: [] },
        ] });
      case '/api/epg/content_type/list':
        if (tvh.genresDown) return res.writeHead(500).end();
        return json({ entries: form.full === '1'
          ? [{ key: 0, val: '' }, { key: 16, val: 'Movie / Drama' }, { key: 20, val: 'Comedy' }]
          : [{ key: 0, val: '' }, { key: 16, val: 'Movie / Drama' }] });
      case '/api/channeltag/grid':
        return json({ entries: [{ uuid: '2'.repeat(32), name: 'TV channels' }, { uuid: RADIO_TAG, name: 'Radio channels' }] });
      case '/api/epg/events/grid': {
        tvh.lastFilter = JSON.parse(form.filter || 'null');
        const to = Number(tvh.lastFilter?.find((f) => f.field === 'start')?.value) || Infinity;
        const from = Number(tvh.lastFilter?.find((f) => f.field === 'stop')?.value) || 0;
        return json({ entries: events(Date.now() / 1000).filter((e) => e.start <= to && e.stop >= from) });
      }
      case '/comet/poll': // what Tvheadend's web interface is sent first: the recordings drive for accounts that may record
        if (tvh.noDriveReport) return json({ boxid: 'box1', messages: [] });
        return json({ boxid: 'box1', messages: [
          { notificationClass: 'accessUpdate', dvr: who.recorder ? 1 : 0, admin: 0,
            ...(who.recorder ? { freediskspace: 400e9, useddiskspace: 12e9, totaldiskspace: 1000e9 } : {}) },
          { notificationClass: 'setServerIpPort', ip: '127.0.0.1', port: 9981 },
        ] });
      case '/api/dvr/config/grid':
        return who.recorder ? json({ entries: [{ uuid: PROFILE, name: '' }] }) : res.writeHead(403).end();
      case '/api/dvr/entry/create_by_event': {
        // As Tvheadend: config_uuid must be there (empty means its default profile).
        if (form.config_uuid == null || !form.event_id) return res.writeHead(400).end();
        const uuid = crypto.randomBytes(16).toString('hex');
        const event = events(Date.now() / 1000).find((e) => e.eventId === Number(form.event_id));
        tvh.dvr.set(Number(form.event_id), { uuid, state: 'scheduled', event });
        return json({ uuid: tvh.uuidAsText ? uuid : [uuid] });
      }
      case '/api/epg/events/load':
        return json({ entries: events(Date.now() / 1000).filter((e) => e.eventId === Number(form.eventId)) });
      case '/api/idnode/class':
        return json({ props: [{ id: 'record', enum: tvh.recordChoices.map((key) => ({ key, val: `Choice ${key}` })) }] });
      case '/api/dvr/autorec/grid':
        if (!who.recorder || tvh.autorecsDown) return res.writeHead(who.recorder ? 500 : 403).end();
        return json({ entries: [...tvh.autorecs].map(([uuid, c]) => ({ uuid, ...c })) });
      case '/api/dvr/autorec/create': {
        // As Tvheadend: schedules what the guide has that it matches, unless that's scheduled already.
        const conf = JSON.parse(form.conf);
        const uuid = crypto.randomBytes(16).toString('hex');
        tvh.autorecs.set(uuid, conf);
        const pattern = new RegExp(conf.title, 'i');
        for (const event of events(Date.now() / 1000)) {
          if (event.channelUuid !== conf.channel || event.start < Date.now() / 1000 || tvh.dvr.has(event.eventId)) continue;
          if (conf.serieslink ? event.serieslinkUri !== conf.serieslink : !pattern.test(event.title)) continue;
          tvh.dvr.set(event.eventId, { uuid: crypto.randomBytes(16).toString('hex'), state: 'scheduled', event, autorec: uuid });
        }
        return json({ uuid });
      }
      case '/api/idnode/delete': {
        // Any of Tvheadend's objects, so Reelhouse must only ever send it series recordings. Scheduled ones go with it;
        // what's recording or recorded stays and no longer says what made it.
        tvh.deletedNodes = [...(tvh.deletedNodes || []), form.uuid];
        if (!tvh.autorecs.delete(form.uuid)) return res.writeHead(404).end();
        for (const [id, d] of tvh.dvr) {
          if (d.autorec !== form.uuid) continue;
          if (d.state === 'scheduled') tvh.dvr.delete(id);
          else delete d.autorec;
        }
        return json({});
      }
      case '/api/idnode/save': {
        const node = JSON.parse(form.node);
        const found = [...tvh.dvr.values()].find((d) => d.uuid === node.uuid);
        if (!found) return res.writeHead(404).end();
        found.enabled = node.enabled;
        return json({});
      }
      case '/api/dvr/entry/grid_upcoming':
      case '/api/dvr/entry/grid_finished':
      case '/api/dvr/entry/grid_failed': {
        if (!who.recorder) return res.writeHead(403).end();
        const states = { grid_upcoming: ['scheduled', 'recording'], grid_finished: ['recorded'], grid_failed: ['failed'] }[url.pathname.split('/').pop()];
        return json({ entries: [...tvh.dvr].filter(([, d]) => states.includes(d.state)).map(([id, d]) => ({
          uuid: d.uuid, disp_title: d.event.title, disp_subtitle: d.event.subtitle, disp_description: d.event.description,
          channel: d.event.channelUuid, channelname: d.event.channelName, start: d.event.start, stop: d.event.stop, broadcast: id,
          episode_disp: d.event.seasonNumber != null ? `Season ${d.event.seasonNumber}.Episode ${d.event.episodeNumber}` : '',
          image: d.image || '',
          sched_status: d.problem ? 'recordingError' : d.state === 'recorded' ? 'completed' : d.state === 'failed' ? 'completedError' : d.state,
          status: d.problem ? 'Waiting for stream' : { scheduled: 'Scheduled for recording', recording: 'Running', recorded: 'Completed OK', failed: 'Time missed' }[d.state],
          filesize: d.state === 'scheduled' ? 0 : 1234567,
          autorec: d.autorec || '',
          enabled: d.enabled !== false,
        })) });
      }
      case '/api/dvr/entry/cancel':
      case '/api/dvr/entry/stop':
      case '/api/dvr/entry/remove': {
        // As Tvheadend: a recording it doesn't have is 404. Stopping keeps what's recorded.
        const found = [...tvh.dvr].find(([, d]) => d.uuid === form.uuid);
        if (!found) return res.writeHead(404).end();
        if (url.pathname.endsWith('/stop')) found[1].state = 'recorded';
        else tvh.dvr.delete(found[0]);
        return json({});
      }
      case '/imagecache/1':
        tvh.iconFetches++;
        return tvh.iconsDown ? res.writeHead(500).end() : res.writeHead(200).end(PNG);
      default: {
        const m = /^\/playlist\/ticket\/channel\/(\w+)$/.exec(url.pathname);
        if (m) {
          const n = { [TWO]: 2, [RADIO]: 3, [UNTAGGED]: 4 }[m[1]] || 1;
          // Written with another address (as Tvheadend does with the one it was asked on): Reelhouse points it back.
          return res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' })
            .end(`#EXTM3U\n#EXTINF:-1,Channel\nhttp://10.9.9.9:9981/stream/channelid/${n}?ticket=T1&profile=pass\n`);
        }
        return res.writeHead(404).end();
      }
    }
  });
}

// ---------- Reelhouse ----------

let server;
let base;
const tokens = {};
const ids = {};

const signIn = async (username, password) => (await (await fetch(`${base}/api/auth/device`, {
  method: 'POST', headers: H, body: JSON.stringify({ username, password, device: `test ${username}` }),
})).json()).token;

const call = async (who, method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers: { ...H, authorization: `Bearer ${tokens[who]}` }, body: body && JSON.stringify(body) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

const waitFor = async (check, ms = 10000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

before(async () => {
  tsFile = path.join(dataDir, 'broadcast.ts');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=720x576:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'mpeg2video', '-b:v', '3000k', '-flags', '+ilme+ildct', '-top', '1', '-g', '12', '-c:a', 'mp2', '-b:a', '192k', '-f', 'mpegts', tsFile]);
  radioFile = path.join(dataDir, 'radio.ts');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=500:duration=6', '-c:a', 'mp2', '-b:a', '192k',
    '-mpegts_service_type', 'digital_radio', '-f', 'mpegts', radioFile]);
  iconServer = http.createServer(fakeIconSite).listen(0, '127.0.0.1');
  await new Promise((r) => iconServer.once('listening', r));
  tvh.radioIcon = `http://127.0.0.1:${iconServer.address().port}/radio-one.svg`;
  tvhServer = http.createServer(fakeTvheadend).listen(0, '127.0.0.1');
  await new Promise((r) => tvhServer.once('listening', r));
  tvhUrl = `127.0.0.1:${tvhServer.address().port}`;

  openDb(':memory:');
  const t = Date.now();
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'admin', ?, 1, ?)", await hashPassword('admin pass'), t);
  // Added the way migration v10 finds existing accounts: the columns' defaults (watch on, record off).
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (2, 'kid', ?, 0, ?)", await hashPassword('kid pass'), t);
  run("INSERT INTO users (id, username, password_hash, is_admin, live_tv, created_at) VALUES (3, 'nolive', ?, 0, 0, ?)", await hashPassword('nolive pass'), t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await signIn('admin', 'admin pass');
  tokens.kid = await signIn('kid', 'kid pass');
  tokens.nolive = await signIn('nolive', 'nolive pass');
  Object.assign(ids, { kid: 2, nolive: 3 });
  startLiveManager();
});

after(() => {
  stopAllLiveSessions();
  server.close();
  tvhServer.closeAllConnections();
  tvhServer.close();
  iconServer.close();
  closeDb();
  setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true }), 1000);
});

test('the settings: the address is tidied, the password masked and kept, nonsense refused', async () => {
  let r = await call('admin', 'PUT', '/api/settings', { liveTv: { enabled: true, url: `${tvhUrl}/`, username: 'reelhouse', password: 'right horse' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.settings.liveTv.url, `http://${tvhUrl}`);
  assert.equal(r.data.settings.liveTv.password, '••••••••');
  // Saving the form again with the mask keeps the password.
  r = await call('admin', 'PUT', '/api/settings', { liveTv: { password: '••••••••', dvrConfig: PROFILE } });
  assert.equal(r.status, 200);
  assert.equal((await call('admin', 'POST', '/api/admin/livetv/test', {})).data.canStream, true);
  for (const bad of [{ url: 'http://me:pw@tvh:9981' }, { url: 'ftp://tvh' }, { dvrConfig: 'nope' }, { enabled: true, url: '' }]) {
    assert.equal((await call('admin', 'PUT', '/api/settings', { liveTv: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('kid', 'PUT', '/api/settings', { liveTv: { enabled: false } })).status, 403);
});

test('Test connection: what Tvheadend allows this account, and readable failures', async () => {
  let r = await call('admin', 'POST', '/api/admin/livetv/test', { url: tvhUrl, username: 'reelhouse', password: '••••••••' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual({ ...r.data, dvrConfigs: r.data.dvrConfigs.length }, {
    name: 'Tvheadend', version: '4.3-2347~g1dc8ffe78', apiVersion: 19, channels: 4, radio: 1, canStream: true, streamProblem: null, canRecord: true, dvrConfigs: 1,
    diskSpace: { free: 400e9, total: 1000e9, recordings: 12e9 },
  });
  r = await call('admin', 'POST', '/api/admin/livetv/test', { url: tvhUrl, username: 'viewer', password: 'viewer pass' });
  assert.equal(r.data.canRecord, false);
  assert.equal(r.data.diskSpace, null, 'only accounts that may record are told about the drive');
  r = await call('admin', 'POST', '/api/admin/livetv/test', { url: tvhUrl, username: 'reelhouse', password: 'wrong' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /refused this login: check the username and password/);
  r = await call('admin', 'POST', '/api/admin/livetv/test', { url: '127.0.0.1:1', username: 'x', password: 'y' });
  assert.match(r.data.error, /Couldn't reach Tvheadend at http:\/\/127\.0\.0\.1:1/);
});

test('who may watch and record: admins always, others as their switches say', async () => {
  const me = async (who) => (await call(who, 'GET', '/api/me')).data.liveTv;
  assert.deepEqual(await me('admin'), { available: true, canRecord: true, radio: true });
  assert.deepEqual(await me('kid'), { available: true, canRecord: false, radio: true });
  assert.deepEqual(await me('nolive'), { available: false, canRecord: false, radio: false });
  assert.equal((await call('nolive', 'GET', '/api/livetv/channels')).status, 403);
  // An admin lets the kid record; recording without watching isn't a thing.
  let r = await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: true });
  assert.equal(r.data.user.liveTvRecord, true);
  assert.deepEqual(await me('kid'), { available: true, canRecord: true, radio: true });
  r = await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTv: false });
  assert.deepEqual([r.data.user.liveTv, r.data.user.liveTvRecord], [false, false]);
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTv: true });
  assert.deepEqual(await me('kid'), { available: true, canRecord: false, radio: true });
  // New accounts: watching on, recording off unless asked for.
  r = await call('admin', 'POST', '/api/users', { username: 'newbie', password: 'newbie pass 1' });
  assert.deepEqual([r.data.user.liveTv, r.data.user.liveTvRecord], [true, false]);
});

test('the guide: channels by number with icons, the time window asked of Tvheadend', async () => {
  const now = Math.floor(Date.now() / 1000);
  const r = await call('kid', 'GET', `/api/livetv/guide?from=${now - 600}&to=${now + 3600}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.channels.map((c) => [c.number, c.name, !!c.icon, c.radio]),
    [[1, 'One', true, false], [2, 'Two', false, false], [701, 'Radio One', true, true], [702, 'Quiet FM', false, false]]);
  assert.equal(r.data.from % 1800, 0);
  assert.ok(r.data.events.length >= 4 && r.data.events.every((e) => e.start < r.data.to && e.stop > r.data.from));
  assert.deepEqual(tvh.lastFilter.map((f) => [f.field, f.comparison]), [['start', 'lt'], ['stop', 'gt']]);
  const e = r.data.events[0];
  assert.deepEqual(Object.keys(e).sort(), ['channel', 'description', 'dvr', 'episode', 'episodeLabel', 'genre', 'genreName', 'id', 'season', 'start', 'stop', 'subtitle', 'summary', 'title']);
  // Genres: as Tvheadend names them; one it has no name for, nothing.
  const named = (code) => r.data.events.find((ev) => ev.genre[0] === code)?.genreName;
  assert.equal(named(20), 'Comedy');
  assert.equal(named(0xc1), null);
  assert.ok(r.data.events.some((ev) => !ev.genre.length && ev.genreName === null));
  assert.equal(r.data.canRecord, false);
  const icon = await call('kid', 'GET', r.data.channels[0].icon);
  assert.equal(icon.status, 200);
  assert.ok(icon.data.equals(PNG));
});

test('channel logos: judged by their bytes, kept on disk, still there when Tvheadend is down', async () => {
  const one = `/api/livetv/channels/${ONE}/icon`;
  const fetches = tvh.iconFetches;
  // Tvheadend's image cache sends no Content-Type: the PNG is known by its first bytes.
  let res = await fetch(`${base}${one}`, { headers: { authorization: `Bearer ${tokens.kid}` } });
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  // Asked again (the guide, the player): from the copy, not Tvheadend.
  await call('kid', 'GET', one);
  await call('admin', 'GET', one);
  assert.ok(tvh.iconFetches - fetches <= 1, `fetched ${tvh.iconFetches - fetches} times`);
  const kept = fs.readdirSync(path.join(dataDir, 'cache', 'channel-icons')).sort();
  assert.ok(kept.includes(`${ONE}.png`) && kept.includes(`${ONE}.json`), kept.join(', '));
  // The guide now gives the logo's address with its version, so browsers keep it.
  const now = Math.floor(Date.now() / 1000);
  const guide = (await call('kid', 'GET', `/api/livetv/guide?from=${now}&to=${now + 3600}`)).data;
  assert.match(guide.channels.find((c) => c.uuid === ONE).icon, new RegExp(`/api/livetv/channels/${ONE}/icon\\?v=\\d+`));
  // Tvheadend has trouble: the kept logo is still served.
  tvh.iconsDown = true;
  try {
    assert.equal((await call('kid', 'GET', one)).status, 200);
  } finally {
    tvh.iconsDown = false;
  }
  // A logo elsewhere on the web (an SVG), fetched without Tvheadend's credentials: drawn as a PNG where ffmpeg can
  // (the Docker image's), for the Android app and Kodi; else kept as SVG for browsers, where it can't run anything.
  res = await fetch(`${base}/api/livetv/channels/${RADIO}/icon`, { headers: { authorization: `Bearer ${tokens.kid}` } });
  assert.equal(res.status, 200);
  if (await canDrawSvg()) {
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.ok(Buffer.from(await res.arrayBuffer()).subarray(1, 4).equals(Buffer.from('PNG')));
    assert.ok(!fs.existsSync(path.join(dataDir, 'cache', 'channel-icons', `${RADIO}.svg`)), "the SVG isn't kept beside it");
    // One kept as SVG before logos were drawn (or by a server whose ffmpeg couldn't) is drawn when next asked for.
    const dir = path.join(dataDir, 'cache', 'channel-icons');
    const note = JSON.parse(fs.readFileSync(path.join(dir, `${RADIO}.json`), 'utf8'));
    fs.rmSync(path.join(dir, `${RADIO}.png`));
    fs.writeFileSync(path.join(dir, `${RADIO}.svg`), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"/>');
    fs.writeFileSync(path.join(dir, `${RADIO}.json`), JSON.stringify({ ...note, kind: 'svg' }));
    res = await fetch(`${base}/api/livetv/channels/${RADIO}/icon`, { headers: { authorization: `Bearer ${tokens.kid}` } });
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.ok(fs.existsSync(path.join(dir, `${RADIO}.png`)) && !fs.existsSync(path.join(dir, `${RADIO}.svg`)));
  } else {
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
  }
  // No logo at all: none, and the guide doesn't offer one.
  assert.equal((await call('kid', 'GET', `/api/livetv/channels/${TWO}/icon`)).status, 404);
});

test('radio: tagged stations play as sound only; a station without a picture is found out and listed as radio', async () => {
  let r = await call('kid', 'POST', `/api/livetv/play/${RADIO}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.radio, true);
  const segmentStreams = async (data) => {
    const playlist = await (await fetch(`${base}${data.url}`)).text();
    const name = /\n(\d+\.ts)/.exec(playlist)[1];
    const file = path.join(dataDir, `radio-${data.playId}.ts`);
    fs.writeFileSync(file, Buffer.from(await (await fetch(`${base}${data.url.replace('index.m3u8', name)}`)).arrayBuffer()));
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels', '-of', 'csv=p=0', file]).toString();
    return [...new Set(probe.split(/\r?\n/).filter(Boolean))];
  };
  assert.deepEqual(await segmentStreams(r.data), ['aac,audio,2']);
  assert.deepEqual(r.data.qualities, ['original'], 'radio has nothing to choose');
  assert.match(recentLogs(5).map((l) => l.msg).join('\n'), /User "kid" started "Radio One" on .* \(live radio\)/);
  await call('kid', 'POST', '/api/livetv/progress', { playId: r.data.playId, state: 'stopped' });

  // Quiet FM isn't tagged: it starts as television, has no picture, and plays as radio instead.
  r = await call('kid', 'POST', `/api/livetv/play/${UNTAGGED}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.radio, true);
  assert.deepEqual(await segmentStreams(r.data), ['aac,audio,2']);
  await call('kid', 'POST', '/api/livetv/progress', { playId: r.data.playId, state: 'stopped' });
  const now = Math.floor(Date.now() / 1000);
  const guide = (await call('kid', 'GET', `/api/livetv/guide?from=${now}&to=${now + 3600}`)).data;
  assert.equal(guide.channels.find((c) => c.uuid === UNTAGGED).radio, true);
  assert.ok(await waitFor(() => tvh.openStreams === 0), 'streams closed');
});

test('recording: allowed accounts schedule and cancel from the guide', async () => {
  const now = Math.floor(Date.now() / 1000);
  const guide = (await call('admin', 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data;
  const later = guide.events.find((e) => e.start > now);
  assert.equal((await call('kid', 'POST', '/api/livetv/record', { eventId: later.id })).status, 403);
  let r = await call('admin', 'POST', '/api/livetv/record', { eventId: later.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(tvh.calls.at(-1), ['/api/dvr/entry/create_by_event', { event_id: String(later.id), config_uuid: PROFILE, comment: 'Reelhouse: admin' }]);
  // The guide shows it straight away.
  const after = (await call('admin', 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data;
  const shown = after.events.find((e) => e.id === later.id);
  assert.deepEqual(shown.dvr, { uuid: r.data.dvrUuid, state: 'scheduled', canChange: true, series: null });
  assert.match(recentLogs(5).map((l) => l.msg).join('\n'), new RegExp(`User "admin" scheduled "${later.title}" on One to record`));
  r = await call('admin', 'POST', `/api/livetv/recordings/${shown.dvr.uuid}/cancel`);
  assert.equal(r.status, 200);
  assert.deepEqual(tvh.calls.at(-1), ['/api/dvr/entry/cancel', { uuid: shown.dvr.uuid }]);
  assert.equal((await call('admin', 'POST', '/api/livetv/recordings/not-a-uuid/cancel')).status, 400);
});

test('a recording under way with a problem is still recording, and says what\'s wrong', async () => {
  tvh.dvr.clear();
  const now = Math.floor(Date.now() / 1000);
  const guide = async () => {
    forgetGuide();
    return (await call('admin', 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data;
  };
  const later = (await guide()).events.find((e) => e.start > now && e.channel === ONE);
  const { dvrUuid } = (await call('admin', 'POST', '/api/livetv/record', { eventId: later.id })).data;
  const entry = [...tvh.dvr.values()].find((d) => d.uuid === dvrUuid);
  // As Tvheadend says of one waiting for a tuner or a stream: "recordingError", in its list and its guide.
  Object.assign(entry, { state: 'recording', problem: true });
  const list = async () => (await call('admin', 'GET', '/api/livetv/recordings')).data;
  let r = await list();
  assert.deepEqual([r.recordings[0].state, r.recordings[0].problem, r.recordings[0].status], ['recording', true, 'Waiting for stream']);
  assert.equal(r.shows[0].recordingNow, true);
  const shown = (await guide()).events.find((e) => e.id === later.id);
  assert.equal(shown.dvr.state, 'recording');
  // One going to plan has no problem.
  entry.problem = false;
  r = await list();
  assert.deepEqual([r.recordings[0].state, r.recordings[0].problem, r.recordings[0].status], ['recording', false, 'Running']);
  // A recording that failed isn't "completed" in the guide, whatever Tvheadend's word for it.
  entry.state = 'failed';
  assert.equal((await guide()).events.find((e) => e.id === later.id).dvr.state, 'failed');
  entry.state = 'recorded';
  assert.equal((await guide()).events.find((e) => e.id === later.id).dvr.state, 'completed');
  tvh.dvr.clear();
});

test('Cancel arriving once a recording has started stops it, keeping what\'s recorded', async () => {
  tvh.dvr.clear();
  const now = Math.floor(Date.now() / 1000);
  forgetGuide();
  const later = (await call('admin', 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data.events.find((e) => e.start > now && e.channel === ONE);
  const { dvrUuid } = (await call('admin', 'POST', '/api/livetv/record', { eventId: later.id })).data;
  const entry = [...tvh.dvr.values()].find((d) => d.uuid === dvrUuid);
  entry.state = 'recording';
  const r = await call('admin', 'POST', `/api/livetv/recordings/${dvrUuid}/cancel`);
  assert.equal(r.status, 200);
  assert.deepEqual(tvh.calls.at(-1), ['/api/dvr/entry/stop', { uuid: dvrUuid }]);
  assert.equal(entry.state, 'recorded');
  tvh.dvr.clear();
});

test('a Tvheadend that gives a recording\'s uuid on its own, not in a list: all of it is kept', async () => {
  tvh.dvr.clear();
  tvh.uuidAsText = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    forgetGuide();
    const later = (await call('admin', 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data.events.find((e) => e.start > now && e.channel === ONE);
    const { dvrUuid } = (await call('admin', 'POST', '/api/livetv/record', { eventId: later.id })).data;
    assert.equal(dvrUuid, tvh.dvr.get(later.id).uuid);
    assert.equal((await call('admin', 'GET', '/api/livetv/recordings')).data.recordings[0].mine, true);
  } finally {
    delete tvh.uuidAsText;
    tvh.dvr.clear();
  }
});

test('deleting someone ends their series recordings, unless Tvheadend can\'t be reached', async () => {
  tvh.autorecs.clear();
  tvh.dvr.clear();
  tvh.seriesEvents = { title: 'Soap Street', channel: ONE };
  const make = async (username) => {
    const user = (await call('admin', 'POST', '/api/users', { username, password: 'correct horse', liveTvRecord: true, liveTvSeries: true })).data.user;
    tokens[username] = await signIn(username, 'correct horse');
    return user;
  };
  try {
    const now = Math.floor(Date.now() / 1000);
    forgetGuide();
    const soap = (await call('admin', 'GET', `/api/livetv/guide?from=${now}&to=${now + 3 * 3600}`)).data.events.find((e) => e.channel === ONE && e.start > now && /Soap Street/.test(e.title));
    let user = await make('seriesgone');
    assert.equal((await call('seriesgone', 'POST', '/api/livetv/series', { eventId: soap.id })).status, 200);
    assert.equal(tvh.autorecs.size, 1);
    assert.equal((await call('admin', 'DELETE', `/api/users/${user.id}`)).status, 200);
    assert.equal(tvh.autorecs.size, 0, 'nobody would see it through');
    assert.equal([...tvh.dvr.values()].filter((d) => d.state === 'scheduled').length, 0);
    // Tvheadend out of reach: the account still goes, and the series recording shows in Everyone's for an admin.
    user = await make('seriesgone2');
    await call('seriesgone2', 'POST', '/api/livetv/series', { eventId: soap.id });
    tvh.autorecsDown = true;
    assert.equal((await call('admin', 'DELETE', `/api/users/${user.id}`)).status, 200);
    tvh.autorecsDown = false;
    assert.equal(tvh.autorecs.size, 1);
    const left = (await call('admin', 'GET', '/api/livetv/recordings?all=1')).data.series;
    assert.deepEqual(left.map((s) => [s.owner, s.canChange]), [[null, true]]);
  } finally {
    delete tvh.seriesEvents;
    delete tvh.autorecsDown;
    tvh.autorecs.clear();
    tvh.dvr.clear();
  }
});

test('series recording: an admin\'s switch for each account, which needs recording and Live TV', async () => {
  const user = async () => (await call('admin', 'GET', '/api/users')).data.users.find((u) => u.id === ids.kid);
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTv: true, liveTvRecord: true });
  assert.equal((await user()).liveTvSeries, false); // off until allowed
  const now = Math.floor(Date.now() / 1000);
  const guide = async (who) => (await call(who, 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data;
  assert.equal((await guide('kid')).canRecordSeries, false);
  assert.equal((await guide('admin')).canRecordSeries, true); // admins always may
  const later = (await guide('kid')).events.find((e) => e.start > now);
  assert.equal((await call('kid', 'POST', '/api/livetv/series', { eventId: later.id })).status, 403);
  const patched = await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvSeries: true });
  assert.equal(patched.data.user.liveTvSeries, true);
  assert.equal((await guide('kid')).canRecordSeries, true);
  // It goes with recording, and with Live TV, and doesn't come back by itself.
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: false });
  assert.equal((await user()).liveTvSeries, false);
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: true });
  assert.equal((await user()).liveTvSeries, false);
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvSeries: true });
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTv: false });
  assert.equal((await user()).liveTvSeries, false);
  // Asked for without being allowed to record, it stays off; a new account can be given it from the start.
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTv: true, liveTvSeries: true });
  assert.equal((await user()).liveTvSeries, false);
  const made = await call('admin', 'POST', '/api/users', { username: 'seriesfan', password: 'correct horse', liveTvRecord: true, liveTvSeries: true });
  assert.equal(made.data.user.liveTvSeries, true);
  const notRecording = await call('admin', 'POST', '/api/users', { username: 'seriesless', password: 'correct horse', liveTvRecord: false, liveTvSeries: true });
  assert.equal(notRecording.data.user.liveTvSeries, false);
  for (const u of [made, notRecording]) await call('admin', 'DELETE', `/api/users/${u.data.user.id}`);
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: false });
});

test('series recording: what Tvheadend is asked for, for a show and its "New: " episodes', () => {
  assert.equal(seriesTitlePattern('News'), '^(new *: *)?News$');
  assert.equal(seriesTitlePattern('Quiz (Night) + More?'), '^(new *: *)?Quiz \\(Night\\) \\+ More\\?$');
  const pattern = new RegExp(seriesTitlePattern('Mock The Week'), 'i');
  for (const title of ['Mock The Week', 'New: Mock The Week', 'new:Mock The Week']) assert.ok(pattern.test(title), title);
  for (const title of ['Mock The Week Again', 'The Mock The Week', 'Newsnight']) assert.ok(!pattern.test(title), title);
  assert.ok(!new RegExp(seriesTitlePattern('News'), 'i').test('Newsnight'));
});

test('series recording: set from the guide, listed on Manage Recordings, one person\'s for each show on a channel', async () => {
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTv: true, liveTvRecord: true, liveTvSeries: true });
  tvh.autorecs.clear();
  tvh.dvr.clear();
  tvh.seriesEvents = { title: 'Soap Street', channel: ONE };
  try {
    const now = Math.floor(Date.now() / 1000);
    const guide = async (who) => (await call(who, 'GET', `/api/livetv/guide?from=${now}&to=${now + 3 * 3600}`)).data;
    const soaps = (await guide('kid')).events.filter((e) => e.channel === ONE && e.start > now && /Soap Street/.test(e.title));
    assert.ok(soaps.length >= 2, 'the fake guide has the show');
    assert.equal((await call('kid', 'POST', '/api/livetv/series', { eventId: 'nope' })).status, 400);
    assert.equal((await call('kid', 'POST', '/api/livetv/series', { eventId: 987654 })).status, 404);

    let r = await call('kid', 'POST', '/api/livetv/series', { eventId: soaps[0].id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const uuid = r.data.uuid;
    const conf = tvh.autorecs.get(uuid);
    // The show's own name, however this episode was called; on that channel; repeats left out, as Tvheadend offers it.
    assert.equal(conf.name, 'Soap Street');
    assert.equal(conf.title, '^(new *: *)?Soap Street$');
    assert.equal(conf.channel, ONE);
    assert.equal(conf.record, 14);
    assert.equal(conf.config_name, PROFILE);
    assert.equal(conf.comment, 'Reelhouse: kid');
    assert.equal(conf.serieslink, 'crid://test/soap');
    assert.match(recentLogs(5).map((l) => l.msg).join('\n'), /User "kid" set a series recording of "Soap Street" on One/);

    // The guide shows every episode as made by it, and it's the kid's to change (not someone else's).
    const seen = (await guide('kid')).events.filter((e) => soaps.some((s) => s.id === e.id));
    assert.ok(seen.every((e) => e.dvr?.series === uuid && e.dvr.state === 'scheduled' && e.dvr.canChange === true), JSON.stringify(seen.map((e) => e.dvr)));
    await call('admin', 'PATCH', `/api/users/${ids.nolive}`, { liveTv: true, liveTvRecord: true, liveTvSeries: true });
    const others = (await guide('nolive')).events.find((e) => e.id === soaps[0].id);
    assert.equal(others.dvr.canChange, false);

    // Asking again changes nothing; someone else asking is told whose it is.
    const again = (await call('kid', 'POST', '/api/livetv/series', { eventId: soaps[1].id })).data;
    assert.deepEqual([again.uuid, again.already], [uuid, true], 'and it says so');
    assert.equal(tvh.autorecs.size, 1);
    r = await call('nolive', 'POST', '/api/livetv/series', { eventId: soaps[1].id });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /kid already has a series recording of “Soap Street” on this channel/);

    // The next series with a series link of its own isn't caught by the old one (Tvheadend goes by the link alone), so
    // asking for it sets another, rather than saying it's done and leaving it unrecorded.
    tvh.seriesEvents.link = 'crid://test/soap-next-series';
    const nextSeries = (await call('kid', 'POST', '/api/livetv/series', { eventId: soaps[1].id })).data;
    assert.notEqual(nextSeries.uuid, uuid);
    assert.equal(nextSeries.already, undefined);
    assert.equal(tvh.autorecs.get(nextSeries.uuid).serieslink, 'crid://test/soap-next-series');
    assert.equal((await call('nolive', 'POST', '/api/livetv/series', { eventId: soaps[1].id })).status, 409, 'that one has its person too');
    assert.equal((await call('kid', 'POST', `/api/livetv/series/${nextSeries.uuid}/cancel`)).status, 200);
    delete tvh.seriesEvents.link;

    // Manage Recordings: theirs and the admin's everyone's, with what it has made.
    const list = async (who, query = '') => (await call(who, 'GET', `/api/livetv/recordings${query}`)).data;
    let kids = await list('kid');
    assert.equal(kids.series.length, 1);
    assert.deepEqual(
      [kids.series[0].uuid, kids.series[0].title, kids.series[0].key, kids.series[0].channel.name, kids.series[0].owner.username, kids.series[0].mine, kids.series[0].canChange],
      [uuid, 'Soap Street', 'soap street', 'One', 'kid', true, true],
    );
    assert.equal(kids.series[0].counts.scheduled, kids.recordings.length);
    assert.equal(kids.series[0].next, Math.min(...kids.recordings.map((x) => x.start)));
    assert.ok(!('serieslink' in kids.series[0]));
    assert.ok(kids.recordings.every((x) => x.series === uuid && x.mine && x.canChange && x.owner.username === 'kid' && !('skipped' in x)));
    assert.deepEqual((await list('nolive')).series, []);
    assert.deepEqual((await list('admin')).series, []); // the admin's own
    const allOfThem = await list('admin', '?all=1');
    assert.deepEqual([allOfThem.series[0].uuid, allOfThem.series[0].mine, allOfThem.series[0].canChange], [uuid, false, true]);

    // Skipping an episode: switched off rather than cancelled (cancelled, Tvheadend would schedule it again), gone from
    // the list, marked in the guide, and put back from there.
    const episode = kids.recordings.find((x) => x.start === Math.max(...kids.recordings.map((y) => y.start)));
    r = await call('kid', 'POST', `/api/livetv/recordings/${episode.uuid}/cancel`);
    assert.equal(r.status, 200);
    assert.deepEqual(tvh.calls.at(-1), ['/api/idnode/save', { node: JSON.stringify({ uuid: episode.uuid, enabled: false }) }]);
    assert.ok([...tvh.dvr.values()].some((d) => d.uuid === episode.uuid), 'still in Tvheadend');
    kids = await list('kid');
    assert.ok(!kids.recordings.some((x) => x.uuid === episode.uuid));
    assert.equal((await guide('kid')).events.find((e) => e.dvr?.uuid === episode.uuid).dvr.state, 'skipped');
    assert.equal((await call('nolive', 'POST', `/api/livetv/recordings/${episode.uuid}/record`)).status, 403);
    r = await call('kid', 'POST', `/api/livetv/recordings/${episode.uuid}/record`);
    assert.equal(r.status, 200);
    assert.deepEqual(tvh.calls.at(-1), ['/api/idnode/save', { node: JSON.stringify({ uuid: episode.uuid, enabled: true }) }]);
    assert.ok((await list('kid')).recordings.some((x) => x.uuid === episode.uuid));
    assert.equal((await call('admin', 'POST', `/api/livetv/recordings/${'ab'.repeat(16)}/record`)).status, 404);

    // Cancelling it: only its person or an admin. What's scheduled goes; what's recording stays, and stays theirs though
    // Tvheadend no longer says what made it.
    const started = [...tvh.dvr.values()].find((d) => d.autorec === uuid);
    started.state = 'recording';
    assert.equal((await call('nolive', 'POST', `/api/livetv/series/${uuid}/cancel`)).status, 403);
    tvh.deletedNodes = [];
    r = await call('kid', 'POST', `/api/livetv/series/${uuid}/cancel`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(tvh.deletedNodes, [uuid]);
    assert.equal(tvh.autorecs.size, 0);
    assert.match(recentLogs(5).map((l) => l.msg).join('\n'), /User "kid" cancelled the series recording of "Soap Street"/);
    kids = await list('kid');
    assert.deepEqual(kids.series, []);
    assert.deepEqual(kids.recordings.map((x) => [x.uuid, x.state, x.series, x.mine]), [[started.uuid, 'recording', null, true]]);
    assert.equal((await call('admin', 'POST', `/api/livetv/series/${uuid}/cancel`)).status, 404);
    assert.equal((await call('kid', 'POST', '/api/livetv/series/not-a-uuid/cancel')).status, 400);
    // Only series recordings Tvheadend lists go that way: the call behind it could delete anything of Tvheadend's.
    tvh.deletedNodes = [];
    assert.equal((await call('admin', 'POST', `/api/livetv/series/${ONE.padEnd(32, '0').slice(0, 32)}/cancel`)).status, 404);
    assert.deepEqual(tvh.deletedNodes, []);

    // A series recording set in Tvheadend itself is for admins to see, as anything Reelhouse didn't set.
    const elsewhere = 'c0'.repeat(16);
    tvh.autorecs.set(elsewhere, { title: 'Soap Street', channel: ONE, name: '' });
    assert.deepEqual((await list('kid')).series, []);
    const shown = (await list('admin', '?all=1')).series[0];
    assert.deepEqual([shown.uuid, shown.owner, shown.mine, shown.canChange], [elsewhere, null, false, true]);
    r = await call('kid', 'POST', '/api/livetv/series', { eventId: soaps[1].id });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Tvheadend already has a series recording/);
    assert.equal((await call('kid', 'POST', `/api/livetv/series/${elsewhere}/cancel`)).status, 403);
    assert.equal((await call('admin', 'POST', `/api/livetv/series/${elsewhere}/cancel`)).status, 200);

    // An older Tvheadend without that setting for repeats: the next best it has.
    tvh.recordChoices = [15, 0, 1];
    r = await call('kid', 'POST', '/api/livetv/series', { eventId: soaps[1].id });
    assert.equal(tvh.autorecs.get(r.data.uuid).record, 1);
    await call('kid', 'POST', `/api/livetv/series/${r.data.uuid}/cancel`);
    tvh.recordChoices = [15, 0];
    r = await call('kid', 'POST', '/api/livetv/series', { eventId: soaps[1].id });
    assert.equal(tvh.autorecs.get(r.data.uuid).record, 15);
  } finally {
    delete tvh.seriesEvents;
    tvh.recordChoices = [15, 0, 14, 1];
    tvh.autorecs.clear();
    tvh.dvr.clear();
    await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: false });
    await call('admin', 'PATCH', `/api/users/${ids.nolive}`, { liveTv: false });
  }
});

test('the Recordings page: people see and change their own recordings, admins everyone\'s', async () => {
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: true });
  const now = Math.floor(Date.now() / 1000);
  const guide = (await call('admin', 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data;
  const [first, second, third] = guide.events.filter((e) => e.start > now && e.channel === ONE);
  const adminsOwn = (await call('admin', 'POST', '/api/livetv/record', { eventId: third.id })).data.dvrUuid;
  const kidsOwn = (await call('kid', 'POST', '/api/livetv/record', { eventId: second.id })).data.dvrUuid;
  assert.deepEqual(tvh.calls.at(-1)[1].comment, 'Reelhouse: kid'); // shown in Tvheadend's own list
  // One Reelhouse didn't schedule (from before this, or set in Tvheadend), and one of the kid's that's recorded.
  const elsewhere = 'e1'.repeat(16);
  tvh.dvr.set(first.id, { uuid: elsewhere, state: 'scheduled', event: events(Date.now() / 1000).find((e) => e.eventId === first.id) });
  const recorded = (await call('kid', 'POST', '/api/livetv/record', { eventId: guide.events.find((e) => e.start > now && e.channel === TWO).id })).data.dvrUuid;
  [...tvh.dvr.values()].find((d) => d.uuid === recorded).state = 'recorded';

  const list = async (who, query = '') => (await call(who, 'GET', `/api/livetv/recordings${query}`)).data;
  let r = await list('kid');
  // How full the recordings drive is, for anyone allowed here, and the list doesn't depend on Tvheadend saying.
  assert.deepEqual(r.drive, { free: 400e9, total: 1000e9, recordings: 12e9 });
  tvh.noDriveReport = true;
  const withoutDrive = await list('kid');
  assert.deepEqual([withoutDrive.drive, withoutDrive.recordings.length], [null, 2]);
  tvh.noDriveReport = false;
  // Scheduled soonest first, then what's recorded.
  assert.deepEqual(r.recordings.map((x) => [x.uuid, x.state, x.mine, x.canChange, x.owner.username]),
    [[kidsOwn, 'scheduled', true, true, 'kid'], [recorded, 'recorded', true, true, 'kid']]);
  assert.equal(r.everyone, false);
  assert.deepEqual(r.recordings[0].channel, { uuid: ONE, name: 'One', number: 1, radio: false, icon: r.recordings[0].channel.icon });
  assert.deepEqual([r.recordings[0].title, r.recordings[0].size, r.recordings[1].size, r.recordings[1].status], [second.title, null, 1234567, 'Completed OK']);
  assert.equal((await list('kid', '?all=1')).recordings.length, 2, 'only admins see everyone\'s');
  assert.deepEqual((await list('admin')).recordings.map((x) => x.uuid), [adminsOwn]);
  r = await list('admin', '?all=1');
  assert.equal(r.everyone, true);
  assert.deepEqual(r.recordings.map((x) => [x.uuid, x.owner?.username ?? null, x.mine, x.canChange]),
    [[elsewhere, null, false, true], [kidsOwn, 'kid', false, true], [adminsOwn, 'admin', true, true], [recorded, 'kid', false, true]]);
  assert.equal((await call('nolive', 'GET', '/api/livetv/recordings')).status, 403);

  // The guide says which recordings someone may cancel: their own; an admin any.
  const dvrIn = async (who, id) => (await call(who, 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data.events.find((e) => e.id === id).dvr;
  assert.equal((await dvrIn('kid', third.id)).canChange, false);
  assert.equal((await dvrIn('kid', second.id)).canChange, true);
  assert.equal((await dvrIn('kid', first.id)).canChange, false);
  assert.equal((await dvrIn('admin', first.id)).canChange, true);

  // Only the person who set it, or an admin.
  r = await call('kid', 'POST', `/api/livetv/recordings/${adminsOwn}/cancel`);
  assert.deepEqual([r.status, r.data.error], [403, 'Only the person who set this recording, or an admin, can change it']);
  assert.equal((await call('kid', 'POST', `/api/livetv/recordings/${elsewhere}/cancel`)).status, 403);
  assert.equal((await call('kid', 'POST', `/api/livetv/recordings/${kidsOwn}/cancel`)).status, 200);
  assert.equal((await call('admin', 'POST', `/api/livetv/recordings/${elsewhere}/cancel`)).status, 200);
  // Deleting a finished one deletes it in Tvheadend (its file too).
  r = await call('kid', 'POST', `/api/livetv/recordings/${recorded}/delete`);
  assert.equal(r.status, 200);
  assert.deepEqual(tvh.calls.at(-1), ['/api/dvr/entry/remove', { uuid: recorded }]);
  assert.match(recentLogs(5).map((l) => l.msg).join('\n'), new RegExp(`User "kid" deleted a recording \\(${recorded}\\)`));
  assert.deepEqual((await list('kid')).recordings, []);
  // Gone from Tvheadend already: said plainly, and forgotten.
  r = await call('admin', 'POST', `/api/livetv/recordings/${recorded}/delete`);
  assert.deepEqual([r.status, r.data.error], [404, 'That recording isn\'t in Tvheadend any more']);
  assert.equal((await call('admin', 'POST', `/api/livetv/recordings/${adminsOwn}/rename`)).status, 404);
  assert.equal((await call('admin', 'POST', `/api/livetv/recordings/${adminsOwn}/stop`)).status, 200);
  assert.equal((await list('admin')).recordings[0].state, 'recorded', 'stopping keeps what was recorded');
  assert.equal((await call('admin', 'POST', `/api/livetv/recordings/${adminsOwn}/delete`)).status, 200);
  assert.deepEqual((await list('admin', '?all=1')).recordings, []);
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: false });
});

test('Recordings as a library: shows with their series, the guide\'s picture, a series deleted at once', async () => {
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: true });
  const now = Math.floor(Date.now() / 1000);
  const guide = (await call('admin', 'GET', `/api/livetv/guide?from=${now}&to=${now + 7200}`)).data;
  const later = guide.events.filter((e) => e.start > now && e.channel === ONE).slice(0, 3);
  const kids = [];
  for (const e of later) kids.push((await call('kid', 'POST', '/api/livetv/record', { eventId: e.id })).data.dvrUuid);
  const admins = (await call('admin', 'POST', '/api/livetv/record', { eventId: guide.events.find((e) => e.start > now && e.channel === TWO).id })).data.dvrUuid;
  // Three episodes of one show: two recorded (the first with a picture in the guide), one still to come.
  const entry = (uuid) => [...tvh.dvr.values()].find((d) => d.uuid === uuid);
  kids.forEach((uuid, n) => Object.assign(entry(uuid).event, { title: 'Late Comedy', seasonNumber: 1, episodeNumber: n + 1 }));
  entry(kids[0]).state = 'recorded';
  entry(kids[1]).state = 'recorded';
  entry(kids[0]).image = 'imagecache/1';

  let r = await call('kid', 'GET', '/api/livetv/recordings');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.shows.map((s) => s.title), ['Late Comedy']);
  const show = r.data.shows[0];
  assert.deepEqual(show.seasons.map((s) => [s.season, s.recordings.map((x) => [x.uuid, x.episode, x.state])]),
    [[1, [[kids[0], 1, 'recorded'], [kids[1], 2, 'recorded'], [kids[2], 3, 'scheduled']]]]);
  assert.deepEqual(show.counts, { recording: 0, scheduled: 1, recorded: 2, failed: 0 });
  assert.equal(show.channel.name, 'One');
  assert.ok(r.data.recordings.every((x) => !('image' in x)), 'Tvheadend\'s own picture address stays on the server');
  // No TMDB key here: the guide's picture, through Reelhouse.
  assert.equal(show.poster, `/api/livetv/recordings/${kids[0]}/image`);
  const picture = await call('kid', 'GET', show.poster);
  assert.equal(picture.status, 200);
  assert.ok(picture.data.equals(PNG));
  assert.equal((await call('kid', 'GET', `/api/livetv/recordings/${kids[1]}/image`)).status, 404, 'no picture');
  assert.equal((await call('kid', 'GET', `/api/livetv/recordings/${admins}/image`)).status, 404, 'not theirs');

  // Deleting the series: its recorded episodes go; the one still to come stays, as does what isn't theirs.
  tvh.calls.length = 0;
  r = await call('kid', 'POST', '/api/livetv/recordings/delete', { uuids: [...kids, admins] });
  assert.deepEqual(r.data, { deleted: 2, skipped: [kids[2], admins] });
  assert.deepEqual(tvh.calls.filter(([p]) => p === '/api/dvr/entry/remove').map(([, f]) => f.uuid), [kids[0], kids[1]]);
  assert.deepEqual((await call('kid', 'GET', '/api/livetv/recordings')).data.recordings.map((x) => x.uuid), [kids[2]]);
  assert.match(recentLogs(5).map((l) => l.msg).join('\n'), /User "kid" deleted 2 recordings/);
  for (const bad of [{}, { uuids: [] }, { uuids: ['nope'] }]) {
    assert.equal((await call('kid', 'POST', '/api/livetv/recordings/delete', bad)).status, 400);
  }
  await call('kid', 'POST', `/api/livetv/recordings/${kids[2]}/cancel`);
  await call('admin', 'POST', `/api/livetv/recordings/${admins}/cancel`);
  await call('admin', 'PATCH', `/api/users/${ids.kid}`, { liveTvRecord: false });
});

test('watching: deinterlaced H.264 + AAC from the broadcast stream, logged, and the tuner freed on stop', async () => {
  clearStreams();
  // Its first start: the picture (576 lines) isn't known until ffmpeg describes the stream, so the 720p preset asked
  // for turns out to be above it and counts as the original; only presets below the channel are offered.
  const r = await call('kid', 'POST', `/api/livetv/play/${ONE}`, { quality: '4m-720' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.quality, 'original');
  assert.deepEqual(r.data.qualities, ['original', '1500k-480', '720k-360']);
  assert.equal(r.data.channel.name, 'One');
  assert.ok(r.data.now?.title, 'what is on now');
  const playlist = (await fetch(`${base}${r.data.url}`)).text();
  const names = [...(await playlist).matchAll(/\n(\d+\.ts)/g)].map((m) => m[1]);
  assert.ok(names.length >= 1);
  const seg = await fetch(`${base}${r.data.url.replace('index.m3u8', names[0])}`);
  assert.equal(seg.status, 200);
  const file = path.join(dataDir, 'seg.ts');
  fs.writeFileSync(file, Buffer.from(await seg.arrayBuffer()));
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,field_order,channels', '-of', 'csv=p=0', file]).toString();
  // (Listed under the program too.)
  assert.deepEqual([...new Set(probe.split(/\r?\n/).filter(Boolean))], ['h264,progressive', 'aac,2']);
  assert.equal(tvh.openStreams, 1);
  const stream = listStreams().find((s) => s.playId === r.data.playId);
  assert.equal(stream.mode, 'live');
  assert.match(recentLogs(10).map((l) => l.msg).join('\n'), /User "kid" started "One" on .* \(live TV; Original\)/);
  // The player stops: the conversion ends and Tvheadend's stream (its tuner) is let go at once.
  await call('kid', 'POST', '/api/livetv/progress', { playId: r.data.playId, state: 'stopped' });
  assert.ok(await waitFor(() => tvh.openStreams === 0), 'stream closed');
  assert.equal(listLiveSessions().length, 0);
  assert.equal((await fetch(`${base}${r.data.url}`)).status, 404);
});

test('a channel the player gave up on while it started (a quick channel change) is let go once it is ready', async () => {
  clearStreams();
  // The player stops waiting after a moment, long before the first seconds are ready.
  const gaveUp = new AbortController();
  const started = fetch(`${base}/api/livetv/play/${ONE}`, {
    method: 'POST', headers: { ...H, authorization: `Bearer ${tokens.kid}` }, body: '{}', signal: gaveUp.signal,
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 100));
  gaveUp.abort();
  await started;
  // The server carries on until the first seconds are ready (it had started Tvheadend's stream)…
  assert.ok(await waitFor(() => tvh.openStreams === 1, 5000), 'the channel was started');
  // …then lets it go, rather than keeping it for the quiet timeout (half a minute, holding a tuner and a place in
  // the person's device limit).
  assert.ok(await waitFor(() => tvh.openStreams === 0 && listLiveSessions().length === 0, 8000), 'the conversion ended');
  assert.ok(!listStreams().some((s) => s.mode === 'live'), 'not listed as being watched');
});

test('a player that goes quiet ends its conversion; no free tuner is said plainly', async () => {
  const idle = liveLimits.idleEndMs;
  liveLimits.idleEndMs = 1500;
  try {
    const r = await call('admin', 'POST', `/api/livetv/play/${ONE}`, {});
    assert.equal(r.status, 200);
    assert.equal(tvh.openStreams, 1);
    assert.ok(listStreams().some((s) => s.playId === r.data.playId));
    assert.ok(await waitFor(() => tvh.openStreams === 0, 8000), 'stream closed after going quiet');
    // …and Activity & logs no longer lists it.
    assert.ok(await waitFor(() => !listStreams().some((s) => s.playId === r.data.playId), 3000));
    assert.match(recentLogs(5).map((l) => l.msg).join('\n'), /User "admin" stopped "One" .*the player went quiet/);
  } finally {
    liveLimits.idleEndMs = idle;
  }
  const busy = await call('admin', 'POST', `/api/livetv/play/${TWO}`, {});
  assert.equal(busy.status, 503);
  assert.match(busy.data.error, /no free tuner/);
  assert.equal((await call('admin', 'POST', `/api/livetv/play/${'0'.repeat(32)}`, {})).status, 404);
});

test('requests sent together all sign in (each answers the challenge it got), a wrong password still fails', async () => {
  const { Tvheadend } = await import('../server/livetv/tvheadend.js');
  const client = new Tvheadend({ url: tvhUrl, username: 'reelhouse', password: 'right horse' });
  const answers = await Promise.all(Array.from({ length: 6 }, () => client.serverInfo()));
  assert.ok(answers.every((a) => a.name === 'Tvheadend'));
  const wrong = new Tvheadend({ url: tvhUrl, username: 'reelhouse', password: 'nope' });
  await assert.rejects(Promise.all([wrong.serverInfo(), wrong.serverInfo()]), /isn't allowed|didn't accept/);
});

test('Settings → Live TV deletes the kept guide data and fetches it again; nothing goes while Tvheadend fails', async () => {
  const dir = path.join(dataDir, 'cache', 'channel-icons');
  const now = Math.floor(Date.now() / 1000);
  const guide = async () => (await call('kid', 'GET', `/api/livetv/guide?from=${now}&to=${now + 3600}`)).data;
  // From the tests before: logos kept, and Quiet FM learned to be radio when it played.
  assert.ok(fs.existsSync(path.join(dir, `${ONE}.json`)));
  assert.equal((await guide()).channels.find((c) => c.uuid === UNTAGGED).radio, true);

  assert.equal((await call('kid', 'POST', '/api/admin/livetv/refresh')).status, 403);
  tvh.channelsDown = true;
  try {
    const r = await call('admin', 'POST', '/api/admin/livetv/refresh');
    assert.equal(r.status, 400);
    assert.match(r.data.error, /nothing was deleted/);
    assert.ok(fs.existsSync(path.join(dir, `${ONE}.json`)), 'the logos are kept');
    assert.equal((await guide()).channels.find((c) => c.uuid === UNTAGGED).radio, true);
  } finally {
    tvh.channelsDown = false;
  }

  const fetches = tvh.iconFetches;
  const r = await call('admin', 'POST', '/api/admin/livetv/refresh');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.removedLogos, 2);
  assert.deepEqual(
    { channels: r.data.channels, radio: r.data.radio, withLogo: r.data.withLogo, logos: r.data.logos, pending: r.data.logosPending, guideChannels: r.data.guideChannels },
    { channels: 4, radio: 1, withLogo: 2, logos: 2, pending: false, guideChannels: 2 },
  );
  assert.ok(r.data.programmes > 0);
  assert.equal(tvh.iconFetches, fetches + 1, 'One\'s logo fetched again');
  assert.ok(fs.existsSync(path.join(dir, `${ONE}.png`)));
  // What was learned went with it: Quiet FM is listed as TV until it plays without a picture again.
  assert.equal((await guide()).channels.find((c) => c.uuid === UNTAGGED).radio, false);
  assert.match(recentLogs(5).map((l) => l.msg).join('\n'),
    /User "admin" deleted Live TV's kept guide data and 2 logos, and fetched them again: 4 channels \(1 radio\), 2 logos, \d+ programmes in the next day/);
});

test('genre names Tvheadend couldn\'t give (still starting) are asked for again, the guide showing meanwhile', async () => {
  await call('admin', 'POST', '/api/admin/livetv/refresh'); // forgets the names kept by the tests before
  const now = Math.floor(Date.now() / 1000);
  const comedy = async () => {
    const r = await call('kid', 'GET', `/api/livetv/guide?from=${now - 600}&to=${now + 3600}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.events.find((e) => e.genre[0] === 20).genreName;
  };
  tvh.genresDown = true;
  try {
    assert.equal(await comedy(), null);
  } finally {
    tvh.genresDown = false;
  }
  assert.equal(await comedy(), 'Comedy');
});

test('live qualities: Original and the presets below the channel, never above it', async () => {
  const ids = (video) => liveQualities(video).map((q) => q.id);
  // A live Original is capped at 10 Mbps (its bitrate isn't known), so 12 and 20 Mbps are never lower.
  assert.deepEqual(ids({ width: 1920, height: 1080 }), ['original', '8m-1080', '4m-720', '2m-720', '1500k-480', '720k-360']);
  assert.deepEqual(ids({ width: 1440, height: 1080 }), ids({ width: 1920, height: 1080 }));
  assert.deepEqual(ids({ width: 720, height: 576 }), ['original', '1500k-480', '720k-360']);
  assert.deepEqual(ids(null), ['original', '8m-1080', '4m-720', '2m-720', '1500k-480', '720k-360']);
  assert.deepEqual(liveQualities(null, { radio: true }).map((q) => q.id), ['original']);

  // Channel One's picture is known from its earlier starts: a preset above it starts as the original; one below stays.
  for (const [asked, used] of [['12m-1080', 'original'], ['2m-720', 'original'], ['1500k-480', '1500k-480']]) {
    const r = await call('kid', 'POST', `/api/livetv/play/${ONE}`, { quality: asked });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.quality, used, asked);
    assert.deepEqual(r.data.qualities, ['original', '1500k-480', '720k-360']);
    await call('kid', 'POST', '/api/livetv/progress', { playId: r.data.playId, state: 'stopped' });
  }
  assert.ok(await waitFor(() => tvh.openStreams === 0), 'streams closed');
});
