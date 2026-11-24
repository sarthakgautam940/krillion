// Screens, timer, animation and input. Rules live in game.js, matching in bank.js.
import { parseBank, TIERS } from './bank.js';
import { Game } from './game.js';
import { Sound } from './audio.js';
import { FX, shake, reducedMotion } from './fx.js';
import { prettify } from './text.js';

const MAX_PLAYERS = 8;
const KEYS = { players: 'lorecheck.players', settings: 'lorecheck.settings', sound: 'lorecheck.sound' };

const $ = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage can be unavailable in private windows */
    }
  },
};
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const tierColor = (id) => cssVar(`--tier-${id}`);

const HEART = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const settings = { timer: 15, hearts: 2, order: 'order', ...store.get(KEYS.settings, {}) };
let names = store.get(KEYS.players, ['', '', '', '']);
if (!Array.isArray(names) || !names.length) names = ['', '', '', ''];

const sound = new Sound(store.get(KEYS.sound, true));
const fx = new FX($('fx'));

let bank = [];
let game = null;
let phase = 'setup'; // setup | intro | turn | resolve | insane | round | over
let paused = false;
let epoch = 0;
let deferred = [];
let finishInsane = null;
const timer = { dur: 15000, start: 0, left: 0, raf: 0, lastTick: null };
const shownScore = new Map();

function setPhase(next) {
  phase = next;
  $('play').dataset.phase = next;
}

/** setTimeout that waits while paused and is dropped when the game is skipped or ended. */
function later(fn, ms) {
  const mine = epoch;
  setTimeout(() => {
    if (mine !== epoch) return;
    if (paused) deferred.push(fn);
    else fn();
  }, ms);
}

/* ---------- Setup ---------- */

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.length === 1 ? parts[0][0].toUpperCase() : (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatar(seat, label, size) {
  const node = make('span', size ? `avatar avatar--${size}` : 'avatar', label);
  node.style.setProperty('--c', `var(--p${(seat % MAX_PLAYERS) + 1})`);
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function saveNames() {
  store.set(KEYS.players, names);
}

function renderRoster() {
  const rows = names.map((name, i) => {
    const li = make('li');
    const input = make('input');
    Object.assign(input, { type: 'text', id: `player-${i}`, maxLength: 16, value: name, placeholder: `Player ${i + 1}`, autocomplete: 'off', spellcheck: false });
    input.setAttribute('aria-label', `Player ${i + 1} name`);
    input.addEventListener('input', () => {
      names[i] = input.value;
      saveNames();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = $(`player-${i + 1}`);
      if (next) next.focus();
      else startGame();
    });
    const remove = make('button', 'remove');
    remove.type = 'button';
    remove.innerHTML = CLOSE;
    remove.setAttribute('aria-label', `Remove player ${i + 1}`);
    remove.disabled = names.length <= 1;
    remove.addEventListener('click', () => {
      names.splice(i, 1);
      saveNames();
      renderRoster();
    });
    li.append(avatar(i, String(i + 1)), input, remove);
    return li;
  });
  $('roster').replaceChildren(...rows);
  $('playerCount').textContent = `${names.length} of ${MAX_PLAYERS}`;
  $('addPlayer').disabled = names.length >= MAX_PLAYERS;
}

function initSettings() {
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.setting;
    const sync = () => {
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === String(settings[key]))));
    };
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[key] = key === 'order' ? b.dataset.value : Number(b.dataset.value);
      store.set(KEYS.settings, settings);
      sync();
    });
    sync();
  });

  $('ladder').replaceChildren(
    ...TIERS.filter((t) => t.id !== 'insane').map((t) => {
      const li = make('li');
      const pill = make('span', 'pill', t.name);
      pill.dataset.tier = t.id;
      li.append(pill, make('span', 'ladder__pts', String(t.points)));
      return li;
    }),
  );
}

