// Filters for "anything goes" questions: blocked words and keyboard mash detection.
import { fold, stem, HONORIFICS } from './text.js';

const PROFANITY = (
  'ass asses arse asshole bastard bitch bitches bitchy bollocks boob boobs bullshit cock cocks crap cum cunt ' +
  'damn dammit dick dickhead dicks dildo dipshit douche douchebag dumbass fag faggot fck fcking fk fking fuck ' +
  'fucked fucker fucking goddamn hoe horny jackass jizz motherfucker nigga nigger penis piss pissed porn prick ' +
  'pussy retard retarded sex sexy shit shitty shithead slut smd stfu tit titties twat vagina wank wanker whore wtf'
).split(' ');
// Safe to match inside longer strings ("fuckface", "mrbitch") without hitting real names.
const PROFANITY_PARTS = ['fuck', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'dildo', 'asshole', 'bullshit', 'dipshit', 'motherf'];

const RELIGION = (
  'religion religious christian christianity christ jesus catholic catholicism protestant baptist methodist ' +
  'lutheran evangelical mormon mormonism lds muslim islam islamic allah quran koran mosque hindu hinduism buddha ' +
  'buddhist buddhism sikh sikhism jain jainism jew jewish judaism rabbi atheist atheism agnostic satan satanist ' +
  'satanism pagan paganism wicca wiccan scientology shinto taoism taoist zoroastrian bahai rastafarian god yahweh'
).split(' ');

/** Build a block list from a question's "Block:" line. "profanity" and "religion" expand to full lists. */
export function buildBlock(entries) {
  const block = { tokens: new Set(), parts: [] };
  for (const entry of entries) {
    const k = fold(entry).replace(/[^a-z0-9 ]/g, '').trim();
    if (!k) continue;
    if (['profanity', 'swears', 'swearing', 'cursing', 'cussing'].includes(k)) {
      PROFANITY.forEach((w) => block.tokens.add(stem(w)));
      block.parts.push(...PROFANITY_PARTS);
    } else if (k === 'religion' || k === 'religions') {
      RELIGION.forEach((w) => block.tokens.add(stem(w)));
    } else {
      const flat = k.replace(/ /g, '');
      block.tokens.add(stem(flat));
      if (flat.length >= 5) block.parts.push(flat);
    }
  }
  return block;
}

