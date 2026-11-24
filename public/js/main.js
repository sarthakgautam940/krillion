// Draws the room. The server decides everything; this file turns its state and events into
// screens, timers, sounds and animation.
import { Sound } from './audio.js';
import { FX, shake } from './fx.js';
import { playInsane } from './insane.js';
import { loadMe, saveMe, serverNow, connect } from './net.js';

const $ = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const tierColor = (id) => css(`--tier-${id}`);
const HEART = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';
const SOUND_KEY = 'yuc.sound';

const me = loadMe();
const sound = new Sound(readSoundPref());
const fx = new FX($('fx'));

let room = null; // latest room from the server
let here = new Set(); // ids present, for the lobby list
let status = 'ok'; // ok | offline | setup
let watching = false;
let screen = '';
let lastEvent = 0;
let stageKey = '';
let questionKey = '';
let lastTick = null;
let sending = false;
let insaneShow = null;
const boardIds = new Set();
const shownScores = new Map();
const bumping = new Set();

const conn = connect({ me, onState, onStatus });

/* ---------- Small helpers ---------- */

function readSoundPref() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.length === 1 ? parts[0][0].toUpperCase() : (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatar(person, size) {
  const node = make('span', size ? `avatar avatar--${size}` : 'avatar', initials(person.name));
  node.style.setProperty('--c', `var(--p${(person.color % 8) + 1})`);
  node.setAttribute('aria-hidden', 'true');
  return node;
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

const tierInfo = (id) => room?.tiers?.find((t) => t.id === id) ?? { id, name: id, points: 0 };
const tierRank = (id) => Math.max(0, room?.tiers?.findIndex((t) => t.id === id) ?? 0);
const mySeat = () => (room?.seats ?? []).findIndex((p) => p.id === me.id);
const joined = () => Boolean(room?.roster?.some((p) => p.id === me.id));
const seatEl = (seat) => $('seats').children[seat];
const nameOf = (seat) => (room.seats[seat]?.id === me.id ? 'you' : room.seats[seat]?.name ?? 'someone');
const possessive = (name) => `${name}’s`;

function setFeedback(text, tone) {
  const node = $('feedback');
  node.textContent = text;
  node.className = tone ? `feedback is-${tone}` : 'feedback';
}

/* ---------- State in ---------- */

function onStatus(next) {
  if (next === status) return;
  status = next;
  render();
}

function onState(next, hereIds) {
  if (hereIds) here = new Set(hereIds);
  if (next) {
    const first = room === null;
    if (first) lastEvent = next.eventId;
    if (room && room.game !== next.game) resetGameView();
    room = next;
  }
  render();
  if (next) handleEvents();
}

function resetGameView() {
  $('seats').replaceChildren();
  $('board').replaceChildren();
  boardIds.clear();
  shownScores.clear();
  bumping.clear();
  questionKey = '';
  stageKey = '';
  setFeedback('');
}

/* ---------- Screens ---------- */

function pickScreen() {
  if (!room) return 'front';
  const involved = mySeat() >= 0 || joined() || watching;
  if (room.phase === 'game' && involved) return 'game';
  if (room.phase === 'over' && involved) return 'results';
  return 'front';
}

function render() {
  const next = pickScreen();
  if (next !== screen) {
    screen = next;
    ['front', 'game', 'results'].forEach((id) => {
      $(id).hidden = id !== next;
    });
    stageKey = '';
    window.scrollTo(0, 0);
  }
  conn.setLobby(!room || room.phase === 'lobby');
  $('conn').hidden = status !== 'offline';
  if (screen === 'front') renderFront();
  else if (screen === 'game') renderGame();
  else renderResults();
}

function renderFront() {
  const inRoom = joined();
  const lobby = !room || room.phase === 'lobby';
  const notice = $('notice');
  if (status === 'setup') notice.textContent = 'The room isn’t connected to its database yet, so nobody can join. Check back soon.';
  else if (room?.phase === 'game') notice.textContent = `A game is going, question ${room.qi + 1} of ${room.qCount}. Join now to play the next one.`;
  else if (room?.phase === 'over') notice.textContent = 'A game just finished. Join to play the next one.';
  else notice.textContent = '';
  notice.hidden = !notice.textContent;

  $('joinForm').hidden = inRoom;
  $('joinBtn').textContent = lobby ? 'Join' : 'Join next game';
  $('joinBtn').disabled = status === 'setup';
  if (!inRoom && !$('nameInput').value && me.name && document.activeElement !== $('nameInput')) $('nameInput').value = me.name;
  $('lobbyActions').hidden = !(inRoom && lobby);
  $('watchBtn').hidden = lobby || inRoom || room?.phase !== 'game';

  const people = (room?.roster ?? []).filter((p) => p.id === me.id || !here.size || here.has(p.id));
  renderRoster(people);
  $('roomCount').textContent = people.length ? String(people.length) : '';
  $('roomEmpty').hidden = people.length > 0;
  $('roomSection').hidden = !lobby && !people.length;
  $('startBtn').textContent = people.length > 1 ? `Start game with ${people.length}` : 'Start game';
}

function renderRoster(people) {
  const list = $('roster');
  const existing = new Map([...list.children].map((li) => [li.dataset.id, li]));
  people.forEach((p) => {
    let li = existing.get(p.id);
    if (!li) {
      li = make('li', 'person');
      li.dataset.id = p.id;
      li.append(make('span', 'avatar'), make('span', 'person__name'), make('span', 'person__tag'));
      li.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'ease-out' });
    }
    li.replaceChild(avatar(p), li.firstChild);
    li.querySelector('.person__name').textContent = p.name;
    li.querySelector('.person__tag').textContent = p.id === me.id ? 'You' : '';
    list.append(li);
    existing.delete(p.id);
  });
  existing.forEach((li) => li.remove());
}