async function loadBank() {
  const status = $('bankStatus');
  try {
    const res = await fetch('questions.txt', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { questions, warnings } = parseBank(await res.text());
    warnings.forEach((w) => console.warn(`questions.txt: ${w}`));
    bank = questions;
    status.textContent = `${questions.length} question${questions.length === 1 ? '' : 's'} ready`;
    $('startBtn').disabled = !questions.length;
  } catch (err) {
    console.error(err);
    status.textContent = 'Could not load questions.txt. Refresh to try again.';
    status.classList.add('is-error');
  }
}

function show(screen) {
  ['setup', 'play', 'over'].forEach((id) => {
    $(id).hidden = id !== screen;
  });
  window.scrollTo(0, 0);
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function startGame() {
  if (!bank.length) return;
  sound.unlock();
  const roster = names.map((n, i) => n.trim() || `Player ${i + 1}`);
  const questions = settings.order === 'shuffle' ? shuffle([...bank]) : [...bank];
  game = new Game({ names: roster, questions, hearts: settings.hearts });
  epoch += 1;
  deferred = [];
  paused = false;
  fx.clear();
  shownScore.clear();
  show('play');
  buildSeats();
  nextQuestion();
}

/* ---------- Players ---------- */

const seatEl = (seat) => $('players').children[seat];

function buildSeats() {
  const seats = game.players.map((p) => {
    const node = make('div', 'seat');
    const row = make('div', 'seat__row');
    row.append(make('span', 'hearts'), make('span', 'seat__tag'), make('span', 'seat__score', '0'));
    node.append(avatar(p.seat, initials(p.name), 'lg'), make('span', 'seat__name', p.name), row, make('span', 'seat__bar'));
    shownScore.set(p.seat, 0);
    return node;
  });
  $('players').replaceChildren(...seats);
  updateSeats();
}

function heartIcon(full) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', full ? 'heart heart--full' : 'heart heart--empty');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', HEART);
  svg.append(path);
  return svg;
}

function updateSeats() {
  const live = ['intro', 'turn', 'resolve', 'insane'].includes(phase);
  for (const p of game.players) {
    const node = seatEl(p.seat);
    const missed = Boolean(game.round && game.round.failed.has(p.seat));
    node.classList.toggle('is-active', live && p.seat === game.seat && !p.out);
    node.classList.toggle('is-out', p.out);
    node.querySelector('.hearts').replaceChildren(...Array.from({ length: p.maxHearts }, (_, i) => heartIcon(i < p.hearts)));
    node.querySelector('.hearts').setAttribute('aria-label', `${p.hearts} of ${p.maxHearts} hearts`);
    node.querySelector('.seat__tag').textContent = p.out ? 'Out' : missed ? 'Missed' : '';
  }
}

