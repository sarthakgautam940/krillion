// Game rules: turns, hearts, scoring and when a question ends. No DOM in here.
import { TIER, judge } from './bank.js';

export const MAX_LAPS = 3;

export class Game {
  constructor({ names, questions, hearts = 2, maxLaps = MAX_LAPS }) {
    this.players = names.map((name, seat) => ({
      seat, name, hearts, maxHearts: hearts, score: 0, out: false, finds: [],
    }));
    this.questions = questions;
    this.maxLaps = maxLaps;
    this.qi = -1;
    this.seat = 0;
    this.round = null;
  }

  get question() { return this.questions[this.qi]; }
  get current() { return this.players[this.seat]; }
  get alive() { return this.players.filter((p) => !p.out); }
  get isLastQuestion() { return this.qi >= this.questions.length - 1; }

  /** Nobody left to play against. A solo game only ends when that player is out. */
  get standingOver() {
    const left = this.alive.length;
    return left === 0 || (this.players.length > 1 && left < 2);
  }

  /** Every listed answer has been said. "Anything goes" questions never run dry. */
  get cleared() {
    return !this.question.wildcard && this.round.used.size >= this.question.groups.length;
  }

  nextAliveAfter(seat) {
    for (let i = 1; i <= this.players.length; i++) {
      const s = (seat + i) % this.players.length;
      if (!this.players[s].out) return s;
    }
    return seat;
  }

  startQuestion() {
    this.qi += 1;
    this.round = {
      used: new Map(),
      free: [],
      failed: new Set(),
      log: [],
      turns: 0,
      turnLimit: this.maxLaps * Math.max(1, this.alive.length),
    };
    if (this.current.out) this.seat = this.nextAliveAfter(this.seat);
    return this.question;
  }

  /** Judge the current player's answer and score it when it is new. */
  submit(text) {
    const verdict = judge(this.question, text, this.round);
    if (verdict.kind !== 'hit') return verdict;
    const player = this.current;
    const tier = TIER[verdict.group.tier];
    const entry = { group: verdict.group, tier, seat: player.seat, text: String(text).trim(), qi: this.qi };
    player.score += tier.points;
    player.finds.push(entry);
    this.round.used.set(verdict.group.id, entry);
    if (verdict.group.free) this.round.free.push({ key: verdict.key, seat: player.seat });
    this.round.log.push(entry);
    return { ...verdict, entry, tier };
  }

  /** The bar ran out: lose a heart and mark this player as having missed this question. */
  timeout() {
    const player = this.current;
    player.hearts = Math.max(0, player.hearts - 1);
    player.out = player.hearts === 0;
    this.round.failed.add(player.seat);
    return player;
  }

  /**
   * Move on after a turn resolves. The question ends when the bank runs dry, after three
   * full laps, or when the turn comes back around to someone who already missed it.
   * That player then opens the next question.
   */
  advance() {
    const r = this.round;
    r.turns += 1;
    if (this.standingOver) return this.endRound('standing');
    if (this.cleared) return this.endRound('cleared', this.nextAliveAfter(this.seat));
    if (r.turns >= r.turnLimit) return this.endRound('long', this.nextAliveAfter(this.seat));
    for (let i = 1; i <= this.players.length; i++) {
      const s = (this.seat + i) % this.players.length;
      if (r.failed.has(s)) return this.endRound('back', s);
      if (!this.players[s].out) {
        this.seat = s;
        return { type: 'turn' };
      }
    }
    return this.endRound('standing');
  }

  skip() {
    return this.endRound('skipped');
  }

  endRound(reason, nextSeat = this.seat) {
    this.seat = nextSeat;
    this.round.reason = reason;
    return { type: 'roundEnd', reason, final: this.standingOver || this.isLastQuestion };
  }

  ranking() {
    return [...this.players].sort((a, b) => b.score - a.score || b.hearts - a.hearts || b.finds.length - a.finds.length);
  }
}
