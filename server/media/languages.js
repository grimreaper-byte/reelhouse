// The languages Settings → Languages offers for the sound track and subtitles players start with, and every code a
// file may use for each: ffprobe gives a track's tag as the file has it (mostly ISO 639-2, "eng", "fre" or "fra"),
// subtitle files next to a video are named with 639-1 or 639-2 ("Film.fr.srt"), and Media3 turns codes into 639-1.
// The server sends players all the codes of the preferred language, so they only check whether a track's is one.

// [id (639-1, or 639-2 when there's none), …the other codes for it]
const TABLE = [
  ['af', 'afr'], ['am', 'amh'], ['ar', 'ara'], ['az', 'aze'], ['be', 'bel'], ['bg', 'bul'], ['bn', 'ben'],
  ['bs', 'bos'], ['ca', 'cat'], ['cs', 'cze', 'ces'], ['cy', 'wel', 'cym'], ['da', 'dan'], ['de', 'ger', 'deu'],
  ['el', 'gre', 'ell'], ['en', 'eng'], ['eo', 'epo'], ['es', 'spa'], ['et', 'est'], ['eu', 'baq', 'eus'],
  ['fa', 'per', 'fas'], ['fi', 'fin'], ['fil', 'tl', 'tgl'], ['fr', 'fre', 'fra'], ['ga', 'gle'], ['gl', 'glg'],
  ['gu', 'guj'], ['he', 'heb', 'iw'], ['hi', 'hin'], ['hr', 'hrv', 'scr'], ['hu', 'hun'], ['hy', 'arm', 'hye'],
  ['id', 'ind', 'in'], ['is', 'ice', 'isl'], ['it', 'ita'], ['ja', 'jpn'], ['ka', 'geo', 'kat'], ['kk', 'kaz'],
  ['km', 'khm'], ['kn', 'kan'], ['ko', 'kor'], ['la', 'lat'], ['lo', 'lao'], ['lt', 'lit'], ['lv', 'lav'],
  ['mk', 'mac', 'mkd'], ['ml', 'mal'], ['mn', 'mon'], ['mr', 'mar'], ['ms', 'may', 'msa'], ['my', 'bur', 'mya'],
  ['ne', 'nep'], ['nl', 'dut', 'nld'], ['no', 'nor', 'nb', 'nob', 'nn', 'nno'], ['pa', 'pan'], ['pl', 'pol'],
  ['pt', 'por'], ['ro', 'rum', 'ron'], ['ru', 'rus'], ['si', 'sin'], ['sk', 'slo', 'slk'], ['sl', 'slv'],
  ['sq', 'alb', 'sqi'], ['sr', 'srp', 'scc'], ['sv', 'swe'], ['sw', 'swa'], ['ta', 'tam'], ['te', 'tel'],
  ['th', 'tha'], ['tr', 'tur'], ['uk', 'ukr'], ['ur', 'urd'], ['uz', 'uzb'], ['vi', 'vie'],
  ['yue'], ['zh', 'chi', 'zho', 'cmn'],
];

/** The languages to choose from (their ids). */
export const LANGUAGES = TABLE.map((codes) => codes[0]);

const byCode = new Map(TABLE.flatMap((codes) => codes.map((c) => [c, codes])));

/** A track's language tag as it can be looked up: lower case, without a region ("en-US" → "en"). */
export const plainLanguage = (code) => String(code || '').trim().toLowerCase().split(/[-_]/)[0];

/** Every code for the language with this id (or any of its codes), the id first; [] for none or an unknown one. */
export function codesFor(language) {
  return [...(byCode.get(plainLanguage(language)) || [])];
}

/** Whether a track's language tag is one of [codes] (as codesFor gives them). */
export const inLanguage = (code, codes) => !!code && codes.includes(plainLanguage(code));

/** The language of a metadata language and region ("en-US" → "en"), or English when it isn't in the list. */
export function languageOfRegion(tag) {
  return codesFor(tag)[0] || 'en';
}