function bumpScore(seat, tierId) {
  const node = seatEl(seat).querySelector('.seat__score');
  const from = shownScore.get(seat) || 0;
  const to = game.players[seat].score;
  shownScore.set(seat, to);
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 700);
    node.textContent = String(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  node.animate([{ transform: 'scale(1.4)', color: tierColor(tierId) }, { transform: 'scale(1)' }], { duration: 600, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

function breakHeart(player) {
  const hearts = seatEl(player.seat).querySelectorAll('.heart');
  const lost = hearts[player.hearts];
  if (!lost) return;
  const r = lost.getBoundingClientRect();
  fx.burst(r.left + r.width / 2, r.top + r.height / 2, { colors: [cssVar('--heart'), cssVar('--fg')], count: 14, speed: 4, size: [3, 7], life: [25, 45] });
  const ghost = lost.cloneNode(true);
  Object.assign(ghost.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: 50, pointerEvents: 'none' });
  document.body.append(ghost);
  ghost
    .animate(
      [
        { transform: 'scale(1) rotate(0)', opacity: 1 },
        { transform: 'scale(2.2) rotate(-12deg)', opacity: 1, offset: 0.3 },
        { transform: 'translateY(40px) scale(1.4) rotate(25deg)', opacity: 0 },
      ],
      { duration: 700, easing: 'cubic-bezier(.3,.6,.4,1)' },
    )
    .finished.then(() => ghost.remove(), () => ghost.remove());
}

/* ---------- Timer ---------- */

function setTimerVisual(ratio, state) {
  $('timerFill').style.width = `${(ratio * 100).toFixed(2)}%`;
  $('play').dataset.timer = state;
  const bar = $('players').querySelector('.seat.is-active .seat__bar');
  if (bar) bar.style.width = `${(ratio * 100).toFixed(2)}%`;
}

function startTimer(ms) {
  cancelAnimationFrame(timer.raf);
  Object.assign(timer, { dur: ms, left: ms, start: performance.now(), lastTick: null });
  timer.raf = requestAnimationFrame(tickTimer);
}

function stopTimer() {
  cancelAnimationFrame(timer.raf);
}

function tickTimer(now) {
  if (phase !== 'turn' || paused) return;
  const left = Math.max(0, timer.dur - (now - timer.start));
  const ratio = left / timer.dur;
  timer.left = left;
  setTimerVisual(ratio, ratio > 0.5 ? 'blue' : ratio > 0.25 ? 'yellow' : 'red');
  $('timerNum').textContent = String(Math.ceil(left / 1000));
  const mark = Math.ceil(left / (left < 2000 ? 500 : 1000));
  if (ratio <= 0.25 && left > 0 && mark !== timer.lastTick) {
    timer.lastTick = mark;
    sound.tick(left < 2000);
  }
  if (left <= 0) {
    onTimeout();
    return;
  }
  timer.raf = requestAnimationFrame(tickTimer);
}

/* ---------- Turns ---------- */

function setFeedback(text, tone) {
  const node = $('feedback');
  node.textContent = text;
  node.className = tone ? `feedback is-${tone}` : 'feedback';
}

function nextQuestion() {
  const q = game.startQuestion();
  setPhase('intro');
  $('progress').textContent = `Question ${game.qi + 1} of ${game.questions.length}`;
  $('board').replaceChildren();
  $('answer').value = '';
  setFeedback('');
  $('turnName').textContent = '';
  $('turnAvatar').hidden = true;
  setTimerVisual(1, 'idle');
  $('timerNum').textContent = String(settings.timer);
  const title = $('question');
  title.textContent = q.prompt;
  title.animate(
    [{ opacity: 0, transform: 'translateY(18px) scale(.97)' }, { opacity: 1, transform: 'none' }],
    { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  updateSeats();
  later(beginTurn, 1100);
}

function beginTurn() {
  setPhase('turn');
  const p = game.current;
  const name = $('turnName');
  name.textContent = `${p.name}’s turn`;
  const av = $('turnAvatar');
  av.hidden = false;
  av.textContent = initials(p.name);
  av.style.setProperty('--c', `var(--p${(p.seat % MAX_PLAYERS) + 1})`);
  $('turn').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
  const input = $('answer');
  input.value = '';
  $('answerForm').classList.remove('is-wrong');
  setFeedback('');
  updateSeats();
  input.focus({ preventScroll: true });
  sound.turn();
  startTimer(settings.timer * 1000);
}

function wrong(message) {
  const form = $('answerForm');
  form.classList.remove('is-shake');
  void form.offsetWidth;
  form.classList.add('is-shake', 'is-wrong');
  setFeedback(message, 'error');
  sound.wrong();
  $('answer').select();
}

function stamp(label, points, tierId) {
  const node = $('stamp');
  node.dataset.tier = tierId;
  node.replaceChildren(make('span', null, label));
  if (points) node.append(make('span', 'stamp__pts', `+${points}`));
  node.getAnimations().forEach((a) => a.cancel());
  node.animate(
    [
      { opacity: 0, transform: 'scale(1.8) rotate(-6deg)' },
      { opacity: 1, transform: 'scale(.94) rotate(1deg)', offset: 0.2 },
      { opacity: 1, transform: 'scale(1) rotate(0deg)', offset: 0.3 },
      { opacity: 1, transform: 'translateY(0)', offset: 0.78 },
      { opacity: 0, transform: 'translateY(-16px)' },
    ],
    { duration: 1150, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
}

function addCard(entry, fresh) {
  const p = game.players[entry.seat];
  const li = make('li', 'card');
  li.dataset.tier = entry.tier.id;
  li.title = `${p.name} found this`;
  const top = make('div', 'card__top');
  top.append(make('span', 'card__label', entry.group.label), make('span', 'card__pts', `+${entry.tier.points}`));
  const meta = make('div', 'card__meta');
  meta.append(avatar(p.seat, initials(p.name), 'xs'), make('span', 'card__tier', entry.tier.name));
  li.append(top, meta);
  $('board').prepend(li);
  if (fresh) {
    li.animate([{ opacity: 0, transform: 'translateY(-10px) scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 360, easing: 'cubic-bezier(.2,1.3,.4,1)' });
  }
}

function inputCenter() {
  const r = $('answer').getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

function onCorrect({ entry, tier }) {
  setPhase('resolve');
  stopTimer();
  addCard(entry, true);
  stamp(tier.name, tier.points, tier.id);
  setFeedback('');
  const [x, y] = inputCenter();
  const color = tierColor(tier.id);
  fx.burst(x, y, { colors: [color, color, cssVar('--fg')], count: 10 + tier.rank * 10, speed: 5 + tier.rank * 1.4 });
  if (tier.rank >= 3) fx.ring(x, y, { color, radius: 120 + tier.rank * 45, width: 4 + tier.rank });
  if (tier.rank >= 5) {
    fx.ring(x, y, { color, radius: 520, width: 10, life: 44 });
    shake($('stage'), 7);
  }
  sound.correct(tier.rank);
  bumpScore(entry.seat, tier.id);
  updateSeats();
  later(advance, tier.rank >= 4 ? 1250 : 950);
}

function onTimeout() {
  setPhase('resolve');
  stopTimer();
  setTimerVisual(0, 'red');
  $('timerNum').textContent = '0';
  const p = game.timeout();
  breakHeart(p);
  updateSeats();
  stamp('Time’s up', 0, 'miss');
  setFeedback(p.out ? `${p.name} is out` : `${p.name} loses a heart`, 'error');
  shake($('stage'), 8);
  sound.timeout();
  later(advance, 1500);
}

function advance() {
  const result = game.advance();
  if (result.type === 'turn') beginTurn();
  else endRound(result);
}

$('answer').addEventListener('input', () => $('answerForm').classList.remove('is-wrong'));

$('answerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (phase !== 'turn' || paused) return;
  const verdict = game.submit($('answer').value);
  if (verdict.kind === 'empty') return;
  if (verdict.kind === 'hit') {
    if (verdict.tier.id === 'insane') onInsane(verdict);
    else onCorrect(verdict);
    return;
  }
  if (verdict.kind === 'used') {
    wrong(verdict.by === game.seat ? 'You already said that' : `Already said by ${game.players[verdict.by].name}`);
  } else if (verdict.kind === 'blocked') {
    wrong('Not allowed here');
  } else if (verdict.kind === 'random') {
    wrong('That doesn’t look like a real answer');
  } else {
    wrong('Not on the board');
  }
});

/* ---------- Insane answer ---------- */

function raysMarkup() {
  const paths = [];
  const n = 18;
  for (let i = 0; i < n; i += 1) {
    const a1 = (i / n) * Math.PI * 2;
    const a2 = a1 + (Math.PI * 2) / n / 2;
    const p = (a) => `${(Math.cos(a) * 150).toFixed(1)} ${(Math.sin(a) * 150).toFixed(1)}`;
    paths.push(`<path d="M0 0 L${p(a1)} L${p(a2)} Z"/>`);
  }
  return paths.join('');
}

function onInsane({ entry, tier }) {
  setPhase('insane');
  stopTimer();
  addCard(entry, true);
  bumpScore(entry.seat, tier.id);
  updateSeats();
  $('answer').blur();
  playInsane(entry, tier).then(() => {
    setPhase('resolve');
    later(advance, 250);
  });
}

function playInsane(entry, tier) {
  return new Promise((resolve) => {
    const root = $('insane');
    const player = game.players[entry.seat];
    const reduced = reducedMotion();
    const red = cssVar('--tier-insane');
    const white = cssVar('--white');
    const deep = cssVar('--insane-deep');
    const shards = [red, red, white, deep];
    const timers = [];
    const T = (ms) => (reduced ? Math.round(ms * 0.15) : ms);
    const at = (ms, fn) => timers.push(setTimeout(fn, T(ms)));

    $('insaneAnswer').textContent = prettify(entry.text);
    $('insaneBy').textContent = player.name;
    const av = $('insaneAvatar');
    av.textContent = initials(player.name);
    av.style.setProperty('--c', `var(--p${(player.seat % MAX_PLAYERS) + 1})`);
    $('insanePts').textContent = '+0';
    const title = $('insaneTitle');
    title.replaceChildren(
      ...'INSANE ANSWER'.split(' ').map((word) => {
        const w = make('span', 'word');
        [...word].forEach((ch) => w.append(make('span', 'ch', ch)));
        w.setAttribute('aria-hidden', 'true');
        return w;
      }),
    );
    const go = $('insaneGo');
    go.disabled = true;
    root.hidden = false;
    root.style.opacity = '1';

    const badge = $('insaneBadge');
    const br = badge.getBoundingClientRect();
    const cx = br.left + br.width / 2;
    const cy = br.top + br.height / 2;
    const raysWrap = root.querySelector('.insane__rays');
    const raysSvg = $('insaneRays');
    const halves = root.querySelectorAll('.badge__half');
    const mark = root.querySelector('.badge__mark');
    const flash = $('insaneFlash');
    const fill = 'both';

    // 1. Hit: freeze, flash red, everything shakes.
    sound.insaneImpact();
    root.querySelector('.insane__bg').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill });
    flash.style.background = red;
    flash.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
    shake($('app'), 18, 520);
    shake(root, 16, 520);
    raysWrap.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 800, easing: 'cubic-bezier(.2,.9,.3,1.15)', fill });
    const spin = raysSvg.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 26000, iterations: Infinity });

    // 2. The badge slams down.
    badge.animate(
      [
        { transform: 'translateY(-80px) scale(2.8)', opacity: 0 },
        { transform: 'translateY(0) scale(.9)', opacity: 1, offset: 0.72 },
        { transform: 'translateY(0) scale(1)', opacity: 1 },
      ],
      { duration: 440, delay: 120, easing: 'cubic-bezier(.4,0,.2,1)', fill },
    );
    at(430, () => {
      fx.ring(cx, cy, { color: red, radius: 260, width: 10 });
      fx.burst(cx, cy, { colors: shards, count: 40, speed: 9 });
      shake($('insane'), 10, 300);
    });
    const embers = setInterval(() => fx.ember(shards), 70);

    // 3. It charges up.
    at(620, () => {
      sound.insaneRiser(1.15);
      spin.updatePlaybackRate(6);
      if (reduced) return;
      const frames = [];
      for (let i = 0; i <= 14; i += 1) {
        const k = i / 14;
        const amp = 2 + k * 9;
        frames.push({ transform: `rotate(${(i % 2 ? amp : -amp).toFixed(1)}deg) scale(${(1 + k * 0.16).toFixed(3)})` });
      }
      badge.animate(frames, { duration: 1120, easing: 'linear' });
    });

    // 4. Burst open.
    at(1750, () => {
      sound.insaneBurst();
      spin.updatePlaybackRate(1);
      halves[0].animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(-70px, -26px) rotate(-40deg)', opacity: 0 }], { duration: 640, easing: 'cubic-bezier(.2,.7,.2,1)', fill });
      halves[1].animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(70px, 26px) rotate(40deg)', opacity: 0 }], { duration: 640, easing: 'cubic-bezier(.2,.7,.2,1)', fill });
      mark.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }], { duration: 420, easing: 'ease-out', fill });
      flash.style.background = white;
      flash.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 460, easing: 'ease-out' });
      fx.burst(cx, cy, { colors: shards, count: 150, speed: 17, size: [6, 16], life: [55, 110] });
      [0, 130, 260].forEach((d, i) => setTimeout(() => fx.ring(cx, cy, { color: i === 1 ? white : red, radius: 320 + i * 260, width: 14 - i * 3, life: 40 + i * 8 }), d));
      shake($('insane'), 22, 620);
    });

    // 5. Title stamps in letter by letter, then the answer, the player and the points.
    title.querySelectorAll('.ch').forEach((ch, i) => {
      ch.animate(
        [
          { opacity: 0, transform: 'translateY(-46px) scale(2.3)' },
          { opacity: 1, transform: 'translateY(0) scale(.88)', offset: 0.7 },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 360, delay: T(1820) + i * 38, easing: 'cubic-bezier(.2,.9,.3,1.25)', fill },
      );
    });
    $('insaneAnswer').animate(
      [
        { opacity: 0, transform: 'scale(.5) rotate(-5deg)' },
        { opacity: 1, transform: 'scale(1.08) rotate(1.5deg)', offset: 0.7 },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 420, delay: T(2420), easing: 'cubic-bezier(.2,.9,.3,1.2)', fill },
    );
    root.querySelector('.insane__meta').animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: T(2750), fill });
    at(2800, () => {
      const t0 = performance.now();
      const count = (now) => {
        const k = Math.min(1, (now - t0) / 650);
        $('insanePts').textContent = `+${Math.round(tier.points * (1 - (1 - k) ** 3))}`;
        if (k < 1) requestAnimationFrame(count);
      };
      requestAnimationFrame(count);
      sound.correct(6);
    });
    go.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 300, delay: T(3300), fill });
    at(3300, () => {
      go.disabled = false;
      go.focus({ preventScroll: true });
      finishInsane = close;
    });

    function close() {
      finishInsane = null;
      go.disabled = true;
      timers.forEach(clearTimeout);
      clearInterval(embers);
      root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-in' }).finished.then(() => {
        root.hidden = true;
        root.querySelectorAll('*').forEach((n) => n.getAnimations().forEach((a) => a.cancel()));
        raysSvg.getAnimations().forEach((a) => a.cancel());
        resolve();
      });
    }
    go.onclick = close;
  });
}

