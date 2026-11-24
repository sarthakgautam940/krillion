import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseBank } from '../public/js/bank.js';
import * as room from '../public/js/engine.js';

const bank = parseBank(readFileSync(new URL('../public/questions.txt', import.meta.url), 'utf8')).questions;
const R = room.RULES;
const T0 = 1_000_000;

/** A room with these players joined. ctx(now) marks everyone connected unless listed as away. */
function setup(names, questions = bank) {
  const s = room.emptyRoom();
  const online = {};
  const away = new Set();
  const ctx = (now) => {
    for (const p of s.roster) {
      if (away.has(p.id)) delete online[p.id];
      else online[p.id] = now;
    }
    return { now, online, bank: questions };
  };
  for (const n of names) {
    online[`id-${n}`] = T0;
    room.join(s, { id: `id-${n}`, name: n }, ctx(T0));
  }
  return { s, ctx, away, id: (n) => `id-${n}` };
}

const who = (s) => s.seats[s.stage.seat].name;

/** Move to the start of the next turn and return its start time. */
function toTurn(s, ctx) {
  const t = s.stage.until;
  room.tick(s, ctx(t));
  assert.equal(s.stage.kind, 'turn', `expected a turn, got ${s.stage.kind}`);
  return t;
}

function say(s, ctx, name, text) {
  const t = toTurn(s, ctx);
  assert.equal(who(s), name);
  const res = room.answer(s, { id: `id-${name}`, text }, ctx(t + 500));
  assert.equal(res.verdict, 'hit', `${name}: ${text}`);
}

function runOut(s, ctx, name) {
  toTurn(s, ctx);
  assert.equal(who(s), name);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.missed, true);
}

test('names: blank and duplicates are refused, the same phone can rename', () => {
  const { s, ctx } = setup(['Sar', 'Balaji']);
  assert.equal(room.join(s, { id: 'id-x', name: '  ' }, ctx(T0)).error, 'name');
  assert.equal(room.join(s, { id: 'id-y', name: 'sar' }, ctx(T0)).error, 'name');
  assert.equal(room.join(s, { id: 'id-Sar', name: 'Sar G' }, ctx(T0)).changed, true);
  assert.equal(s.roster[0].name, 'Sar G');
});

test('wrong guesses cost nothing, only the timer takes a heart', () => {
  const { s, ctx, id } = setup(['A', 'B']);
  room.start(s, { id: id('A') }, ctx(T0));
  const t = toTurn(s, ctx);
  for (const guess of ['lake', 'asdf', 'zzz', 'nope']) room.answer(s, { id: id('A'), text: guess }, ctx(t + 100));
  assert.equal(s.seats[0].hearts, 2);
  assert.equal(s.stage.kind, 'turn');
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.seats[0].hearts, 1);
});

test('a miss ends the question at the end of that circle, with no extra turns', () => {
  const { s, ctx, id } = setup(['P1', 'P2', 'P3', 'P4']);
  room.start(s, { id: id('P1') }, ctx(T0));
  say(s, ctx, 'P1', 'gaga');
  say(s, ctx, 'P2', 'school');
  runOut(s, ctx, 'P3');
  assert.deepEqual(s.stage.next, { kind: 'turn', seat: 3 }, 'P4 still gets their turn this circle');
  say(s, ctx, 'P4', 'home');
  assert.equal(s.stage.next.kind, 'round', 'P1 and P2 do not go again');
  assert.equal(s.stage.next.reason, 'missed');
  assert.equal(s.seats[2].hearts, 1);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.kind, 'round');
  assert.deepEqual(s.stage.failed, [2]);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.qi, 1);
  assert.equal(who(s), 'P2', 'the next question starts with the next player in line');
});

test('without misses the circles keep going until answers run short', () => {
  const two = [{ ...bank[1] }];
  const { s, ctx, id } = setup(['A', 'B'], two);
  room.start(s, { id: id('A') }, ctx(T0));
  const grades = ['F', 'C', 'B', 'D', 'F-', 'C+', 'B-', 'A-', 'D+', 'B+', 'D-', 'Q'];
  grades.forEach((g, i) => say(s, ctx, i % 2 ? 'B' : 'A', g));
  assert.equal(s.stage.next.kind, 'round');
  assert.equal(s.stage.next.reason, 'low', 'one answer left is not enough for a circle of two');
});

