// Settings → Languages: the preferred sound track and how subtitles start, for everyone. The language table, what
// players are sent (/api/me's defaults and the live "defaults" event), the checks, and the sound track a playback
// starts with: the preferred language's, converted for a browser (it plays only a file's default track) but played as
// it is by the Android app, which switches tracks itself (caps.audioTracks).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-languages-'));
process.env.REELHOUSE_DATA = dataDir;
const { openDb, closeDb, run } = await import('../server/db.js');
const { hashPassword } = await import('../server/auth.js');
const { createApp } = await import('../server/app.js');
const { LANGUAGES, codesFor, inLanguage, languageOfRegion } = await import('../server/media/languages.js');
const { preferredAudioIndex } = await import('../server/routes/playback.js');
const { decide } = await import('../server/transcode/profile.js');

let server;
let base;
const tokens = {};
const H = { 'content-type': 'application/json', 'x-requested-with': 'reelhouse' };
const movie = path.join(dataDir, 'Two Tongues (2020).mp4');
const MEDIA = {
  container: 'mp4', duration: 600, bitrate: 2_000_000,
  video: { index: 0, codec: 'h264', profile: 'High', bitDepth: 8, width: 1280, height: 720 },
  audio: [{ index: 1, codec: 'aac', language: 'eng', isDefault: true }, { index: 2, codec: 'aac', language: 'fre' }],
  subtitles: [],
};
const BROWSER = { containers: ['mp4'], video: ['h264'], audio: ['aac'] };
const APP = { ...BROWSER, audioTracks: true };

async function call(who, method, p, body) {
  const res = await fetch(base + p, { method, headers: { ...H, authorization: `Bearer ${tokens[who]}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const defaults = async () => (await call('viewer', 'GET', '/api/me')).data.defaults;
const save = (patch) => call('admin', 'PUT', '/api/settings', patch);

before(async () => {
  openDb(':memory:');
  fs.writeFileSync(movie, 'not really a movie');
  const t = Date.now();
  run("INSERT INTO libraries (id, name, type, paths, created_at) VALUES (1, 'Movies', 'movie', '[]', ?)", t);
  run("INSERT INTO items (id, library_id, type, title, sort_title, year, file_path, media_json, duration, added_at, updated_at) VALUES (1, 1, 'movie', 'Two Tongues', 'two tongues', 2020, ?, ?, 600, ?, ?)",
    movie, JSON.stringify(MEDIA), t, t);
  const pw = await hashPassword('a long password');
  run("INSERT INTO users (id, username, password_hash, is_admin, created_at) VALUES (1, 'admin', ?, 1, ?), (2, 'viewer', ?, 0, ?)", pw, t, pw, t);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['admin', 'viewer']) {
    tokens[who] = (await (await fetch(`${base}/api/auth/device`, { method: 'POST', headers: H, body: JSON.stringify({ username: who, password: 'a long password', device: `test ${who}` }) })).json()).token;
  }
});

after(() => {
  server.closeAllConnections();
  server.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the languages: every code a file may use for one, whatever its case or region', () => {
  assert.deepEqual(codesFor('fr'), ['fr', 'fre', 'fra']);
  assert.deepEqual(codesFor('FRA'), ['fr', 'fre', 'fra'], 'any of its codes finds it');
  assert.deepEqual(codesFor('de-DE'), ['de', 'ger', 'deu']);
  assert.deepEqual(codesFor('xx'), []);
  assert.deepEqual(codesFor(''), []);
  assert.ok(inLanguage('ENG', codesFor('en')) && inLanguage('en-GB', codesFor('en')));
  assert.ok(!inLanguage('fre', codesFor('en')) && !inLanguage(null, codesFor('en')));
  assert.equal(languageOfRegion('nl-BE'), 'nl');
  assert.equal(languageOfRegion('xx-YY'), 'en', 'English when the metadata language isn’t listed');
  assert.equal(new Set(LANGUAGES).size, LANGUAGES.length);
  const all = LANGUAGES.flatMap((id) => codesFor(id));
  assert.equal(new Set(all).size, all.length, 'no code belongs to two languages');
});

test('a new server: the file’s default sound track, forced subtitles only, in the metadata language', async () => {
  const d = await defaults();
  assert.deepEqual(d.audio, { language: null, codes: [] });
  assert.deepEqual(d.subtitles, { mode: 'forced', language: 'en', codes: ['en', 'eng'] });
  // An empty subtitle language follows the metadata language.
  assert.equal((await save({ metadataLanguage: 'fr-FR' })).status, 200);
  assert.deepEqual((await defaults()).subtitles, { mode: 'forced', language: 'fr', codes: ['fr', 'fre', 'fra'] });
  await save({ metadataLanguage: 'en-US' });
});

test('admins set them, nonsense is refused, and others can’t', async () => {
  let r = await save({ audioLanguage: 'fr', subtitleMode: 'foreign', subtitleLanguage: 'de' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.changed.sort(), ['audioLanguage', 'subtitleLanguage', 'subtitleMode']);
  const d = await defaults();
  assert.deepEqual(d.audio, { language: 'fr', codes: ['fr', 'fre', 'fra'] });
  assert.deepEqual(d.subtitles, { mode: 'foreign', language: 'de', codes: ['de', 'ger', 'deu'] });
  for (const bad of [{ subtitleMode: 'sometimes' }, { subtitleLanguage: 'xx' }, { audioLanguage: 'english' }]) {
    assert.equal((await save(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('viewer', 'PUT', '/api/settings', { subtitleMode: 'off' })).status, 403);
  const { data } = await call('admin', 'GET', '/api/settings');
  assert.ok(data.options.languages.includes('fr'));
  assert.deepEqual(data.options.subtitleModes, ['off', 'forced', 'foreign', 'always']);
  r = await save({ audioLanguage: '', subtitleMode: 'forced', subtitleLanguage: '' });
  assert.equal(r.status, 200);
  assert.deepEqual((await defaults()).audio, { language: null, codes: [] });
});

test('a change reaches open pages and apps at once (the defaults event)', async () => {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${tokens.viewer}` }, signal: abort.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const heard = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      text += decoder.decode(value, { stream: true });
      const m = /event: defaults\ndata: (.*)\n/.exec(text);
      if (m) return JSON.parse(m[1]);
    }
  })();
  await new Promise((r) => setTimeout(r, 200));
  await save({ subtitleMode: 'always' });
  const got = await Promise.race([heard, new Promise((r) => setTimeout(() => r('timed out'), 3000))]);
  abort.abort();
  assert.equal(got?.subtitles?.mode, 'always');
  await save({ subtitleMode: 'forced' });
});