/* ---------- Round end and results ---------- */

function reasonText(reason) {
  const seatName = game.players[game.seat].name;
  if (reason === 'back') return `Back around to ${seatName}, who missed this one.`;
  if (reason === 'cleared') return 'Every answer on the board was found.';
  if (reason === 'long') return 'Three full laps. On to the next one.';
  if (reason === 'skipped') return 'Question skipped.';
  const alive = game.alive;
  return alive.length === 1 ? `${alive[0].name} is the last one standing.` : 'Everyone is out of hearts.';
}

function chip(group, entry) {
  const node = make('span', entry ? 'chip is-found' : 'chip');
  node.dataset.tier = group.tier;
  if (entry) {
    const p = game.players[entry.seat];
    node.append(avatar(p.seat, initials(p.name), 'xs'));
  }
  node.append(make('span', null, group.label));
  return node;
}

function renderReveal() {
  const q = game.question;
  const round = game.round;
  const rows = [];
  for (const t of [...TIERS].reverse()) {
    const listed = q.groups.filter((g) => g.tier === t.id);
    const free = round.log.filter((e) => e.group.free && e.tier.id === t.id).map((e) => e.group);
    const all = [...listed, ...free];
    if (!all.length) continue;
    const found = all.filter((g) => round.used.has(g.id));
    const missing = all.filter((g) => !round.used.has(g.id));
    const row = make('section', 'tier-row');
    const head = make('div', 'tier-row__head');
    const pill = make('span', 'pill', t.name);
    pill.dataset.tier = t.id;
    head.append(pill, make('span', 'tier-row__count', `${found.length} of ${all.length} found`));
    if (q.wildcard === t.id) head.lastChild.textContent = `${found.length} found`;
    const chips = make('div', 'chips');
    found.forEach((g) => chips.append(chip(g, round.used.get(g.id))));
    const LIMIT = 12;
    missing.slice(0, LIMIT).forEach((g) => chips.append(chip(g)));
    if (missing.length > LIMIT) chips.append(make('span', 'chip chip--more', `${missing.length - LIMIT} more`));
    row.append(head, chips);
    rows.push(row);
  }
  $('reveal').replaceChildren(...rows);
}

