import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBank } from '../lib/bank.js';
import * as room from '../lib/engine.js';

const bank = parseBank(readFileSync(new URL('../questions.txt', import.meta.url), 'utf8')).questions;
const R = room.RULES;
const T0 = 1_000_000;

/** A room with these players joined. ctx(now) marks everyone present unless listed as away. */
function setup(names, questions = bank) {
  const s = room.emptyRoom();
  const online = {};
  const away = new Set();
  const ctx = (now) => {
    for (const p of s.roster) if (!away.has(p.id)) online[p.id] = now;
    return { now, online, bank: questions };
  };
  names.forEach((n) => room.join(s, { id: `id-${n}`, name: n }, ctx(T0)));
  return { s, ctx, away, id: (n) => `id-${n}` };
}

/** Advance to the start of the current turn and return the time. */
function toTurn(s, ctx) {
  const t = s.stage.until;
  room.tick(s, ctx(t));
  assert.equal(s.stage.kind, 'turn');
  return t;
}

test('joining checks names', () => {
  const { s, ctx } = setup(['Sar', 'Balaji']);
  assert.equal(s.roster.length, 2);
  assert.notEqual(s.roster[0].color, s.roster[1].color);
  assert.match(room.join(s, { id: 'id-x1', name: '   ' }, ctx(T0)).error, /name/);
  assert.match(room.join(s, { id: 'id-x2', name: 'sar' }, ctx(T0)).error, /already/);
  assert.equal(room.join(s, { id: 'id-Sar', name: 'Sar G' }, ctx(T0)).changed, true);
  assert.equal(s.roster[0].name, 'Sar G');
});

test('a full lap after a miss ends the question and the player who missed starts the next', () => {
  const { s, ctx, id } = setup(['Sar', 'Balaji', 'Pranav', 'Jo']);
  room.start(s, { id: id('Sar') }, ctx(T0));
  assert.equal(s.stage.kind, 'intro');
  let t = toTurn(s, ctx);
  assert.match(room.answer(s, { id: id('Balaji'), text: 'gaga' }, ctx(t)).error, /your turn/);

  assert.equal(room.answer(s, { id: id('Sar'), text: 'lake' }, ctx(t + 1000)).verdict, 'miss');
  assert.equal(s.events.at(-1).type, 'try');
  assert.equal(room.answer(s, { id: id('Sar'), text: 'gaga pit' }, ctx(t + 2000)).verdict, 'hit');
  assert.equal(s.stage.kind, 'resolve');
  assert.deepEqual(s.stage.next, { kind: 'turn', seat: 1 });
  assert.equal(s.seats[0].score, 30);

  t = toTurn(s, ctx);
  assert.equal(s.stage.seat, 1);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.kind, 'resolve');
  assert.equal(s.seats[1].hearts, 1);
  assert.deepEqual(s.round.failed, [1]);

  for (const [name, text] of [['Pranav', 'school'], ['Jo', 'hell'], ['Sar', 'home']]) {
    t = toTurn(s, ctx);
    assert.equal(s.seats[s.stage.seat].name, name);
    assert.equal(room.answer(s, { id: id(name), text }, ctx(t + 500)).verdict, 'hit');
  }
  assert.equal(s.stage.next.kind, 'round');
  assert.equal(s.stage.next.reason, 'back');
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.kind, 'round');
  assert.ok(s.stage.reveal.length > 0);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.qi, 1);
  assert.equal(s.stage.kind, 'intro');
  assert.equal(s.seats[s.stage.seat].name, 'Balaji');
});

test('players who stop polling are skipped', () => {
  const { s, ctx, away, id } = setup(['A', 'B', 'C']);
  room.start(s, { id: id('A') }, ctx(T0));
  const t = toTurn(s, ctx);
  away.add(id('B'));
  const c = ctx(t + 1000);
  c.online[id('B')] = c.now - R.awayMs - 1;
  room.answer(s, { id: id('A'), text: 'school' }, c);
  assert.deepEqual(s.stage.next, { kind: 'turn', seat: 2 });
});

