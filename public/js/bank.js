// Parses questions.txt and judges typed answers against a question.
import { keyOf, squash, distance, prettify } from './text.js';
import { buildBlock, isBlocked, gibberishReason } from './filters.js';

// In the live room rarity is flavor: last one alive wins. Points only count in solo.
export const TIERS = [
  { id: 'plankton', name: 'Plankton', points: 10 },
  { id: 'clever', name: 'Too Clever', points: 15 },
  { id: 'schooler', name: 'Schooler', points: 30 },
  { id: 'rare', name: 'Rare', points: 60 },
  { id: 'deep', name: 'Deep Cut', points: 85 },
  { id: 'krillion', name: 'One in a Krillion', points: 100 },
  { id: 'insane', name: 'Insane', points: 250 },
];
export const TIER = Object.fromEntries(TIERS.map((t, rank) => [t.id, { ...t, rank }]));

const squeeze = (s) => s.toLowerCase().replace(/[^a-z]/g, '');
const TIER_HEADS = {
  plankton: 'plankton', tooclever: 'clever', clever: 'clever', schooler: 'schooler', rare: 'rare',
  deepcut: 'deep', oneinakrillion: 'krillion', oneinkrillion: 'krillion', krillion: 'krillion', insane: 'insane',
};
const WILDCARD_HEADS = new Set(['anythingelse', 'everythingelse', 'anything', 'wildcard']);
const BLOCK_HEADS = new Set(['block', 'blocked', 'ban', 'banned', 'reject']);
const IGNORED_LINE = /^(q\d+\s*[).:]?|answers?\s*:?)$/i;

/** Turn the plain text bank into question objects. Returns { questions, warnings }. */
export function parseBank(text) {
  const questions = [];
  const warnings = [];
  let q = null;

  String(text).split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || IGNORED_LINE.test(line)) return;

    const m = line.match(/^([^:]{1,40}):\s*(.*)$/);
    const head = m ? squeeze(m[1]) : '';
    const isDirective = m && (TIER_HEADS[head] || WILDCARD_HEADS.has(head) || BLOCK_HEADS.has(head));

    if (!isDirective) {
      q = { id: `q${questions.length + 1}`, prompt: line.replace(/\.+$/, ''), groups: [], wildcard: null, block: null };
      questions.push(q);
      return;
    }
    if (!q) {
      warnings.push(`Line ${i + 1}: "${line}" comes before any question.`);
      return;
    }
    const body = m[2].replace(/\.+$/, '');
    if (TIER_HEADS[head]) {
      body.split(',').forEach((chunk) => {
        const aliases = chunk.split('/').map((a) => a.trim()).filter(Boolean);
        if (!aliases.length) return;
        const keys = [...new Set(aliases.map(keyOf).filter(Boolean))];
        q.groups.push({ id: `${q.id}g${q.groups.length}`, label: aliases[0], tier: TIER_HEADS[head], keys });
      });
    } else if (WILDCARD_HEADS.has(head)) {
      const tier = TIER_HEADS[squeeze(body)];
      if (tier) q.wildcard = tier;
      else warnings.push(`Line ${i + 1}: unknown tier "${body}".`);
    } else {
      q.block = buildBlock(body.split(','));
    }
  });

  const ready = questions.filter((qq) => {
    if (qq.groups.length || qq.wildcard) return true;
    warnings.push(`"${qq.prompt}" has no answers, so it was skipped. Check that each tier line has a colon.`);
    return false;
  });
  ready.forEach((qq) => index(qq, warnings));
  return { questions: ready, warnings };
}

function index(q, warnings) {
  q.exact = new Map();
  q.loose = new Map();
  for (const g of q.groups) {
    for (const k of g.keys) {
      const prior = q.exact.get(k);
      if (prior && prior !== g) warnings.push(`"${q.prompt}": "${k}" is listed under both "${prior.label}" and "${g.label}".`);
      else q.exact.set(k, g);
      const s = squash(k);
      if (!q.loose.has(s)) q.loose.set(s, g);
      else if (q.loose.get(s) !== g) q.loose.set(s, null);
    }
  }
}

// How many typos to forgive. Free-form questions are stricter so a different real name is not
// mistaken for a listed one ("Lacey" is not "Lakey").
function typoAllowance(a, b, strict) {
  const lo = Math.min(a.length, b.length);
  if (strict) return lo >= 10 ? 2 : lo >= 6 ? 1 : 0;
  return lo >= 9 ? 2 : lo >= 5 ? 1 : 0;
}

function close(a, b, strict) {
  const limit = typoAllowance(a, b, strict);
  return limit > 0 && distance(a, b, limit) <= limit;
}

function findGroup(q, key) {
  const strict = Boolean(q.wildcard);
  const exact = q.exact.get(key) || q.loose.get(squash(key));
  if (exact) return exact;
  let best = null;
  let bestD = Infinity;
  let tied = false;
  for (const g of q.groups) {
    for (const k of g.keys) {
      const limit = typoAllowance(key, k, strict);
      if (!limit) continue;
      const d = distance(key, k, limit);
      if (d > limit) continue;
      if (d < bestD) {
        best = g;
        bestD = d;
        tied = false;
      } else if (d === bestD && g !== best) {
        tied = true;
      }
    }
  }
  return tied ? null : best;
}

/**
 * Judge an answer. `round.used` is an object mapping group ids to the entry that claimed them
 * and `round.free` lists free-form answers already accepted on an "anything goes" question.
 *   { kind: 'empty' | 'blocked' | 'random' | 'miss' }
 *   { kind: 'used', by }            already said, `by` is the seat that said it
 *   { kind: 'hit', group, key }     new answer; group.tier says how rare it is
 */
export function judge(q, raw, round) {
  const text = String(raw).trim();
  if (!text) return { kind: 'empty' };
  if (isBlocked(text, q.block)) return { kind: 'blocked' };
  const key = keyOf(text);
  if (!key) return { kind: 'miss' };

  const group = findGroup(q, key);
  if (group) {
    const prior = round.used[group.id];
    return prior ? { kind: 'used', by: prior.seat } : { kind: 'hit', group, key };
  }
  if (!q.wildcard) return { kind: 'miss' };

  const why = gibberishReason(text);
  if (why) return { kind: 'random', why };
  const twin = round.free.find((f) => f.key === key || squash(f.key) === squash(key) || close(f.key, key, true));
  if (twin) return { kind: 'used', by: twin.seat };
  const label = prettify(text);
  return { kind: 'hit', key, group: { id: `${q.id}:${key}`, label, tier: q.wildcard, keys: [key], free: true } };
}
