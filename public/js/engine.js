// The rules. The whole room is one JSON object; the host's phone changes it with these functions
// and broadcasts it. Time is always passed in, so the host is the only clock.
//
// It is you against the timer. Wrong guesses cost nothing. If the timer runs out before you give an
// accepted answer, you lose a heart, and with no hearts left you are out. The last one alive wins.
//
// Turns go round in circles. A question ends at the end of a circle in which anyone ran out of time,
// so nobody gets an extra turn. It also ends when the bank is empty, or when a new circle would start
// with fewer answers left than players. Then the next player in line starts the next question.
import { TIERS, TIER, judge } from './bank.js';

export const RULES = {
  turnMs: [15000, 10000, 7000], // per pass through the questions; overtime gets faster
  hearts: 2,
  maxCircles: 5, // only for anything-goes questions, which never run out of answers
  soloMaxAnswers: 30,
  introMs: 2800,
  hitMs: 1300,
  bigHitMs: 1800,
  missMs: 2000,
  insaneMs: 8800,
  insaneMinMs: 4000,
  roundMs: 12000,
  roundMinMs: 1500,
  overMs: 180000,
  awayMs: 15000,
  goneMs: 45000, // gone this long mid-game and you forfeit, so nobody wins by leaving
  graceMs: 500,
  abandonMs: 45000,
  maxSeats: 12,
  maxRoster: 24,
  maxName: 16,
};

export function emptyRoom() {
  return {
    rid: Math.random().toString(36).slice(2, 10),
    v: 0,
    mode: 'room', // 'room' is the live elimination game, 'solo' plays for points
    log: [],
    phase: 'lobby',
    game: 0,
    roster: [],
    seats: [],
    qi: -1,
    qCount: 0,
    pass: 0,
    played: 0,
    turnMs: RULES.turnMs[0],
    question: null,
    seat: 0,
    round: null,
    stage: null,
    events: [],
    eventId: 0,
  };
}

/* ---------- Helpers ---------- */

function pushEvent(s, t, event) {
  s.eventId += 1;
  s.events.push({ id: s.eventId, t, ...event });
  if (s.events.length > 16) s.events.shift();
}

/** Someone counts as here while their phone is connected to the room. */
export function isHere(online, id, now) {
  const seen = online?.[id];
  return seen != null && now - seen < RULES.awayMs;
}

const canPlay = (s, seat, ctx) => {
  const p = s.seats[seat];
  return Boolean(p) && !p.out && isHere(ctx.online, p.id, ctx.now);
};

/** The next seat after `from` that can take a turn, or null. */
function nextPlayable(s, from, ctx) {
  const n = s.seats.length;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (canPlay(s, seat, ctx)) return seat;
  }
  return null;
}

/** `from` itself if it can play, otherwise the next seat that can. */
const firstFrom = (s, from, ctx) => (canPlay(s, from, ctx) ? from : nextPlayable(s, from, ctx));

const alive = (s) => s.seats.filter((p) => !p.out);

export function cleanName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, RULES.maxName)
    .trim();
}

const member = (s, id) => s.roster.some((p) => p.id === id);

/* ---------- Lobby ---------- */

export function join(s, { id, name }, ctx) {
  const clean = cleanName(name);
  if (!clean) return { error: 'name' };
  const lower = clean.toLowerCase();
  const twin = s.roster.find((p) => p.id !== id && p.name.toLowerCase() === lower);
  if (twin && isHere(ctx.online, twin.id, ctx.now)) return { error: 'name' };

  if (twin) {
    // Same name on a new phone while the old one is gone: take over that player, seat included.
    const seat = s.seats.find((p) => p.id === twin.id);
    if (seat) seat.id = id;
    s.roster = s.roster.filter((p) => p.id !== id);
    twin.id = id;
    twin.name = clean;
    return { changed: true, name: clean };
  }

  const me = s.roster.find((p) => p.id === id);
  if (me) {
    if (me.name === clean) return { changed: false, name: clean };
    me.name = clean;
    const seat = s.seats.find((p) => p.id === id);
    if (seat) seat.name = clean;
    return { changed: true, name: clean };
  }
  if (s.roster.length >= RULES.maxRoster) return { error: 'full' };
  const taken = new Set(s.roster.map((p) => p.color));
  let color = 0;
  while (taken.has(color) && color < 7) color += 1;
  if (taken.has(color)) color = s.roster.length % 8;
  s.roster.push({ id, name: clean, color });
  pushEvent(s, ctx.now, { type: 'join', name: clean });
  return { changed: true, name: clean };
}