test('an insane answer holds the room, and Continue only works after the reveal', () => {
  const { s, ctx, id } = setup(['A', 'B'], [bank[3]]);
  room.start(s, { id: id('A') }, ctx(T0));
  const t = toTurn(s, ctx);
  room.answer(s, { id: id('A'), text: 'Mr. Odell' }, ctx(t + 800));
  assert.equal(s.stage.kind, 'insane');
  assert.equal(s.events.at(-1).type, 'insane');
  assert.equal(s.seats[0].score, 250);
  assert.equal(room.hurry(s, { id: id('B'), kind: 'insane' }, ctx(t + 1000)).changed, false);
  assert.equal(room.hurry(s, { id: id('B'), kind: 'insane' }, ctx(t + 800 + R.insaneMinMs + 10)).changed, true);
  assert.equal(s.stage.kind, 'turn');
  assert.equal(s.stage.seat, 1);
  assert.equal(room.answer(s, { id: id('B'), text: 'grant' }, ctx(s.stage.from + 100)).verdict, 'used');
  assert.equal(room.answer(s, { id: id('B'), text: 'balaji' }, ctx(s.stage.from + 200)).verdict, 'blocked');
  assert.equal(room.answer(s, { id: id('B'), text: 'Mrs. Garcia' }, ctx(s.stage.from + 300)).verdict, 'hit');
});

test('the last question ends in results, then the room goes back to the lobby', () => {
  const { s, ctx, id } = setup(['A', 'B'], [bank[1]]);
  room.start(s, { id: id('A') }, ctx(T0));
  let t = toTurn(s, ctx);
  room.tick(s, ctx(s.stage.until));
  t = toTurn(s, ctx);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.next.reason, 'back');
  assert.equal(s.stage.next.final, true);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.kind, 'round');
  room.hurry(s, { id: id('A'), kind: 'round' }, ctx(s.stage.from + R.roundMinMs + 1));
  assert.equal(s.phase, 'over');
  room.hurry(s, { id: id('B'), kind: 'over' }, ctx(s.stage.from + 10));
  assert.equal(s.phase, 'lobby');
  assert.equal(s.roster.length, 2);
});

test('losing every heart knocks you out and two players down to one ends the game', () => {
  const { s, ctx, id } = setup(['A', 'B'], bank);
  room.start(s, { id: id('A') }, ctx(T0));
  toTurn(s, ctx);
  room.tick(s, ctx(s.stage.until));
  toTurn(s, ctx);
  room.answer(s, { id: id('B'), text: 'school' }, ctx(s.stage.from + 100));
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.kind, 'intro');
  assert.equal(s.seats[s.stage.seat].name, 'A');
  toTurn(s, ctx);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.seats[0].out, true);
  assert.equal(s.stage.next.reason, 'standing');
  assert.equal(s.stage.next.final, true);
});

test('a room nobody is watching resets itself', () => {
  const { s, ctx, id } = setup(['A', 'B']);
  room.start(s, { id: id('A') }, ctx(T0));
  room.tick(s, ctx(T0 + 10 * 60 * 1000));
  assert.equal(s.phase, 'lobby');
});

test('phones never see the matching internals', () => {
  const { s, ctx, id } = setup(['A']);
  room.start(s, { id: id('A') }, ctx(T0));
  const t = toTurn(s, ctx);
  room.answer(s, { id: id('A'), text: 'gaga' }, ctx(t + 100));
  const v = room.view(s);
  assert.equal(v.round.used, undefined);
  assert.equal(v.round.free, undefined);
  assert.equal(v.round.found.length, 1);
  assert.ok(Array.isArray(v.tiers));
  assert.equal(JSON.stringify(v).includes('Shalav'), false);
});