/** True when the answer uses a blocked word, even spaced out ("s a r") or stretched ("siiiid"). */
export function isBlocked(raw, block) {
  if (!block) return false;
  const base = fold(raw).replace(/[.'\u2018\u2019`]/g, '');
  const forms = new Set([base.replace(/(.)\1{2,}/g, '$1$1'), base.replace(/(.)\1{2,}/g, '$1')]);
  for (const form of forms) {
    const tokens = form.split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.some((t) => block.tokens.has(stem(t)))) return true;
    const flat = form.replace(/[^a-z]/g, '');
    if (block.tokens.has(stem(flat))) return true;
    if (block.parts.some((p) => flat.includes(p))) return true;
  }
  return false;
}

// Letter trigrams seen in about 94,000 US Census first and last names plus a 234,000 word English
// dictionary, packed as a bitset over [a-z_] x [a-z_] x [a-z_], where "_" marks the start or end of a word.
const TRIGRAMS = Uint8Array.from(atob(
  '/r1+///3+3//3/////7f////Pq////t1v9/v//////738u+/1///////7/f/////9/v//9+vAAEz/P//////3////f7///+uN5//' +
  '9//9v5+r//1+/+/rOwAAAP7//x+RZdHIJolFBEnk////EUkSiEiSSlSQRP///x8RBIHIIABGhEE0MggiEUEQ+f//f2SSRAAAIJCZ' +
  'JPXf/rzGZln1///1EUECiAwSAAAAAP77vZ8YBBAAAAD8//8/AkkCkU0SiQiCyP//3yOSIBCZJIX/f7////8bAAAC////jwiCaEQY' +
  'RCKCIPr////IAAEAAEAwIgwisd1czM336v+/zyOCABAZJQAAAAD893t7og+qAAAA+P//f0SSRCKRJBKbZ9H///9HJEmgt9+qEeM2' +
  '/f//f0QURCPSAJoRBNGIIAhEBWH0////kUkCAACAQFYaxf/7/TrbZ+D///9HBAEwMkggAAAA+O/3Y2QXVAEAAPD/////Pr9+9//9' +
  '///v///+7+/3+n6+X/f+vPr/7/+vPw7+9nv9///v//92////+/+////7/QoAAMH////////9/9/v///ur3jz+3//X/vzv/7/7/+v' +
  '/rsDAADg////EUEACAySQEQQAP/////d7/XIIAlEBAH0////EUAAiAgDSEQQRCMAABARAJH/fv9HBAgAAAACEUEQuazX4H6+1///' +
  'Hw4RAICIIAAAAAAgp0uIUQEABAAAwP+//yOTJBLIJIGIIIv+9/s9IkkCt/kW/f/36/+/zyOAABAYBsCIKI5GJkH0N9+r////j0yS' +
  'AAAABLaDNP7/j9XILAv+/7s8IgggkUESCQAAwFe+HyMAAAIAAID///9HJEkkMkkCEUES/P//f0SSBCKTJBARBNH///9HBAEwMkyi' +
  '+31fneim6H97x////x+ZJAEAAAj893H9ux+r//9e///3f0QAACKDJAIAAID/fn9HBAAQAAAA/////u/zam//1////f7/+/+8Pp/u' +
  '93s9p0+j7/x+jPiCYGaf3/////7/7/X////////7/9+rAwES/P//+///3////f7D6+LKNptXBhlwt5+rEWEQ/Or/OwAAAP7//x9A' +
  'AIDIAABHBEDw///fAAAAgAAQQEQQBP773xkAAIAAIAgGBAE0AggCEUEA/f//OwAABAAAABARAICIEgBUEAHw/9f3AAAACAAAAAAA' +
  'AABQABgQAEAAAAD8//s/IskikUkSiAiSyP+//yOSJBgRJIGIfL////s9IggikWkQjBiCaUQQBCKKIPr/7//IJAkAAEAgIozi//1c' +
  'jwyz+v+/2yOSABQZJAEABAT+93s5AwAAAAAA+P//f0yaRCObNP7f/9f/////93s1Mk2mEUMQ/f//f0QQBP///Pr///f//qtG50n0' +
  '////s/leBQCAQEQRRP/7/f7///f///9HBFkkMsggAAAA/e//93yeVAEAAPD////ffq/+//89Ik2C////j0mSSESQRCOCJfr////A' +
  'IAhEDkEwIoiikUkWvUjD6v/////7vwoAAIHIMpr+93M1Mkri///PjwgCQGSQAAAAAPDd7+2IIAACAADg////EUkSiez3+P//3///' +
  '/x+TpMH///9GBFH1////EUES/e/3b0QQRCPCIPLf5fX////HpnkEAAACkUES+f//+/+/3//7fx+RJJHIIIlCZDjxv//fm918BQAA' +
  'gP///////V7Z9/H/f7//9/9/v//r//l+38j361+/vzvqMfzb79X////////9/////7/+///3OwAABP////7///f//7///7+/r8+m' +
  '//9//+/373+/F7/zqA4AAID///9HJEkgMElCEUEC+f//f0yaBCOSJHCb7/X//39HAAEgIgwgEUUQjQiCQEQQBP7//5/ZZ1EAAAhU' +
  'BMH8sp/r93lW/f//fEASACKDBAAAAID/f39CAAAAAAAACAAGDgAAAAAAAAIAAAAAIAAAAAAAAAAAAAAAAyAQBAAAAAAAAAAAAAAA' +
  'AAAAAAAAAgIAAAAAAAAQCAgAAAAAAAAAALCZpzGAAAAAAAAAAAAAAAAAAAAAAAAAAP7//5/ZZ9Xovo3/9//9//////1+3e+7akQQ' +
  'Vv///x8RBIH//7/+d3P1vt+r//1f////f2yfVwEAIDDdx9f//77////9/9//EUkSjQySCEQCQf///X3TpVUAAAD8//8/Ik8ikWkW' +
  'jwiSyP///yOWJBKZJsH//7/+//8/IggCsft+jQiCaGa6RyOCMPr////dNo0CAEAgMoyi//9f/f/3/////yOCJBAZJBEAAAD89/v5' +
  'oh+rAAAA+P//f0SSRCKbLB4RJNX///9HJEkkIk2C//9//f//f0QQBCLSLBKRBNGIIIhEBGH0////sWkSAQCAwGQcxf//vf7/Z/f/' +
  '//9HBAk0MkggAAAA+f//5n2/VQEAAPD//////79/9+n9/9/v///+/+3z+X6+V3PyPPr//+uONI1+9nv1//////9//////3uv3///' +
  '/4oAAIH//7//9//9///vCTwOjCiS6WQVEWezvPrV7+PPvJ4DAADg////AAEAoAgAQAQQAP///x8AAABABAEEAADg///3EEAAiAwC' +
  'YMUTRAIAABARBND///8DAAAAAAAAF0EAuCRjIUAAQLj7HA6RBBCAAAAAAABgNwWKEEEQAAAAwP+//yOSpBLZJOHINKv///o/JgmC' +
  'kUkSiAjCyH+//wGAADCZZtT9fq9GBBH0P9/r//9+j0iSKAAABCKCIHbb79XKIIt67zsYIgAAkUECAAAAwH+/iyOSAAIAAAD/Xp9H' +
  'JEkkMkkiEEEC+Mr7aEQSBAKQIBCRBJH/fF8CAAAAIgAAEUEAjQgCQAYAAP57PR6ZJAEAAAhEBEGgshoLk3kS3cA3IUAAACKCAAAA' +
  'AMD//i8GAAEAAAAA/v///2iyaGSbxrfyPP7f7/+YJIln50k0Ik6jff0ejgACQGSbB//7/3rZ79Hudv/+//8/Mt2jAAAQ+O/36H//' +
  '1yubPP7f7+KIIAhEBgkgIgigEUAQyEqKOAAAAP7//x8RJJFIJAhFBEn8///vEQAQiEySQEQVRP77/w8AAICIJIlGBEE0IwgCEUEA' +
  '/e//f0QQAAAAIBARBIGCIARGJhnwv9/PEUEAiAgiAAAAALx7nTyVBlUAAAD8//8/c0nmnXl+j/yy+////yOWZLq7Z/eINb/+//+/' +
  'Mgyqkft2jVyC6ne6VquPsvr////YNY9GBEEwMgrm//9/7/yy+/+/7yeSJJqZJ/GIKIh+5f94O8+uAAAAAA=='
), (c) => c.charCodeAt(0));

const slot = (c) => (c === '_' ? 26 : c.charCodeAt(0) - 97);
const known = (t) => {
  const n = slot(t[0]) * 729 + slot(t[1]) * 27 + slot(t[2]);
  return (TRIGRAMS[n >> 3] >> (n & 7)) & 1;
};

const KEY_RUNS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].flatMap((row) => {
  const runs = [];
  for (let i = 0; i + 5 <= row.length; i++) {
    const run = row.slice(i, i + 5);
    runs.push(run, [...run].reverse().join(''));
  }
  return runs;
});

