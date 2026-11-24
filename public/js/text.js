// Text helpers shared by the answer bank, the filters and the game.

export const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mister', 'missus', 'mz', 'mx', 'dr', 'doctor', 'coach', 'sir',
  'madam', 'madame', 'prof', 'professor', 'senor', 'senora', 'senorita', 'herr', 'frau',
]);

// Words dropped from the front of an answer before comparing: "at the gaga pit" matches "Gaga Pit".
const LEADING_FILLER = new Set(['the', 'a', 'an', 'at', 'in', 'on', 'my', 'his', 'her', ...HONORIFICS]);

const DASHES = /[‐-―−]/g;
const MARKS = /[.'‘’`´]/g;

/** Lowercase and strip accents. */
export function fold(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(DASHES, '-');
}

/** "lakeys" -> "lakey", "streets" -> "street", but "class" stays "class". */
export function stem(w) {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/**
 * Comparison key for an answer. Case, accents, punctuation, spacing, leading filler words,
 * honorifics and plural or possessive endings all collapse to the same key.
 *   "Mr. Jackson's Room" -> "jacksonroom"     "B plus" -> "b+"     "Gaga-ball" -> "gagaball"
 */
export function keyOf(raw) {
  const base = fold(raw).replace(MARKS, '').replace(/(.)\1{2,}/g, '$1$1').replace(/\s+/g, ' ').trim();
  const grade = base.match(/^([a-z]) ?(\+|-|plus|minus)?$/);
  if (grade) {
    const sign = grade[2] === '+' || grade[2] === 'plus' ? '+' : grade[2] ? '-' : '';
    return grade[1] + sign;
  }
  const words = base.replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);
  while (words.length > 1 && LEADING_FILLER.has(words[0])) words.shift();
  return words.map(stem).join('');
}

/** Looser key that ignores doubled letters: "odell" -> "odel", "lakeyy" -> "lakey". */
export function squash(key) {
  return key.replace(/(.)\1+/g, '$1');
}

/** Optimal string alignment distance, giving up early once it passes `max`. */
export function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let older = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, older[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    older = prev;
    prev = cur;
  }
  return prev[b.length];
}

const TITLE_FORMS = { mr: 'Mr.', mrs: 'Mrs.', ms: 'Ms.', dr: 'Dr.', mx: 'Mx.', prof: 'Prof.' };

/** Tidy a typed answer for display: "mrs smith" -> "Mrs. Smith", "ODELL" -> "Odell". */
export function prettify(raw) {
  const words = String(raw).trim().replace(/\s+/g, ' ').slice(0, 40).split(' ');
  return words
    .map((w) => {
      const bare = fold(w).replace(/\./g, '');
      if (TITLE_FORMS[bare]) return TITLE_FORMS[bare];
      if (w.length >= 5 && w === w.toUpperCase()) w = w.toLowerCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}