export function leave(s, { id }) {
  const before = s.roster.length;
  s.roster = s.roster.filter((p) => p.id !== id);
  const seat = s.seats.find((p) => p.id === id);
  if (seat && s.phase === 'game' && !seat.out) {
    seat.out = true;
    seat.left = true;
    seat.outAt = s.played;
    return { changed: true };
  }
  return { changed: s.roster.length !== before };
}

export function start(s, { id, solo = false }, ctx) {
  if (s.phase !== 'lobby') return { error: 'A game is already running' };
  if (!member(s, id)) return { error: 'Join the room first' };
  const players = solo ? s.roster.filter((p) => p.id === id) : s.roster.filter((p) => p.id === id || isHere(ctx.online, p.id, ctx.now)).slice(0, RULES.maxSeats);
  s.mode = solo ? 'solo' : 'room';
  s.log = [];
  s.phase = 'game';
  s.game += 1;
  s.qCount = ctx.bank.length;
  s.qi = -1;
  s.pass = 0;
  s.played = 0;
  s.seats = players.map((p) => ({ id: p.id, name: p.name, color: p.color, hearts: RULES.hearts, maxHearts: RULES.hearts, out: false, outAt: null, awaySince: null, score: 0, finds: [] }));
  pushEvent(s, ctx.now, { type: 'start' });
  startQuestion(s, ctx.now, ctx, 0);
  return { changed: true };
}

/* ---------- Questions and turns ---------- */

function startQuestion(s, from, ctx, starter) {
  s.qi += 1;
  if (s.qi >= ctx.bank.length) {
    s.qi = 0;
    s.pass += 1;
    pushEvent(s, from, { type: 'overtime', pass: s.pass });
  }
  s.played += 1;
  s.turnMs = RULES.turnMs[Math.min(s.pass, RULES.turnMs.length - 1)];
  const q = ctx.bank[s.qi];
  const first = firstFrom(s, starter, ctx) ?? starter;
  s.question = { prompt: q.prompt, wildcard: Boolean(q.wildcard), total: q.wildcard ? null : q.groups.length };
  s.round = { used: {}, free: [], failed: [], found: [], turns: 0, circle: 0, starter: first };
  s.seat = first;
  s.stage = { kind: 'intro', from, until: from + RULES.introMs, seat: first };
}

/** End the question. The game is over once at most one player is left alive, or in solo after the last question. */
function endPlan(s, reason, ctx) {
  const left = alive(s).length;
  const over = s.mode === 'solo' ? s.qi >= s.qCount - 1 : s.seats.length > 1 ? left <= 1 : left === 0;
  return { kind: 'round', reason, final: over, seat: nextPlayable(s, s.round.starter, ctx) ?? s.round.starter };
}

/** Players who have been gone too long are out. A short drop just skips their turns. */
function sweepGone(s, ctx) {
  for (const p of s.seats) {
    if (p.out) continue;
    if (isHere(ctx.online, p.id, ctx.now)) p.awaySince = null;
    else {
      p.awaySince ??= ctx.now;
      if (ctx.now - p.awaySince > RULES.goneMs) {
        p.out = true;
        p.left = true;
        p.outAt = s.played;
      }
    }
  }
}

/** Who plays after `cur`, or how the question ends if the circle is complete. */
function advanceFrom(s, cur, ctx) {
  sweepGone(s, ctx);
  const r = s.round;
  const n = s.seats.length;
  const remaining = s.question.total === null ? Infinity : s.question.total - r.found.length;
  if (remaining <= 0) return endPlan(s, 'cleared', ctx);
  const pos = (seat) => (seat - r.starter + n) % n;
  for (let i = 1; i < n; i++) {
    const seat = (cur + i) % n;
    if (pos(seat) <= pos(cur)) break; // wrapped around: everyone has had their turn
    if (canPlay(s, seat, ctx)) return { kind: 'turn', seat };
  }
  // The circle is complete.
  const circle = r.circle + 1;
  if (r.failed.length) return endPlan(s, 'missed', ctx);
  if (s.mode === 'solo') {
    if (s.question.total === null && r.turns >= RULES.soloMaxAnswers) return endPlan(s, 'long', ctx);
    return { kind: 'turn', seat: cur, circle };
  }
  const players = s.seats.filter((_, seat) => canPlay(s, seat, ctx)).length;
  const over = s.seats.length > 1 ? alive(s).length <= 1 : alive(s).length === 0;
  if (over) return endPlan(s, 'standing', ctx);
  if (!players) return endPlan(s, 'away', ctx);
  if (remaining < players) return endPlan(s, 'low', ctx);
  if (s.question.total === null && circle >= RULES.maxCircles) return endPlan(s, 'long', ctx); // anything goes: no bank to run dry
  return { kind: 'turn', seat: firstFrom(s, r.starter, ctx), circle };
}

