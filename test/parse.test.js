import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMovieName, parseEpisodeName, parseSeasonFolder, parseShowFolder, sortTitle, parseSubtitleName, isSampleFile,
} from '../server/scanner/parse.js';

test('movie names', () => {
  const cases = [
    ['The Matrix (1999)', 'The Matrix', 1999],
    ['The.Matrix.1999.1080p.BluRay.x264-GROUP', 'The Matrix', 1999],
    ['Blade Runner 2049 (2017)', 'Blade Runner 2049', 2017],
    ['1917 (2019)', '1917', 2019],
    ['2001 A Space Odyssey (1968)', '2001 A Space Odyssey', 1968],
    ['Heat [1995] [1080p]', 'Heat', 1995],
    ['Amélie (2001)', 'Amélie', 2001],
    ['Some.Movie.Without.Year.1080p.WEB-DL', 'Some Movie Without Year', null],
    ['Plain Title', 'Plain Title', null],
    ['Spider-Man - Into the Spider-Verse (2018)', 'Spider-Man - Into the Spider-Verse', 2018],
  ];
  for (const [input, title, year] of cases) {
    const r = parseMovieName(input);
    assert.equal(r.title, title, input);
    assert.equal(r.year, year, input);
  }
});

test('movie ids in names', () => {
  assert.deepEqual(parseMovieName('Heat (1995) {tmdb-949}'), { title: 'Heat', year: 1995, tmdbId: 949 });
  assert.equal(parseMovieName('Heat (1995) [imdbid-tt0113277]').imdbId, 'tt0113277');
});

test('episode names', () => {
  const cases = [
    ['Show - S01E02 - Pilot.mkv', { season: 1, episode: 2, episodeEnd: null, showTitle: 'Show', episodeTitle: 'Pilot' }],
    ['Show.Name.S02E10.720p.HDTV.x264.mkv', { season: 2, episode: 10, showTitle: 'Show Name', episodeTitle: null }],
    ['show.name.s03e04e05.mkv', { season: 3, episode: 4, episodeEnd: 5 }],
    ['Show - S01E01-E02 - Two Parter.mkv', { season: 1, episode: 1, episodeEnd: 2, episodeTitle: 'Two Parter' }],
    ['Show 1x05 Title.avi', { season: 1, episode: 5 }],
    ['Episode 7.mp4', { season: null, episode: 7 }],
    ['[Group] Anime Show - 12 [1080p].mkv', { season: null, episode: 12, showTitle: 'Anime Show' }],
    ['03 - The Third One.mkv', { season: null, episode: 3, episodeTitle: 'The Third One' }],
    ['The Daily Show 2024-03-15.mkv', { airDate: '2024-03-15', showTitle: 'The Daily Show' }],
    ['Show - S01E02 - 1080p.mkv', { season: 1, episode: 2, episodeEnd: null }],
  ];
  for (const [input, expected] of cases) {
    const r = parseEpisodeName(input);
    for (const [k, v] of Object.entries(expected)) assert.equal(r[k], v, `${input}: ${k}`);
  }
});

test('season folders', () => {
  assert.equal(parseSeasonFolder('Season 01'), 1);
  assert.equal(parseSeasonFolder('Season 12'), 12);
  assert.equal(parseSeasonFolder('S03'), 3);
  assert.equal(parseSeasonFolder('Specials'), 0);
  assert.equal(parseSeasonFolder('Staffel 2'), 2);
  assert.equal(parseSeasonFolder('Extras'), null);
});

test('show folders', () => {
  assert.deepEqual(parseShowFolder('Doctor Who (2005)'), { title: 'Doctor Who', year: 2005 });
  assert.deepEqual(parseShowFolder('The Office (US) (2005) [tmdbid-2316]'), { title: 'The Office (US)', year: 2005, tmdbId: 2316 });
  assert.equal(parseShowFolder('Breaking Bad').title, 'Breaking Bad');
});

test('a recorded new episode\'s "New_ " (Tvheadend\'s "New: ") is left off the show\'s name', () => {
  assert.equal(parseShowFolder('New_ Married at First Sight UK').title, 'Married at First Sight UK');
  assert.equal(parseShowFolder('New: Mock The Week').title, 'Mock The Week');
  assert.equal(parseShowFolder('NEW_ The Jury').title, 'The Jury');
  assert.equal(parseShowFolder('New_-Mock-The-Week').title, 'Mock-The-Week'); // Tvheadend set to replace spaces
  for (const kept of ['New Girl', 'New_Girl', 'New Tricks', 'New Amsterdam (2018)', 'New_ ']) {
    assert.match(parseShowFolder(kept).title, /^New/, kept);
  }
  const ep = parseEpisodeName('New_ Married at First Sight UK - S10E25 - Brand new series.ts');
  assert.deepEqual([ep.showTitle, ep.season, ep.episode, ep.episodeTitle], ['Married at First Sight UK', 10, 25, 'Brand new series']);
  assert.deepEqual([parseEpisodeName('New_ Mock The Week - S02E08 -.ts').showTitle, parseEpisodeName('New_ Mock The Week - S02E08 -.ts').episodeTitle],
    ['Mock The Week', null]);
  assert.equal(parseEpisodeName('New Girl - S01E01 - Pilot.mkv').showTitle, 'New Girl');
});

test('sort titles drop leading articles', () => {
  assert.equal(sortTitle('The Matrix'), 'matrix');
  assert.equal(sortTitle('A Quiet Place'), 'quiet place');
  assert.equal(sortTitle('Alien: Romulus'), 'alien romulus');
});

test('subtitle sidecars', () => {
  assert.deepEqual(parseSubtitleName('Movie (2020).en.forced.srt', 'Movie (2020)'), { language: 'en', forced: true, sdh: false });
  assert.deepEqual(parseSubtitleName('Movie (2020).eng.sdh.srt', 'Movie (2020)'), { language: 'eng', forced: false, sdh: true });
  assert.deepEqual(parseSubtitleName('Movie (2020).srt', 'Movie (2020)'), { language: null, forced: false, sdh: false });
});

test('sample files', () => {
  assert.equal(isSampleFile('movie-sample.mkv', 50e6), true);
  assert.equal(isSampleFile('Samples and Stories.mkv', 2e9), false);
});