function renderStandings() {
  $('standings').replaceChildren(
    ...game.ranking().map((p) => {
      const node = make('span', p.out ? 'standing is-out' : 'standing');
      node.append(avatar(p.seat, initials(p.name), 'sm'), make('span', 'standing__name', p.name), make('span', 'standing__score', String(p.score)));
      return node;
    }),
  );
}

function openSheet(id) {
  const sheet = $(id);
  sheet.hidden = false;
  sheet.firstElementChild.animate([{ opacity: 0, transform: 'translateY(16px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

function closeSheet(id) {
  $(id).hidden = true;
}

function endRound(result) {
  setPhase('round');
  stopTimer();
  updateSeats();
  $('roundTitle').textContent = game.question.prompt;
  $('roundReason').textContent = reasonText(result.reason);
  renderReveal();
  renderStandings();
  const next = $('nextBtn');
  next.textContent = result.final ? 'See results' : 'Next question';
  next.disabled = true;
  next.onclick = () => {
    closeSheet('roundSheet');
    if (result.final) showOver();
    else nextQuestion();
  };
  openSheet('roundSheet');
  sound.roundEnd();
  later(() => {
    next.disabled = false;
    next.focus({ preventScroll: true });
  }, 700);
}

function showOver() {
  setPhase('over');
  stopTimer();
  epoch += 1;
  const ranked = game.ranking();
  const top = ranked[0];
  const tied = ranked.length > 1 && ranked[1].score === top.score && ranked[1].hearts === top.hearts;
  const solo = game.players.length === 1;
  $('winnerTitle').textContent = solo ? `${top.score} points` : tied ? 'It’s a tie' : `${top.name} wins`;
  $('winnerScore').textContent = solo ? `${top.finds.length} answers found` : `${top.score} points`;
  const big = $('winnerAvatar');
  big.textContent = initials(top.name);
  big.style.setProperty('--c', `var(--p${(top.seat % MAX_PLAYERS) + 1})`);
  big.hidden = tied && !solo;

  $('results').replaceChildren(
    ...ranked.map((p, i) => {
      const tr = make('tr');
      const who = make('td');
      const wrap = make('div', 'who');
      wrap.append(make('span', 'rank', String(i + 1)), avatar(p.seat, initials(p.name), 'sm'), make('span', null, p.name));
      if (p.out) wrap.append(make('span', 'tag', 'Out'));
      who.append(wrap);
      const best = make('td');
      const pick = [...p.finds].sort((a, b) => b.tier.rank - a.tier.rank)[0];
      if (pick) {
        const b = make('div', 'best');
        const pill = make('span', 'pill', pick.tier.name);
        pill.dataset.tier = pick.tier.id;
        b.append(pill, make('span', 'best__label', pick.group.label));
        best.append(b);
      } else {
        best.append(make('span', 'muted', 'Nothing yet'));
      }
      tr.append(who, best, make('td', 'num', String(p.finds.length)), make('td', 'num strong', String(p.score)));
      return tr;
    }),
  );
  show('over');
  sound.fanfare();
  const colors = TIERS.map((t) => tierColor(t.id));
  [0, 260, 520].forEach((d, i) => {
    setTimeout(() => fx.burst(window.innerWidth * (0.25 + i * 0.25), window.innerHeight * 0.22, { colors, count: 60, speed: 12, gravity: 0.25, life: [70, 120] }), d);
  });
}

/* ---------- Pause ---------- */

function pause() {
  if (paused || !['intro', 'turn', 'resolve'].includes(phase)) return;
  paused = true;
  stopTimer();
  openSheet('pauseSheet');
  $('resumeBtn').focus({ preventScroll: true });
}

function resume() {
  if (!paused) return;
  paused = false;
  closeSheet('pauseSheet');
  if (phase === 'turn') {
    timer.start = performance.now() - (timer.dur - timer.left);
    timer.raf = requestAnimationFrame(tickTimer);
    $('answer').focus({ preventScroll: true });
  }
  deferred.splice(0).forEach((fn) => fn());
}

function leavePause() {
  paused = false;
  epoch += 1;
  deferred = [];
  stopTimer();
  closeSheet('pauseSheet');
}

/* ---------- Wiring ---------- */

$('addPlayer').addEventListener('click', () => {
  if (names.length >= MAX_PLAYERS) return;
  names.push('');
  saveNames();
  renderRoster();
  $(`player-${names.length - 1}`).focus();
});
$('startBtn').addEventListener('click', startGame);
$('againBtn').addEventListener('click', startGame);
$('menuBtn').addEventListener('click', () => {
  setPhase('setup');
  show('setup');
});
$('pauseBtn').addEventListener('click', pause);
$('resumeBtn').addEventListener('click', resume);
$('skipBtn').addEventListener('click', () => {
  leavePause();
  endRound(game.skip());
});
$('quitBtn').addEventListener('click', () => {
  leavePause();
  showOver();
});

const soundBtn = $('soundBtn');
const syncSound = () => soundBtn.setAttribute('aria-pressed', String(sound.enabled));
soundBtn.addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  if (sound.enabled) sound.unlock();
  store.set(KEYS.sound, sound.enabled);
  syncSound();
});

document.addEventListener('keydown', (e) => {
  if (phase === 'insane') {
    if (finishInsane && ['Enter', ' ', 'Escape'].includes(e.key)) {
      e.preventDefault();
      finishInsane();
    }
    return;
  }
  if (e.key === 'Escape') {
    if (paused) resume();
    else pause();
  }
});
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase === 'turn') pause();
});

$('insaneRays').innerHTML = raysMarkup();
syncSound();
renderRoster();
initSettings();
loadBank();