function planNext(s, ctx) {
  s.round.turns += 1;
  return advanceFrom(s, s.stage.seat, ctx);
}

export function answer(s, { id, text }, ctx) {
  const st = s.stage;
  if (s.phase !== 'game' || st?.kind !== 'turn' || s.seats[st.seat]?.id !== id) return { error: 'It isn’t your turn' };
  if (ctx.now > st.until + RULES.graceMs) return { error: 'Too late' };
  const raw = String(text ?? '').slice(0, 64);
  const verdict = judge(ctx.bank[s.qi], raw, s.round);
  if (verdict.kind === 'empty') return { changed: false };
  const shown = raw.trim().replace(/\s+/g, ' ').slice(0, 48);

  if (s.mode === 'solo') s.log.push({ qi: s.qi, text: shown, verdict: verdict.kind, tier: verdict.group?.tier ?? null, label: verdict.group?.label ?? null });

  if (verdict.kind !== 'hit') {
    pushEvent(s, ctx.now, { type: 'try', seat: st.seat, text: shown, verdict: verdict.kind, by: verdict.by ?? null });
    return { changed: true, verdict: verdict.kind };
  }

  const tier = TIER[verdict.group.tier];
  const entry = { id: verdict.group.id, label: verdict.group.label, tier: tier.id, seat: st.seat, points: tier.points };
  s.seats[st.seat].finds.push({ label: entry.label, tier: tier.id });
  if (s.mode === 'solo') s.seats[st.seat].score += tier.points;
  s.round.used[verdict.group.id] = entry;
  s.round.found.push(entry);
  if (verdict.group.free) s.round.free.push({ key: verdict.key, seat: st.seat });

  const insane = tier.id === 'insane';
  const hold = insane ? RULES.insaneMs : tier.rank >= 4 ? RULES.bigHitMs : RULES.hitMs;
  const next = planNext(s, ctx);
  s.stage = { kind: insane ? 'insane' : 'resolve', from: ctx.now, until: ctx.now + hold, seat: st.seat, next };
  pushEvent(s, ctx.now, { type: insane ? 'insane' : 'hit', seat: st.seat, label: entry.label, tier: tier.id, points: tier.points, text: shown });
  return { changed: true, verdict: 'hit' };
}

function timeout(s, from, ctx) {
  const seat = s.stage.seat;
  const player = s.seats[seat];
  if (s.mode !== 'solo') player.hearts = Math.max(0, player.hearts - 1); // solo: time running out just ends the question
  if (!player.out && player.hearts === 0) {
    player.out = true;
    player.outAt = s.played;
  }
  if (!s.round.failed.includes(seat)) s.round.failed.push(seat);
  const next = planNext(s, ctx);
  s.stage = { kind: 'resolve', from, until: from + RULES.missMs, seat, next, missed: true };
  pushEvent(s, from, { type: 'timeout', seat, out: player.out });
}

function buildReveal(q, round) {
  const rows = [];
  const foundIds = new Set(round.found.map((e) => e.id));
  for (const t of [...TIERS].reverse()) {
    const listed = q.groups.filter((g) => g.tier === t.id);
    const found = round.found.filter((e) => e.tier === t.id).map((e) => ({ label: e.label, seat: e.seat }));
    const missing = listed.filter((g) => !foundIds.has(g.id)).map((g) => g.label);
    if (!found.length && !missing.length) continue;
    rows.push({ tier: t.id, found, missing: missing.slice(0, 12), more: Math.max(0, missing.length - 12), total: q.wildcard === t.id ? null : listed.length });
  }
  return rows;
}

function endRound(s, plan, from, ctx) {
  const failed = s.round.failed.slice();
  s.stage = {
    kind: 'round', from, until: from + RULES.roundMs, reason: plan.reason, final: plan.final, seat: plan.seat, failed,
    reveal: buildReveal(ctx.bank[s.qi], s.round),
  };
  pushEvent(s, from, { type: 'round', reason: plan.reason });
}

function finish(s, from) {
  s.phase = 'over';
  s.stage = { kind: 'over', from, until: from + RULES.overMs };
  pushEvent(s, from, { type: 'over' });
}

function toLobby(s, ctx, why) {
  s.phase = 'lobby';
  s.seats = [];
  s.qi = -1;
  s.qCount = 0;
  s.pass = 0;
  s.question = null;
  s.round = null;
  s.stage = null;
  s.roster = s.roster.filter((p) => isHere(ctx.online, p.id, ctx.now));
  pushEvent(s, ctx.now, { type: 'lobby', why });
}

function turnAt(s, seat, from) {
  s.seat = seat;
  s.stage = { kind: 'turn', from, until: from + s.turnMs, seat };
}

