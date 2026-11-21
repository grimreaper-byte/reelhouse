// The subtitles the web player starts with (web/js/subtitle-choice.js), as Settings → Languages says: the episode
// before's choice first, then the mode (off, forced, foreign, always) with the preferred language's codes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseSubtitle, preferredSubtitle, isSdh } from '../web/js/subtitle-choice.js';

const EN = ['en', 'eng'];
const FR = ['fr', 'fre', 'fra'];
const english = { id: 's2', kind: 'text', language: 'eng', title: 'English', forced: false, isDefault: true };
const englishSdh = { id: 's3', kind: 'text', language: 'eng', title: 'English (SDH)', forced: false };
const englishForced = { id: 's4', kind: 'text', language: 'eng', title: 'English (forced)', forced: true };
const french = { id: 's5', kind: 'text', language: 'fre', title: 'Français', forced: false };
const frenchPgs = { id: 's6', kind: 'image', language: 'fre', title: null, forced: false };
const ALL = [englishSdh, english, englishForced, french];
const pick = (tracks, opts) => chooseSubtitle(tracks, opts)?.id ?? null;
const mode = (m, codes = EN) => ({ mode: m, language: codes[0], codes });

test('forced (the default, and with no settings heard): only a file’s forced subtitles for the sound', () => {
  assert.equal(pick(ALL, { audioLanguage: 'eng', subtitles: mode('forced') }), 's4');
  assert.equal(pick(ALL, { audioLanguage: 'eng' }), 's4', 'an older server sends no subtitles: as forced');
  assert.equal(pick(ALL, { audioLanguage: 'fre', subtitles: mode('forced') }), null, 'English parts aren’t for French sound');
  assert.equal(pick([english, french], { audioLanguage: 'eng', subtitles: mode('forced') }), null);
});

test('off: none at all, forced ones too', () => {
  assert.equal(pick(ALL, { audioLanguage: 'eng', subtitles: mode('off') }), null);
});

test('always: the preferred language’s full track, before SDH, never a forced or picture one', () => {
  assert.equal(pick(ALL, { audioLanguage: 'eng', subtitles: mode('always') }), 's2');
  assert.equal(pick([englishSdh, englishForced], { audioLanguage: 'eng', subtitles: mode('always') }), 's3', 'SDH when it’s the only full one');
  assert.equal(pick(ALL, { audioLanguage: 'eng', subtitles: mode('always', FR) }), 's5');
  assert.equal(pick([frenchPgs, englishForced], { audioLanguage: 'eng', subtitles: mode('always', FR) }), 's4',
    'only a picture one in French (it would need converting): the forced ones, as usual');
});

test('foreign: the preferred language only while the sound is in another one', () => {
  assert.equal(pick(ALL, { audioLanguage: 'fre', subtitles: mode('foreign') }), 's2', 'French sound: English subtitles');
  assert.equal(pick(ALL, { audioLanguage: 'eng', subtitles: mode('foreign') }), 's4', 'English sound: only the forced parts');
  assert.equal(pick(ALL, { audioLanguage: 'en-US', subtitles: mode('foreign') }), 's4', 'a region is the same language');
  assert.equal(pick(ALL, { audioLanguage: null, subtitles: mode('foreign') }), null, 'sound in an unknown language: as forced');
  assert.equal(pick(ALL, { audioLanguage: 'und', subtitles: mode('foreign') }), null);
});

test('what the episode before carried comes first, whatever the mode', () => {
  assert.equal(pick(ALL, { audioLanguage: 'eng', carried: { off: true }, subtitles: mode('always') }), null);
  assert.equal(pick(ALL, { audioLanguage: 'eng', carried: { language: 'fre' }, subtitles: mode('off') }), 's5');
  assert.equal(pick(ALL, { audioLanguage: 'eng', carried: { language: 'spa' }, subtitles: mode('always') }), 's2',
    'none in that language here: as the mode says');
});

test('turning them on by hand starts at the preferred language; SDH is told by its title', () => {
  assert.equal(preferredSubtitle(ALL, EN).id, 's2');
  assert.equal(preferredSubtitle(ALL, FR).id, 's5');
  assert.equal(preferredSubtitle(ALL, ['de', 'ger', 'deu']), null);
  assert.equal(preferredSubtitle(ALL, undefined), null);
  assert.ok(isSdh(englishSdh) && isSdh({ title: 'Hearing Impaired' }) && !isSdh(english) && !isSdh({}));
});