// Tuned so that none of the census names are rejected while typical mashing is.
function looksRandom(w) {
  if (!/[aeiouy]/.test(w)) return true;
  if (w.length >= 5 && /^[aeiou]+$/.test(w)) return true;
  if (w.length >= 6 && /(..+?)\1\1/.test(w)) return true;
  if (/[^aeiouy]{7,}/.test(w)) return true;
  if (KEY_RUNS.some((run) => w.includes(run))) return true;
  const padded = `_${w}_`;
  const total = padded.length - 2;
  let unseen = 0;
  for (let i = 0; i < total; i++) if (!known(padded.slice(i, i + 3))) unseen++;
  if (w.length >= 8 && new Set(w).size / w.length <= 0.4 && unseen >= 1) return true;
  return unseen >= 3 && unseen / total >= 0.3;
}

/** Why an answer does not look like a real name or phrase, or null when it is fine. */
export function gibberishReason(raw) {
  const base = fold(raw).replace(/[.'\u2018\u2019`]/g, '').replace(/(.)\1{2,}/g, '$1$1');
  if (!/[a-z]/.test(base)) return 'noletters';
  let letters = 0;
  let titled = false;
  for (const t of base.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (/\d/.test(t)) {
      if (/^\d{1,2}(st|nd|rd|th)$/.test(t)) continue;
      return 'digits';
    }
    if (HONORIFICS.has(t)) {
      titled = true;
      continue;
    }
    letters += t.length;
    if (t.length >= 2 && /^(.)\1+$/.test(t)) return 'random';
    if (t.length >= 3 && !/[aeiouy]/.test(t)) return 'random';
    if (t.length >= 4 && looksRandom(t)) return 'random';
  }
  if (letters < 2 && !titled) return 'short';
  return null;
}