/* ---------- The clock ---------- */

function step(s, ctx) {
  const st = s.stage;
  if (s.phase === 'game') sweepGone(s, ctx);
  if (!st || ctx.now < st.until) return false;
  if (s.phase === 'game' && ctx.now - st.until > RULES.abandonMs) {
    toLobby(s, ctx, 'idle');
    return true;
  }
  switch (st.kind) {
    case 'intro': {
      if (st.resume) {
        // A new host took over mid circle: carry on with this player, or skip them if they never came back.
        if (canPlay(s, st.seat, ctx)) turnAt(s, st.seat, st.until);
        else {
          const plan = advanceFrom(s, st.seat, ctx);
          if (plan.kind === 'turn') turnAt(s, plan.seat, st.until);
          else endRound(s, plan, st.until, ctx);
        }
        return true;
      }
      const seat = firstFrom(s, st.seat, ctx);
      if (seat === null) toLobby(s, ctx, 'idle');
      else {
        if (!s.round.turns) s.round.starter = seat;
        turnAt(s, seat, st.until);
      }
      return true;
    }
    case 'turn':
      timeout(s, st.until, ctx);
      return true;
    case 'resolve':
    case 'insane': {
      let plan = st.next;
      // The planned player dropped out in the meantime: work it out again.
      if (plan.kind === 'turn' && !canPlay(s, plan.seat, ctx)) plan = advanceFrom(s, st.seat, ctx);
      if (plan.kind === 'turn') {
        if (plan.circle) s.round.circle = plan.circle;
        turnAt(s, plan.seat, st.until);
      } else endRound(s, plan, st.until, ctx);
      return true;
    }
    case 'round':
      if (st.final) finish(s, st.until);
      else startQuestion(s, st.until, ctx, st.seat);
      return true;
    case 'over':
      toLobby(s, ctx, 'done');
      return true;
    default:
      return false;
  }
}

/** Catch the room up to `ctx.now`. */
export function tick(s, ctx) {
  let changed = false;
  for (let i = 0; i < 64 && step(s, ctx); i++) changed = true;
  return changed;
}

/** Let anyone in the room move past the recap, the insane reveal or the results early. */
export function hurry(s, { id, kind }, ctx) {
  const st = s.stage;
  if (!st || st.kind !== kind || !member(s, id)) return { changed: false };
  const hold = { round: RULES.roundMinMs, insane: RULES.insaneMinMs, over: 0 }[kind] ?? Infinity;
  if (ctx.now < st.from + hold || ctx.now >= st.until) return { changed: false };
  st.until = ctx.now;
  tick(s, ctx);
  return { changed: true };
}

/**
 * A new host picks the room up from the last state it saw. Its clock may differ from the old
 * host's, so whatever was happening restarts on this phone's clock: a turn in progress starts over.
 */
export function takeOver(s, ctx) {
  const st = s.stage;
  if (!st) return;
  const now = ctx.now;
  const grace = 3000; // time for every phone to find the new host before anyone gets skipped
  if (st.kind === 'turn') s.stage = { kind: 'intro', from: now, until: now + grace, seat: st.seat, resume: true };
  else if (st.kind === 'intro') Object.assign(st, { from: now, until: now + grace });
  else if (st.kind === 'round') Object.assign(st, { from: now, until: now + RULES.roundMs });
  else if (st.kind === 'over') Object.assign(st, { from: now, until: now + RULES.overMs });
  else Object.assign(st, { from: now - RULES.insaneMinMs, until: now + grace });
}

/** Test switch: shorter timers so automated games run quickly. */
export function speedUp(k) {
  RULES.turnMs = RULES.turnMs.map((ms) => Math.round(ms * k));
  for (const key of ['introMs', 'hitMs', 'bigHitMs', 'missMs', 'roundMs', 'roundMinMs', 'goneMs']) RULES[key] = Math.round(RULES[key] * k);
}

/** Survivors first, then whoever lasted longest. Players knocked out in the same question tie. */
export function standings(s) {
  const rows = s.seats.map((p, seat) => ({ ...p, seat }));
  rows.sort((a, b) => Number(a.out) - Number(b.out) || b.hearts - a.hearts || (b.outAt ?? 0) - (a.outAt ?? 0));
  let rank = 0;
  rows.forEach((p, i) => {
    const prev = rows[i - 1];
    if (!prev || prev.out !== p.out || prev.hearts !== p.hearts || (prev.outAt ?? 0) !== (p.outAt ?? 0)) rank = i + 1;
    p.rank = rank;
  });
  return rows;
}

export function rules() {
  return { introMs: RULES.introMs, insaneMinMs: RULES.insaneMinMs, roundMinMs: RULES.roundMinMs };
}