/* ---------- Game screen ---------- */

function renderGame() {
  renderSeats();
  const key = `${room.game}:${room.qi}`;
  $('progress').textContent = room.qi >= 0 ? `Question ${room.qi + 1} of ${room.qCount}` : '';
  if (key !== questionKey) {
    questionKey = key;
    $('board').replaceChildren();
    boardIds.clear();
    setFeedback('');
    const title = $('question');
    title.textContent = room.question?.prompt ?? '';
    title.animate([{ opacity: 0, transform: 'translateY(18px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  renderBoard();
}

function renderSeats() {
  const wrap = $('seats');
  if (wrap.children.length !== room.seats.length) {
    wrap.replaceChildren(
      ...room.seats.map((p, i) => {
        const node = make('div', 'seat');
        const line = make('div', 'seat__line');
        line.append(make('span', 'hearts'), make('span', 'seat__score', String(p.score)));
        node.append(avatar(p, 'seat'), make('span', 'seat__name'), line);
        shownScores.set(i, p.score);
        return node;
      }),
    );
    stageKey = '';
  }
  room.seats.forEach((p, i) => {
    const node = seatEl(i);
    node.classList.toggle('is-out', p.out);
    node.classList.toggle('is-me', p.id === me.id);
    node.querySelector('.seat__name').textContent = p.id === me.id ? 'You' : p.name;
    const hearts = node.querySelector('.hearts');
    hearts.replaceChildren(...Array.from({ length: p.maxHearts }, (_, h) => heartIcon(h < p.hearts)));
    hearts.setAttribute('aria-label', `${p.hearts} of ${p.maxHearts} hearts`);
  });
}

function syncScores() {
  room.seats.forEach((p, i) => {
    if (bumping.has(i) || shownScores.get(i) === p.score) return;
    shownScores.set(i, p.score);
    const node = seatEl(i)?.querySelector('.seat__score');
    if (node) node.textContent = String(p.score);
  });
}

function bumpScore(seat, tierId) {
  const node = seatEl(seat)?.querySelector('.seat__score');
  if (!node) return;
  const from = shownScores.get(seat) ?? 0;
  const to = room.seats[seat].score;
  shownScores.set(seat, to);
  bumping.add(seat);
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 700);
    node.textContent = String(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
    else bumping.delete(seat);
  };
  requestAnimationFrame(step);
  node.animate([{ transform: 'scale(1.45)', color: tierColor(tierId) }, { transform: 'scale(1)' }], { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

function renderBoard() {
  const board = $('board');
  for (const entry of room.round?.found ?? []) {
    if (boardIds.has(entry.id)) continue;
    boardIds.add(entry.id);
    const finder = room.seats[entry.seat];
    const li = make('li', 'found');
    li.dataset.tier = entry.tier;
    li.title = `${finder?.name ?? ''}, ${tierInfo(entry.tier).name}`;
    li.append(avatar(finder ?? { name: '?', color: 0 }, 'xs'), make('span', 'found__label', entry.label), make('span', 'found__pts', `+${entry.points}`));
    board.prepend(li);
    li.animate([{ opacity: 0, transform: 'scale(.7)' }, { opacity: 1, transform: 'scale(1.06)', offset: 0.7 }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
  }
}

const REASONS = {
  back: (s) => `Back around to ${s}, who missed this one.`,
  cleared: () => 'Every answer on the board was found.',
  long: () => 'Three full laps. On to the next one.',
  standing: () => {
    const alive = room.seats.filter((p) => !p.out);
    return alive.length === 1 ? `${alive[0].id === me.id ? 'You are' : `${alive[0].name} is`} the last one standing.` : 'Everyone is out of hearts.';
  },
};

function fillRecap(st) {
  const backName = room.seats[st.seat]?.id === me.id ? 'you' : room.seats[st.seat]?.name ?? '';
  $('recapReason').textContent = (REASONS[st.reason] ?? (() => ''))(backName);
  const rows = (st.reveal ?? []).map((row) => {
    const section = make('section', 'tier-row');
    const head = make('div', 'tier-row__head');
    const pill = make('span', 'pill', tierInfo(row.tier).name);
    pill.dataset.tier = row.tier;
    const count = row.total === null ? `${row.found.length} found` : `${row.found.length} of ${row.total} found`;
    head.append(pill, make('span', 'tier-row__count', count));
    const chips = make('div', 'chips');
    row.found.forEach((f) => {
      const chip = make('span', 'chip is-found');
      chip.dataset.tier = row.tier;
      const finder = room.seats[f.seat];
      chip.append(avatar(finder ?? { name: '?', color: 0 }, 'xs'), make('span', null, f.label));
      chips.append(chip);
    });
    row.missing.forEach((label) => chips.append(make('span', 'chip', label)));
    if (row.more) chips.append(make('span', 'chip chip--more', `${row.more} more`));
    section.append(head, chips);
    return section;
  });
  $('reveal').replaceChildren(...rows);
  const next = $('nextBtn');
  next.textContent = st.final ? 'See results' : 'Next question';
  next.hidden = !joined() && mySeat() < 0;
  next.disabled = true;
}

/* ---------- Stages and the timer ---------- */

/** The stage to show now. Turns that the server already planned start on time locally. */
function derive(now) {
  const st = room?.stage;
  if (!st || room.phase !== 'game') return null;
  if (now < st.until) return st;
  const turnMs = room.rules.turnMs;
  if ((st.kind === 'resolve' || st.kind === 'insane') && st.next?.kind === 'turn') {
    return { kind: 'turn', seat: st.next.seat, from: st.until, until: st.until + turnMs, predicted: true };
  }
  if (st.kind === 'intro') return { kind: 'turn', seat: st.seat, from: st.until, until: st.until + turnMs, predicted: true };
  return st;
}

function onStage(st) {
  const game = $('game');
  const kind = st?.kind ?? '';
  game.dataset.stage = kind;
  if (st) conn.wakeAt(st.until);
  if (kind !== 'insane' && insaneShow) {
    insaneShow.close();
    insaneShow = null;
  }

  const recap = kind === 'round';
  $('playArea').hidden = recap;
  $('recap').hidden = !recap;
  if (recap) fillRecap(st);

  const activeSeat = ['intro', 'turn', 'resolve', 'insane'].includes(kind) ? st.seat : -1;
  [...$('seats').children].forEach((node, i) => node.classList.toggle('is-active', i === activeSeat));

  const player = room.seats[st?.seat];
  const mine = Boolean(player) && player.id === me.id;
  game.dataset.mine = mine ? 'yes' : 'no';
  const input = $('answer');
  const canType = kind === 'turn' && mine;
  input.disabled = !canType;
  $('sendBtn').disabled = !canType || sending;

  const turnName = $('turnName');
  const turnAvatar = $('turnAvatar');
  if (player && (kind === 'intro' || kind === 'turn')) {
    turnName.textContent = kind === 'intro' ? (mine ? 'You go first' : `${player.name} goes first`) : mine ? 'Your turn' : `${possessive(player.name)} turn`;
    turnAvatar.replaceWith(Object.assign(avatar(player), { id: 'turnAvatar' }));
    $('turn').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
  }

  if (mySeat() < 0) input.placeholder = joined() ? 'You’re in for the next game' : 'You’re watching';
  else if (canType) input.placeholder = 'Type an answer';
  else input.placeholder = player && kind === 'turn' ? `Waiting for ${player.name}` : '';

  if (kind === 'turn') {
    lastTick = null;
    input.value = '';
    setFeedback('');
    $('answerForm').classList.remove('is-wrong');
    sound.turn();
    if (canType) {
      input.focus({ preventScroll: true });
      navigator.vibrate?.(40);
    }
  }
}

function drawTimer(st, now) {
  const fill = $('timerFill');
  const num = $('timerNum');
  const game = $('game');
  if (!st) return;
  if (st.kind === 'turn' || st.kind === 'round') {
    const total = st.until - st.from;
    const left = Math.max(0, Math.min(total, st.until - now));
    const ratio = total > 0 ? left / total : 0;
    fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    num.textContent = String(Math.ceil(left / 1000));
    if (st.kind === 'round') {
      game.dataset.timer = 'idle';
      $('nextBtn').disabled = now < st.from + room.rules.roundMinMs;
      return;
    }
    game.dataset.timer = ratio > 0.5 ? 'blue' : ratio > 0.25 ? 'yellow' : 'red';
    if (ratio <= 0.25 && left > 0) {
      const mark = Math.ceil(left / (left < 2000 ? 500 : 1000));
      if (mark !== lastTick) {
        lastTick = mark;
        sound.tick(game.dataset.mine === 'yes');
      }
    }
  } else if (st.kind === 'intro') {
    fill.style.width = '100%';
    game.dataset.timer = 'idle';
    num.textContent = String(Math.round(room.rules.turnMs / 1000));
  }
}

function frame() {
  requestAnimationFrame(frame);
  if (screen !== 'game' || !room) return;
  const now = serverNow();
  const st = derive(now);
  const key = st ? `${room.game}:${room.qi}:${st.kind}:${st.seat ?? ''}:${st.from}` : 'none';
  if (key !== stageKey) {
    stageKey = key;
    onStage(st);
  }
  drawTimer(st, now);
}

/* ---------- Events: one-off moments everyone sees ---------- */

function inputCenter() {
  const r = $('answer').getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
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

function breakHeart(seat) {
  const player = room.seats[seat];
  const lost = seatEl(seat)?.querySelectorAll('.heart')[player.hearts];
  if (!lost) return;
  const r = lost.getBoundingClientRect();
  fx.burst(r.left + r.width / 2, r.top + r.height / 2, { colors: [css('--heart'), css('--fg')], count: 14, speed: 4, size: [3, 7], life: [25, 45] });
  const ghost = heartIcon(true);
  Object.assign(ghost.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: 50, pointerEvents: 'none' });
  document.body.append(ghost);
  ghost
    .animate(
      [
        { transform: 'scale(1) rotate(0)', opacity: 1 },
        { transform: 'scale(2.4) rotate(-12deg)', opacity: 1, offset: 0.3 },
        { transform: 'translateY(40px) scale(1.4) rotate(25deg)', opacity: 0 },
      ],
      { duration: 720, easing: 'cubic-bezier(.3,.6,.4,1)' },
    )
    .finished.then(() => ghost.remove(), () => ghost.remove());
}

function tryMessage(e) {
  const said = `“${e.text}”`;
  if (e.verdict === 'used') return `${said} was already said by ${e.by === null ? 'someone' : nameOf(e.by)}`;
  if (e.verdict === 'blocked') return `${said} isn’t allowed`;
  if (e.verdict === 'random') return `${said} doesn’t look like a real answer`;
  return `${said} isn’t on the board`;
}

function handleEvents() {
  const fresh = room.events.filter((e) => e.id > lastEvent);
  lastEvent = Math.max(lastEvent, room.eventId);
  const now = serverNow();
  for (const e of fresh) {
    if (now - e.t > 8000 || screen === 'front') continue;
    onEvent(e, now);
  }
  if (screen === 'game') syncScores();
}

function onEvent(e, now) {
  const player = room.seats?.[e.seat];
  const mine = player?.id === me.id;
  switch (e.type) {
    case 'try': {
      setFeedback(tryMessage(e), 'error');
      if (mine) {
        const form = $('answerForm');
        form.classList.remove('is-shake');
        void form.offsetWidth;
        form.classList.add('is-shake', 'is-wrong');
        $('answer').select();
      } else {
        shake($('feedback'), 5, 280);
      }
      sound.wrong();
      break;
    }
    case 'hit': {
      const tier = tierInfo(e.tier);
      const rank = tierRank(e.tier);
      stamp(tier.name, e.points, e.tier);
      setFeedback('');
      if (mine) $('answer').value = '';
      const [x, y] = inputCenter();
      const color = tierColor(e.tier);
      fx.burst(x, y, { colors: [color, color, css('--fg')], count: 10 + rank * 10, speed: 5 + rank * 1.4 });
      if (rank >= 3) fx.ring(x, y, { color, radius: 120 + rank * 45, width: 4 + rank });
      if (rank >= 5) {
        fx.ring(x, y, { color, radius: 520, width: 10, life: 44 });
        shake($('stage'), 7);
      }
      sound.correct(rank);
      bumpScore(e.seat, e.tier);
      break;
    }
    case 'insane': {
      if (mine) $('answer').value = '';
      bumpScore(e.seat, 'insane');
      if (now - e.t > 6000) break;
      $('answer').blur();
      insaneShow = playInsane({
        answer: prettify(e.text),
        player: { name: player.name, initials: initials(player.name), color: player.color % 8 },
        points: e.points,
        fx,
        sound,
        origin: inputCenter(),
        scene: $('game'),
        canContinueAt: Math.max(0, e.t + room.rules.insaneMinMs - now),
        onContinue: () => (joined() ? conn.act('continue') : null),
      });
      break;
    }
    case 'timeout': {
      stamp('Time’s up', 0, 'miss');
      breakHeart(e.seat);
      const who = mine ? 'You' : player?.name ?? 'Someone';
      setFeedback(e.out ? `${who} ${mine ? 'are' : 'is'} out` : `${who} ${mine ? 'lose' : 'loses'} a heart`, 'error');
      shake($('stage'), 8);
      sound.timeout();
      if (mine) navigator.vibrate?.([80, 60, 80]);
      break;
    }
    case 'round':
      sound.roundEnd();
      break;
    case 'over':
      sound.fanfare();
      celebrate();
      break;
    default:
  }
}

function prettify(text) {
  const forms = { mr: 'Mr.', mrs: 'Mrs.', ms: 'Ms.', dr: 'Dr.' };
  return String(text)
    .split(' ')
    .map((w) => forms[w.toLowerCase().replace(/\./g, '')] ?? (w.length >= 5 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function celebrate() {
  const colors = (room.tiers ?? []).map((t) => tierColor(t.id));
  [0, 260, 520].forEach((d, i) => {
    setTimeout(() => fx.burst(window.innerWidth * (0.25 + i * 0.25), window.innerHeight * 0.22, { colors, count: 60, speed: 12, gravity: 0.25, life: [70, 120] }), d);
  });
}

/* ---------- Results ---------- */

function renderResults() {
  const ranked = [...room.seats].sort((a, b) => b.score - a.score || b.hearts - a.hearts || b.finds.length - a.finds.length);
  const top = ranked[0];
  if (!top) return;
  const tied = ranked.length > 1 && ranked[1].score === top.score && ranked[1].hearts === top.hearts;
  const solo = ranked.length === 1;
  const winnerIsMe = top.id === me.id;
  $('winnerTitle').textContent = solo ? `${top.score} points` : tied ? 'It’s a tie' : winnerIsMe ? 'You win' : `${top.name} wins`;
  $('winnerSub').textContent = solo ? `${top.finds.length} answers found` : `${top.score} points`;
  const big = $('winnerAvatar');
  big.textContent = initials(top.name);
  big.style.setProperty('--c', `var(--p${(top.color % 8) + 1})`);
  big.hidden = tied && !solo;

  $('standings').replaceChildren(
    ...ranked.map((p, i) => {
      const li = make('li', p.id === me.id ? 'standing is-me' : 'standing');
      const who = make('div', 'standing__who');
      who.append(make('span', 'standing__name', p.id === me.id ? `${p.name} (you)` : p.name));
      const best = [...p.finds].sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];
      const line = make('div', 'standing__best');
      if (best) {
        const pill = make('span', 'pill pill--sm', tierInfo(best.tier).name);
        pill.dataset.tier = best.tier;
        line.append(pill, make('span', null, best.label));
      } else {
        line.append(make('span', null, 'No answers found'));
      }
      who.append(line);
      li.append(make('span', 'standing__rank', String(i + 1)), avatar(p, 'lg'), who, make('span', 'standing__score', String(p.score)));
      return li;
    }),
  );
  $('lobbyBtn').textContent = joined() ? 'Back to the room' : 'Join the next game';
}

/* ---------- Moves ---------- */

async function busyButton(button, task) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.disabled = false;
  }
}

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  const name = $('nameInput').value.trim();
  const error = $('joinError');
  if (!name) {
    error.textContent = 'Type your name first';
    $('nameInput').focus();
    return;
  }
  busyButton($('joinBtn'), async () => {
    const res = await conn.act('join', { name });
    if (res.error) {
      error.textContent = res.message || res.error;
      return;
    }
    error.textContent = '';
    me.name = name;
    saveMe(me);
    $('nameInput').blur();
  });
});

$('startBtn').addEventListener('click', () => {
  sound.unlock();
  busyButton($('startBtn'), async () => {
    const res = await conn.act('start');
    if (res.error) $('joinError').textContent = res.message || res.error;
  });
});

$('leaveBtn').addEventListener('click', () => busyButton($('leaveBtn'), () => conn.act('leave')));

$('watchBtn').addEventListener('click', () => {
  sound.unlock();
  watching = true;
  render();
});

$('answer').addEventListener('input', () => $('answerForm').classList.remove('is-wrong'));

$('answerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('answer').value.trim();
  if (!text || sending || $('answer').disabled) return;
  sending = true;
  $('sendBtn').disabled = true;
  const res = await conn.act('answer', { text });
  sending = false;
  $('sendBtn').disabled = $('answer').disabled;
  if (res.error) setFeedback(res.message || res.error, 'error');
});

$('nextBtn').addEventListener('click', () => busyButton($('nextBtn'), () => conn.act('next')));

$('lobbyBtn').addEventListener('click', () => {
  if (joined()) {
    busyButton($('lobbyBtn'), () => conn.act('lobby'));
    return;
  }
  watching = false;
  render();
  $('nameInput').focus();
});

const soundBtn = $('soundBtn');
const syncSoundButton = () => soundBtn.setAttribute('aria-pressed', String(sound.enabled));
soundBtn.addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  if (sound.enabled) sound.unlock();
  try {
    localStorage.setItem(SOUND_KEY, sound.enabled ? 'on' : 'off');
  } catch {
    /* not remembered */
  }
  syncSoundButton();
});

document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
document.addEventListener('keydown', (e) => {
  if (insaneShow?.ready && ['Enter', ' ', 'Escape'].includes(e.key)) {
    e.preventDefault();
    $('insaneGo').click();
  }
});

syncSoundButton();
render();
conn.poll();
requestAnimationFrame(frame);
