// The room: one JSON object that every phone sees. These functions change it in place and
// report whether anything changed. Time is always passed in, so the server is the only clock.
//
// A game is a timeline of stages: intro, turn, resolve (or insane), round recap, results.
// Each stage has `from` and `until` in server time. When a turn resolves, the next stage is
// planned right away in `stage.next`, so every phone can start the next turn on time without
// waiting to hear from the server.
import { TIERS, TIER, judge } from './bank.js';

export const RULES = {
  turnMs: 15000,
  hearts: 2,
  laps: 3,
  introMs: 2800,
  hitMs: 1300,
  bigHitMs: 1800,
  missMs: 2000,
  insaneMs: 8800,
  insaneMinMs: 4000,
  roundMs: 14000,
  roundMinMs: 1500,
  overMs: 180000,
  awayMs: 20000,
  goneMs: 120000,
  graceMs: 400,
  abandonMs: 45000,
  maxSeats: 12,
  maxRoster: 24,
  maxName: 16,
};

export function emptyRoom() {
  return {
    v: 0,
    phase: 'lobby',
    game: 0,
    roster: [],
    seats: [],
    qi: -1,
    qCount: 0,
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

/** A player counts as here unless their phone has gone quiet for a while. */
export function isHere(online, id, now, limit = RULES.awayMs) {
  const seen = Number(online?.[id]);
  return !seen || now - seen < limit;
}

const canPlay = (s, seat, ctx) => {
  const p = s.seats[seat];
  return Boolean(p) && !p.out && isHere(ctx.online, p.id, ctx.now);
};

function nextPlayable(s, from, ctx) {
  const n = s.seats.length;
  for (let i = 1; i <= n; i++) {
    const seat = (from + i) % n;
    if (canPlay(s, seat, ctx)) return seat;
  }
  return from;
}

function standingOver(s) {
  const alive = s.seats.filter((p) => !p.out).length;
  return alive === 0 || (s.seats.length > 1 && alive < 2);
}

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
  if (!clean) return { error: 'Type your name first' };
  const clash = s.roster.find((p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase() && isHere(ctx.online, p.id, ctx.now, RULES.goneMs));
  if (clash) return { error: 'Someone here already has that name' };
  s.roster = s.roster.filter((p) => p.id === id || p.name.toLowerCase() !== clean.toLowerCase());

  const me = s.roster.find((p) => p.id === id);
  if (me) {
    if (me.name === clean) return { changed: false };
    me.name = clean;
    const seat = s.seats.find((p) => p.id === id);
    if (seat) seat.name = clean;
    return { changed: true };
  }
  if (s.roster.length >= RULES.maxRoster) return { error: 'The room is full' };
  const taken = new Set(s.roster.map((p) => p.color));
  let color = 0;
  while (taken.has(color) && color < 7) color += 1;
  if (taken.has(color)) color = s.roster.length % 8;
  s.roster.push({ id, name: clean, color, joinedAt: ctx.now });
  pushEvent(s, ctx.now, { type: 'join', name: clean });
  return { changed: true };
}

export function leave(s, { id }, ctx) {
  const before = s.roster.length;
  s.roster = s.roster.filter((p) => p.id !== id);
  const seat = s.seats.find((p) => p.id === id);
  if (seat && s.phase === 'game' && !seat.out) {
    seat.out = true;
    seat.left = true;
    return { changed: true };
  }
  return { changed: s.roster.length !== before };
}

export function start(s, { id }, ctx) {
  if (s.phase !== 'lobby') return { error: 'A game is already running' };
  if (!member(s, id)) return { error: 'Join the room first' };
  const players = s.roster.filter((p) => p.id === id || isHere(ctx.online, p.id, ctx.now)).slice(0, RULES.maxSeats);
  s.phase = 'game';
  s.game += 1;
  s.qCount = ctx.bank.length;
  s.qi = -1;
  s.seat = 0;
  s.seats = players.map((p) => ({
    id: p.id, name: p.name, color: p.color, hearts: RULES.hearts, maxHearts: RULES.hearts, score: 0, out: false, finds: [],
  }));
  pushEvent(s, ctx.now, { type: 'start' });
  startQuestion(s, ctx.now, ctx);
  return { changed: true };
}

/* ---------- Questions and turns ---------- */

function startQuestion(s, from, ctx) {
  s.qi += 1;
  const q = ctx.bank[s.qi];
  const alive = s.seats.filter((p) => !p.out).length;
  s.question = { prompt: q.prompt, wildcard: Boolean(q.wildcard), total: q.wildcard ? null : q.groups.length };
  s.round = { used: {}, free: [], failed: [], found: [], turns: 0, turnLimit: RULES.laps * Math.max(1, alive) };
  if (!canPlay(s, s.seat, ctx)) s.seat = nextPlayable(s, s.seat, ctx);
  s.stage = { kind: 'intro', from, until: from + RULES.introMs, seat: s.seat };
}

/**
 * Decide what follows the turn that just ended. A question ends when the bank runs dry, after
 * three full laps, or when the turn comes back around to someone who already missed it; that
 * player opens the next question.
 */
function planNext(s, ctx) {
  const r = s.round;
  r.turns += 1;
  const last = s.qi >= s.qCount - 1;
  if (standingOver(s)) return { kind: 'round', reason: 'standing', final: true, seat: s.seat };
  if (s.question.total !== null && r.found.length >= s.question.total) {
    return { kind: 'round', reason: 'cleared', final: last, seat: nextPlayable(s, s.seat, ctx) };
  }
  if (r.turns >= r.turnLimit) return { kind: 'round', reason: 'long', final: last, seat: nextPlayable(s, s.seat, ctx) };
  const n = s.seats.length;
  for (let i = 1; i <= n; i++) {
    const seat = (s.seat + i) % n;
    if (r.failed.includes(seat)) return { kind: 'round', reason: 'back', final: last, seat };
    if (canPlay(s, seat, ctx)) return { kind: 'turn', seat };
  }
  return { kind: 'round', reason: 'standing', final: true, seat: s.seat };
}

export function answer(s, { id, text }, ctx) {
  const st = s.stage;
  if (s.phase !== 'game' || st?.kind !== 'turn' || s.seats[st.seat]?.id !== id) return { error: 'It isn’t your turn' };
  if (ctx.now > st.until + RULES.graceMs) return { error: 'Too late' };
  const raw = String(text ?? '').slice(0, 64);
  const verdict = judge(ctx.bank[s.qi], raw, s.round);
  if (verdict.kind === 'empty') return { changed: false };
  const shown = raw.trim().replace(/\s+/g, ' ').slice(0, 48);

  if (verdict.kind !== 'hit') {
    pushEvent(s, ctx.now, { type: 'try', seat: st.seat, text: shown, verdict: verdict.kind, by: verdict.by ?? null });
    return { changed: true, verdict: verdict.kind };
  }

  const tier = TIER[verdict.group.tier];
  const player = s.seats[st.seat];
  const entry = { id: verdict.group.id, label: verdict.group.label, tier: tier.id, points: tier.points, seat: st.seat };
  player.score += tier.points;
  player.finds.push({ label: entry.label, tier: tier.id });
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
  player.hearts = Math.max(0, player.hearts - 1);
  player.out = player.out || player.hearts === 0;
  if (!s.round.failed.includes(seat)) s.round.failed.push(seat);
  const next = planNext(s, ctx);
  s.stage = { kind: 'resolve', from, until: from + RULES.missMs, seat, next, missed: true };
  pushEvent(s, from, { type: 'timeout', seat, out: player.out });
}

function buildReveal(q, round) {
  const rows = [];
  for (const t of [...TIERS].reverse()) {
    const listed = q.groups.filter((g) => g.tier === t.id);
    const found = round.found.filter((e) => e.tier === t.id).map((e) => ({ label: e.label, seat: e.seat }));
    const foundIds = new Set(round.found.map((e) => e.id));
    const missing = listed.filter((g) => !foundIds.has(g.id)).map((g) => g.label);
    if (!found.length && !missing.length) continue;
    rows.push({ tier: t.id, found, missing: missing.slice(0, 12), more: Math.max(0, missing.length - 12), total: q.wildcard === t.id ? null : listed.length });
  }
  return rows;
}

function endRound(s, plan, from, ctx) {
  s.seat = plan.seat ?? s.seat;
  s.stage = {
    kind: 'round', from, until: from + RULES.roundMs, reason: plan.reason, final: plan.final, seat: s.seat,
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
  s.question = null;
  s.round = null;
  s.stage = null;
  s.roster = s.roster.filter((p) => isHere(ctx.online, p.id, ctx.now, RULES.goneMs));
  pushEvent(s, ctx.now, { type: 'lobby', why });
}

/* ---------- The clock ---------- */

/** Apply one due transition. Returns true when the room changed. */
function step(s, ctx) {
  const st = s.stage;
  if (!st || ctx.now < st.until) return false;
  if (s.phase === 'game' && ctx.now - st.until > RULES.abandonMs) {
    toLobby(s, ctx, 'idle');
    return true;
  }
  switch (st.kind) {
    case 'intro':
      s.stage = { kind: 'turn', from: st.until, until: st.until + RULES.turnMs, seat: st.seat };
      return true;
    case 'turn':
      timeout(s, st.until, ctx);
      return true;
    case 'resolve':
    case 'insane':
      if (st.next.kind === 'turn') {
        s.seat = st.next.seat;
        s.stage = { kind: 'turn', from: st.until, until: st.until + RULES.turnMs, seat: st.next.seat };
      } else {
        endRound(s, st.next, st.until, ctx);
      }
      return true;
    case 'round':
      if (st.final) finish(s, st.until);
      else startQuestion(s, st.until, ctx);
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

export const isDue = (s, now) => Boolean(s.stage && now >= s.stage.until);

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

/** What phones get to see. Internal matching data stays on the server. */
export function view(s) {
  return {
    ...s,
    round: s.round && { found: s.round.found, failed: s.round.failed, turns: s.round.turns },
    rules: { turnMs: RULES.turnMs, introMs: RULES.introMs, insaneMinMs: RULES.insaneMinMs, roundMinMs: RULES.roundMinMs },
    tiers: TIERS,
  };
}
