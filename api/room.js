// GET polls the room, POST makes a move. Every change is saved with a version check, so
// simultaneous moves from different phones retry instead of overwriting each other.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBank } from '../lib/bank.js';
import * as room from '../lib/engine.js';
import { openStore } from '../lib/store.js';

const store = openStore();
let questions = null;

function bank() {
  if (!questions) {
    const { questions: parsed, warnings } = parseBank(readFileSync(join(process.cwd(), 'questions.txt'), 'utf8'));
    warnings.forEach((w) => console.warn(`questions.txt: ${w}`));
    questions = parsed;
  }
  return questions;
}

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const NO_STORE = {
  error: 'setup',
  message: 'The room needs its database. In Vercel, open this project, go to Storage, and connect Upstash for Redis.',
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const playerId = (value) => (typeof value === 'string' && /^[\w-]{8,64}$/.test(value) ? value : null);

function hereList(presence, now) {
  if (!presence) return null;
  return Object.keys(presence).filter((id) => room.isHere(presence, id, now));
}

/** Read, change and save the room, retrying if another phone saved in between. */
async function mutate(change) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = Date.now();
    const { state, presence } = await store.load({ presence: true });
    const draft = structuredClone(state);
    const result = change(draft, { now, online: presence, bank: bank() }) ?? {};
    if (!result.changed) return { state, result };
    draft.v = state.v + 1;
    if (await store.save(draft, state.v)) return { state: draft, result };
    await pause(15 + Math.random() * 60);
  }
  throw new Error('The room is busy. Try again.');
}

export async function GET(request) {
  if (!store) return reply(NO_STORE, 503);
  try {
    const url = new URL(request.url);
    const pid = playerId(url.searchParams.get('pid'));
    const known = Number(url.searchParams.get('v') ?? -1);
    const lobby = url.searchParams.get('lobby') === '1';
    const beat = Boolean(pid) && url.searchParams.get('beat') === '1';
    const now = Date.now();
    let { state, presence } = await store.load({ presence: lobby, touch: beat ? { id: pid, at: now } : null });
    if (room.isDue(state, now)) ({ state } = await mutate((s, ctx) => ({ changed: room.tick(s, ctx) })));
    return reply({
      now: Date.now(),
      v: state.v,
      state: state.v === known ? null : room.view(state),
      here: hereList(presence, now),
      store: store.kind,
    });
  } catch (err) {
    console.error(err);
    return reply({ error: 'server', message: 'The room could not be reached.' }, 500);
  }
}

const ACTIONS = {
  join: (s, ctx, me, body) => room.join(s, { id: me, name: body.name }, ctx),
  leave: (s, ctx, me) => room.leave(s, { id: me }, ctx),
  start: (s, ctx, me) => room.start(s, { id: me }, ctx),
  answer: (s, ctx, me, body) => room.answer(s, { id: me, text: body.text }, ctx),
  next: (s, ctx, me) => room.hurry(s, { id: me, kind: 'round' }, ctx),
  continue: (s, ctx, me) => room.hurry(s, { id: me, kind: 'insane' }, ctx),
  lobby: (s, ctx, me) => room.hurry(s, { id: me, kind: 'over' }, ctx),
};

export async function POST(request) {
  if (!store) return reply(NO_STORE, 503);
  try {
    const body = await request.json().catch(() => ({}));
    const me = playerId(body.pid);
    const act = ACTIONS[body.action];
    if (!me || !act) return reply({ error: 'bad-request', message: 'Unknown move.' }, 400);
    if (body.action === 'join') await store.touch(me, Date.now());
    const { state, result } = await mutate((s, ctx) => {
      const ticked = room.tick(s, ctx);
      const outcome = act(s, ctx, me, body) ?? {};
      return { ...outcome, changed: ticked || Boolean(outcome.changed) };
    });
    return reply({ now: Date.now(), v: state.v, state: room.view(state), error: result.error ?? null, verdict: result.verdict ?? null });
  } catch (err) {
    console.error(err);
    return reply({ error: 'server', message: err.message || 'Something went wrong.' }, 500);
  }
}
