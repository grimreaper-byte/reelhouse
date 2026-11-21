// Content ratings and the limit an admin can give an account (Settings → Users → Content rating).
//
// A rating is whatever TMDB gave for the metadata language's country (or the US one when it had none), or an .nfo
// file's <mpaa>: "PG-13", "12A", "TV-MA", "UK:15", "Rated R", "FSK 16", "MA15+"… Each is read as the youngest age it
// suits, so limits work across rating systems; an account keeps its limit as that age. Ratings can be missing or wrong
// (TMDB's are entered by its users): the Users page says so.
//
// Titles go by their own rating, seasons and episodes by their show's. A title with no rating that can be read counts
// as unrated: hidden from a limited account unless its "Also show titles without a rating" is ticked.
//
// Nothing here touches the database: server/db.js registers rh_rated() for SQL, server/items.js checks single items.

const NAMED = new Map([
  ...['U', 'G', 'TV-Y', 'TV-G', 'ALL', 'L', 'AL', 'TOUS PUBLICS', 'BTL'].map((r) => [r, 0]),
  ...['TV-Y7', 'TV-Y7-FV'].map((r) => [r, 7]),
  ...['PG', 'TV-PG'].map((r) => [r, 8]),
  ['PG-13', 13],
  ['TV-14', 14],
  ['M', 15], // Australia
  ...['R', 'TV-MA'].map((r) => [r, 17]),
  ...['NC-17', 'X', 'XXX', 'R18', 'A'].map((r) => [r, 18]),
]);

const UNRATED = new Set(['', 'NR', 'NOT RATED', 'UNRATED', 'N/A', 'NA', 'NONE', 'UNKNOWN', '-']);

/** The youngest age a rating suits (0–18), or null when there's none or it can't be read. */
export function ageOf(rating) {
  if (rating == null) return null;
  let r = String(rating).trim().toUpperCase().replace(/\s+/g, ' ');
  r = r.replace(/^RATED /, '').replace(/^[A-Z]{2,3} ?: ?/, '').trim(); // "Rated R", "UK:15", "GB: 12A"
  if (UNRATED.has(r)) return null;
  if (NAMED.has(r)) return NAMED.get(r);
  // IMDb's long form, as some media managers write it into .nfo files: "Rated R for strong violence" (the rating is
  // the first word: "R", or "NC-17", whose digits alone would read as 17).
  const first = r.split(' ')[0];
  if (UNRATED.has(first)) return null;
  if (NAMED.has(first)) return NAMED.get(first);
  const n = first.match(/\d{1,2}/) || r.match(/\d{1,2}/);
  if (n) {
    const age = Number(n[0]);
    if (age >= 0 && age <= 21) return Math.min(age, 18);
  }
  return null;
}

/** A user's limit as stored: { maxAge, allowUnrated }, or null for none (admins never have one). */
export function limitOf(user) {
  return user && !user.isAdmin && user.contentLimit ? user.contentLimit : null;
}

/** Whether a title with this rating may be seen under [limit] ({ maxAge, allowUnrated } or null). */
export function allows(limit, rating) {
  if (!limit) return true;
  const age = ageOf(rating);
  if (age == null) return !!limit.allowUnrated;
  return age <= limit.maxAge;
}

/**
 * A condition for SQL that leaves out what [user] may not see, for a query on items as [alias] (a title, season or
 * episode: seasons and episodes go by their show's rating). "1" when they have no limit. The limit's numbers are
 * written into the text (they're whole numbers from the account), so no query's parameters move.
 */
export function ratingSql(user, alias = 'i') {
  const limit = limitOf(user);
  if (!limit) return '1';
  const rating = `(SELECT rr.content_rating FROM items rr WHERE rr.id = COALESCE(${alias}.show_id, ${alias}.id))`;
  return `rh_rated(${rating}, ${Number(limit.maxAge)}, ${limit.allowUnrated ? 1 : 0})`;
}

/** For server/db.js: rh_rated(rating, maxAge, allowUnrated) → 1 or 0. */
export function sqlRated(rating, maxAge, allowUnrated) {
  return allows({ maxAge: Number(maxAge), allowUnrated: !!allowUnrated }, rating) ? 1 : 0;
}

/** A limit from an admin's request: { maxAge: null | 0–18, allowUnrated }. Throws a message for anything else. */
export function validLimit(maxAge, allowUnrated) {
  if (maxAge == null || maxAge === '') return { maxAge: null, allowUnrated: false };
  const n = Number(maxAge);
  if (!Number.isInteger(n) || n < 0 || n > 18) throw new Error('The content rating limit must be an age from 0 to 18, or none');
  return { maxAge: n, allowUnrated: !!allowUnrated };
}

/**
 * The limits an admin can choose, in the ratings of the metadata language's country (en-GB: the BBFC's, en-US: the
 * MPA's and US TV's; elsewhere ages), each with the age kept for it. "No limit" isn't in the list.
 */
export function ratingChoices(country) {
  if (country === 'GB' || country === 'UK' || country === 'IE') {
    return [
      { maxAge: 0, label: 'U' },
      { maxAge: 8, label: 'PG' },
      { maxAge: 12, label: '12A and 12' },
      { maxAge: 15, label: '15' },
    ];
  }
  if (country === 'US') {
    return [
      { maxAge: 0, label: 'G, TV-Y and TV-G' },
      { maxAge: 7, label: 'TV-Y7' },
      { maxAge: 8, label: 'PG and TV-PG' },
      { maxAge: 13, label: 'PG-13' },
      { maxAge: 14, label: 'TV-14' },
      { maxAge: 17, label: 'R and TV-MA' },
    ];
  }
  return [6, 12, 15, 16].map((age) => ({ maxAge: age, label: `Age ${age}` }));
}

/** How a limit reads in the users list ("12A and 12"), for [country]'s choices; an age when it isn't one of them. */
export function limitLabel(limit, country) {
  if (!limit) return null;
  return ratingChoices(country).find((c) => c.maxAge === limit.maxAge)?.label || `Age ${limit.maxAge}`;
}