test('out players are skipped and the last one alive wins', () => {
  const { s, ctx, id } = setup(['A', 'B', 'C']);
  room.start(s, { id: id('A') }, ctx(T0));
  runOut(s, ctx, 'A');
  say(s, ctx, 'B', 'gaga');
  say(s, ctx, 'C', 'school');
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  assert.equal(who(s), 'B');
  say(s, ctx, 'B', 'F');
  say(s, ctx, 'C', 'C');
  runOut(s, ctx, 'A');
  assert.equal(s.seats[0].out, true);
  assert.equal(s.stage.next.reason, 'missed');
  assert.equal(s.stage.next.final, false, 'two are still alive');
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  assert.equal(who(s), 'C');
  say(s, ctx, 'C', 'chatgpt');
  runOut(s, ctx, 'B');
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  assert.equal(who(s), 'B', 'A is skipped');
  runOut(s, ctx, 'B');
  assert.equal(s.seats[1].out, true);
  assert.deepEqual(s.stage.next, { kind: 'turn', seat: 2 }, 'C still has to survive their turn in this circle');
  say(s, ctx, 'C', 'Mrs Smith');
  assert.equal(s.stage.next.final, true);
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.phase, 'over');
  const ranked = room.standings(s);
  assert.equal(ranked[0].name, 'C');
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[1].name, 'B');
  assert.equal(ranked[2].name, 'A');
});

test('the last two going out in the same circle is a tie', () => {
  const { s, ctx, id } = setup(['A', 'B'], [bank[0]]);
  room.start(s, { id: id('A') }, ctx(T0));
  s.seats.forEach((p) => {
    p.hearts = 1;
  });
  runOut(s, ctx, 'A');
  assert.deepEqual(s.stage.next, { kind: 'turn', seat: 1 }, 'B still has to survive their turn');
  runOut(s, ctx, 'B');
  assert.equal(s.stage.next.final, true);
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  const ranked = room.standings(s);
  assert.equal(ranked.filter((p) => p.rank === 1).length, 2);
});

test('running out of questions with several alive goes to overtime with a shorter timer', () => {
  const { s, ctx, id } = setup(['A', 'B'], [bank[1]]);
  room.start(s, { id: id('A') }, ctx(T0));
  runOut(s, ctx, 'A');
  say(s, ctx, 'B', 'F');
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.pass, 1);
  assert.equal(s.qi, 0);
  assert.equal(s.turnMs, R.turnMs[1]);
  assert.equal(s.events.some((e) => e.type === 'overtime'), true);
});

test('players whose phones drop are skipped, not punished', () => {
  const { s, ctx, away, id } = setup(['A', 'B', 'C']);
  room.start(s, { id: id('A') }, ctx(T0));
  away.add(id('B'));
  say(s, ctx, 'A', 'gaga');
  assert.deepEqual(s.stage.next, { kind: 'turn', seat: 2 });
  assert.equal(s.seats[1].hearts, 2);
});

test('an insane answer holds the room, and Continue only works after the reveal', () => {
  const { s, ctx, id } = setup(['A', 'B'], [bank[3]]);
  room.start(s, { id: id('A') }, ctx(T0));
  const t = toTurn(s, ctx);
  room.answer(s, { id: id('A'), text: 'Mr. Odell' }, ctx(t + 800));
  assert.equal(s.stage.kind, 'insane');
  assert.equal(room.hurry(s, { id: id('B'), kind: 'insane' }, ctx(t + 1000)).changed, false);
  assert.equal(room.hurry(s, { id: id('B'), kind: 'insane' }, ctx(t + 800 + R.insaneMinMs + 10)).changed, true);
  assert.equal(who(s), 'B');
  assert.equal(room.answer(s, { id: id('B'), text: 'grant' }, ctx(s.stage.from + 100)).verdict, 'used');
  assert.equal(room.answer(s, { id: id('B'), text: 'balaji' }, ctx(s.stage.from + 200)).verdict, 'blocked');
  assert.equal(room.answer(s, { id: id('B'), text: 'Mrs. Garcia' }, ctx(s.stage.from + 300)).verdict, 'hit');
});