test('the sound track: the preferred language’s when the file’s default isn’t in it', () => {
  assert.equal(preferredAudioIndex(MEDIA, 'fr'), 2);
  assert.equal(preferredAudioIndex(MEDIA, 'en'), null, 'the default already is');
  assert.equal(preferredAudioIndex(MEDIA, ''), null, 'none preferred');
  assert.equal(preferredAudioIndex(MEDIA, 'de'), null, 'none in it');
  assert.equal(preferredAudioIndex({ ...MEDIA, audio: [] }, 'fr'), null);
  // A browser plays only a file's default track, so another is converted; the app switches tracks itself.
  const browser = decide(MEDIA, BROWSER, { audioIndex: 2 });
  assert.equal(browser.mode, 'hls');
  assert.ok(browser.reasons.includes('alternate audio track'));
  const app = decide(MEDIA, APP, { audioIndex: 2 });
  assert.equal(app.mode, 'direct');
  assert.equal(app.audio.index, 2);
});

test('a playback starts on the preferred track, unless the player asked for one', async () => {
  await save({ audioLanguage: 'fr' });
  let r = await call('viewer', 'POST', '/api/playback/1', { caps: APP });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'direct');
  assert.equal(r.data.audioIndex, 2);
  r = await call('viewer', 'POST', '/api/playback/1', { caps: APP, audioIndex: 1, previousSession: r.data.sessionId });
  assert.equal(r.data.audioIndex, 1, 'a track picked in the player wins');
  await save({ audioLanguage: '' });
  r = await call('viewer', 'POST', '/api/playback/1', { caps: APP });
  assert.equal(r.data.audioIndex, 1, 'none preferred: the file’s default');
});