test('a new host restarts the current turn on its own clock', () => {
  const { s, ctx, id } = setup(['A', 'B']);
  room.start(s, { id: id('A') }, ctx(T0));
  toTurn(s, ctx);
  const copy = structuredClone(s);
  room.takeOver(copy, ctx(T0 + 500000));
  assert.equal(copy.stage.kind, 'intro');
  assert.equal(copy.stage.seat, 0);
  room.tick(copy, ctx(copy.stage.until));
  assert.equal(copy.stage.kind, 'turn');
  assert.equal(copy.phase, 'game');
});

test('the same name on a new phone takes over that seat when the old phone is gone', () => {
  const { s, ctx, away, id } = setup(['A', 'B']);
  room.start(s, { id: id('A') }, ctx(T0));
  away.add(id('B'));
  ctx(T0 + 1000);
  const res = room.join(s, { id: 'new-phone', name: 'B' }, ctx(T0 + 1000));
  assert.equal(res.changed, true);
  assert.equal(s.seats[1].id, 'new-phone');
});

test('someone gone for good forfeits, so nobody wins by leaving', () => {
  const { s, ctx, away, id } = setup(['A', 'B', 'C']);
  room.start(s, { id: id('A') }, ctx(T0));
  away.add(id('C'));
  say(s, ctx, 'A', 'gaga');
  say(s, ctx, 'B', 'school');
  assert.equal(s.seats[2].out, false, 'a short drop only skips the turn');
  const later = s.stage.until + R.goneMs + 1000;
  room.tick(s, ctx(later - R.goneMs + 2000));
  room.tick(s, ctx(later));
  assert.equal(s.seats[2].out, true);
  assert.equal(s.seats[2].left, true);
});

test('solo: points by rarity, the timer resets after every answer, time running out moves on', () => {
  const { s, ctx, id } = setup(['Me'], [bank[1], bank[3]]);
  room.start(s, { id: id('Me'), solo: true }, ctx(T0));
  assert.equal(s.mode, 'solo');
  let t = toTurn(s, ctx);
  room.answer(s, { id: id('Me'), text: 'A' }, ctx(t + 100));
  room.answer(s, { id: id('Me'), text: 'F' }, ctx(t + 200));
  assert.equal(s.stage.next.kind, 'turn', 'another turn, fresh timer');
  t = toTurn(s, ctx);
  room.answer(s, { id: id('Me'), text: 'B+' }, ctx(t + 100));
  assert.equal(s.seats[0].score, 10 + 85);
  toTurn(s, ctx);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.seats[0].hearts, 2, 'no hearts lost in solo');
  assert.equal(s.stage.next.reason, 'missed');
  assert.equal(s.stage.next.final, false);
  assert.deepEqual(s.log.map((l) => [l.text, l.verdict]), [['A', 'miss'], ['F', 'hit'], ['B+', 'hit']]);
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  t = toTurn(s, ctx);
  room.answer(s, { id: id('Me'), text: 'Odell' }, ctx(t + 100));
  assert.equal(s.seats[0].score, 95 + 250);
  room.tick(s, ctx(s.stage.until));
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.next.final, true, 'last question ends the run');
});

test('solo: alone in the room plays solo, Next skips a question, a cleared board moves on fast, all questions get played', () => {
  const { s, ctx, id } = setup(['Me'], [bank[1], bank[3]]);
  room.start(s, { id: id('Me') }, ctx(T0));
  assert.equal(s.mode, 'solo', 'starting the room alone is solo');
  for (const g of ['F', 'C', 'B', 'D', 'F-', 'C+', 'B-', 'A-', 'D+', 'B+', 'D-', 'Q']) {
    const t = toTurn(s, ctx);
    room.answer(s, { id: id('Me'), text: g }, ctx(t + 100));
  }
  const t = toTurn(s, ctx);
  room.answer(s, { id: id('Me'), text: 'drop' }, ctx(t + 100));
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.stage.kind, 'round');
  assert.equal(s.stage.reason, 'cleared');
  assert.equal(s.stage.until - s.stage.from, R.soloClearedMs);
  room.tick(s, ctx(s.stage.until));
  assert.equal(s.qi, 1);
  toTurn(s, ctx);
  assert.equal(room.skip(s, { id: id('Me') }, ctx(s.stage.from + 100)).changed, true);
  assert.equal(s.stage.kind, 'round');
  assert.equal(s.stage.reason, 'skipped');
  assert.equal(s.stage.final, true);
  assert.equal(s.seats[0].hearts, 2);
});
