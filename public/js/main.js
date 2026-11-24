// Joins the room through the relay and draws it. Whichever phone is the host runs the rules
// (engine.js) and broadcasts the room; every phone, the host included, draws from that room.
import { Sound } from './audio.js';
import { FX, shake } from './fx.js';
import { playInsane } from './insane.js';
import { connectRelay, Timers } from './relay.js';
import { parseBank, TIERS } from './bank.js';
import * as engine from './engine.js';

const ROOM = 'main-room';
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];
const qs = new URLSearchParams(location.search);
const brokers = qs.get('broker') ? qs.get('broker').split(',') : BROKERS; // ?broker=ws://localhost:9001 for testing
const ME_KEY = 'yuc.me';
if (qs.has('fast')) engine.speedUp(0.3); // test switch, like spelling-race's
const SOUND_KEY = 'yuc.sound';
const BEST_KEY = 'yuc.best';
const HEART = 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z';

const $ = (id) => document.getElementById(id);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const tierColor = (id) => css(`--tier-${id}`);
const tierName = (id) => TIERS.find((t) => t.id === id)?.name ?? id;
const tierRank = (id) => Math.max(0, TIERS.findIndex((t) => t.id === id));
const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* not remembered, that is fine */
    }
  },
};

/* ---------- Who am I ---------- */

const makeId = () =>
  crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const me = { id: makeId(), name: '', active: false, ...store.get(ME_KEY) };
const saveMe = () => store.set(ME_KEY, me);
saveMe();

const sound = new Sound(store.get(SOUND_KEY) !== false);
const fx = new FX($('fx'));

/* ---------- Connection ---------- */

let relay = null;
let role = null; // 'host' | 'guest' | null
let status = 'idle'; // idle | connecting | online | offline
let room = null; // the room as this phone knows it
let carry = null; // the last room seen, kept so this phone can carry on if it becomes host
let bank = null;
let bankLoad = null;
let joinError = '';
let hostTimer = 0;
let healStop = null;
let solo = false; // playing alone for points: this phone hosts itself, no relay

function loadBank() {
  bankLoad ??= fetch('questions.txt', { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`questions.txt ${res.status}`);
      return res.text();
    })
    .then((text) => {
      const { questions, warnings } = parseBank(text);
      warnings.forEach((w) => console.warn(`questions.txt: ${w}`));
      bank = questions;
      return questions;
    })
    .catch((err) => {
      bankLoad = null;
      throw err;
    });
  return bankLoad;
}

const clock = () => (role === 'host' || !relay ? Date.now() : relay.hostNow());

async function joinRoom(name) {
  me.name = name;
  me.active = true;
  saveMe();
  joinError = '';
  status = 'connecting';
  render();
  try {
    await loadBank();
  } catch {
    me.active = false;
    saveMe();
    status = 'idle';
    joinError = 'Could not load the questions. Check your connection and try again.';
    render();
    return;
  }
  relay?.stop();
  role = null;
  relay = connectRelay({
    room: ROOM,
    name,
    pid: me.id,
    brokers,
    max: engine.RULES.maxSeats,
    debug: qs.has('debug'),
    on: {
      status(s) {
        status = s === 'online' ? 'online' : s === 'offline' ? 'offline' : 'connecting';
        render();
      },
      role(r) {
        role = r;
        if (r === 'host') becomeHost();
        render();
      },
      welcome(m) {
        if (m.name && m.name !== me.name) {
          me.name = m.name;
          saveMe();
        }
      },
      hello: hostHello,
      msg(m, guest) {
        if (role === 'host') hostMove(guest, m);
        else if (m.t === 'state') receive(m.s);
      },
      guestLeft() {
        if (role === 'host') publish(false);
      },
      hostLost() {
        carry = room;
        role = null;
        stopHosting();
        status = 'connecting';
        render();
      },
      rejected(why) {
        relay = null;
        role = null;
        room = null;
        me.active = false;
        saveMe();
        status = 'idle';
        joinError = why === 'full' ? 'The room is full right now.' : 'Someone in the room already has that name. Pick another one.';
        render();
      },
    },
  });
  relay.start();
}

/** Solo: this phone runs the rules for itself. */
async function startSolo() {
  sound.unlock();
  try {
    await loadBank();
  } catch {
    joinError = 'Could not load the questions. Check your connection and try again.';
    render();
    return;
  }
  solo = true;
  relay = null;
  role = 'host';
  room = engine.emptyRoom();
  const ctx = context();
  engine.join(room, { id: me.id, name: me.name || 'You' }, ctx);
  engine.start(room, { id: me.id, solo: true }, ctx);
  lastEvent = 0;
  publish(true);
}

function exitSolo() {
  stopHosting();
  solo = false;
  role = null;
  room = null;
  render();
}

function leaveRoom() {
  act('leave');
  const r = relay;
  relay = null;
  setTimeout(() => r?.stop(), 200);
  stopHosting();
  role = null;
  room = null;
  carry = null;
  me.active = false;
  saveMe();
  status = 'idle';
  render();
}

/* ---------- Hosting ---------- */

function context() {
  const online = relay ? relay.online() : {};
  online[me.id] = Date.now();
  return { now: Date.now(), online, bank };
}

function becomeHost() {
  const ctx = context();
  const base = carry ?? room;
  carry = null;
  if (base) {
    room = structuredClone(base);
    engine.takeOver(room, ctx);
  } else room = engine.emptyRoom();
  engine.join(room, { id: me.id, name: me.name }, ctx);
  engine.tick(room, ctx);
  publish(true);
  healStop?.();
  healStop = Timers.every(3000, () => publish(false)); // heals any dropped message
}

function stopHosting() {
  Timers.clear(hostTimer);
  hostTimer = 0;
  healStop?.();
  healStop = null;
}

/** Send the room to every phone and draw it here. */
function publish(changed) {
  if (role !== 'host' || !room) return;
  if (changed) room.v += 1;
  room.here = Object.keys(context().online);
  relay?.sendAll({ t: 'state', s: room });
  show(room);
  scheduleTick();
}

function scheduleTick() {
  Timers.clear(hostTimer);
  if (role !== 'host' || !room?.stage) return;
  const wait = Math.max(0, room.stage.until - Date.now()) + 5;
  hostTimer = Timers.after(Math.min(wait, 1000), () => {
    hostTimer = 0;
    if (role !== 'host' || !room) return;
    if (engine.tick(room, context())) publish(true);
    else scheduleTick();
  });
}

function hostHello(m, accept) {
  if (!room) {
    accept(false, 'full');
    return;
  }
  const res = engine.join(room, { id: m.pid, name: m.name }, context());
  if (res.error) {
    accept(false, res.error);
    return;
  }
  accept(true, null, { name: res.name });
  publish(true);
}

const MOVES = {
  answer: (s, id, m, ctx) => engine.answer(s, { id, text: m.text }, ctx),
  start: (s, id, m, ctx) => engine.start(s, { id }, ctx),
  next: (s, id, m, ctx) => engine.hurry(s, { id, kind: 'round' }, ctx),
  continue: (s, id, m, ctx) => engine.hurry(s, { id, kind: 'insane' }, ctx),
  lobby: (s, id, m, ctx) => engine.hurry(s, { id, kind: 'over' }, ctx),
  leave: (s, id) => engine.leave(s, { id }),
  skip: (s, id, m, ctx) => engine.skip(s, { id }, ctx),
};

function hostMove(guest, m) {
  const move = MOVES[m.t];
  if (!room || !move) return null;
  const ctx = context();
  engine.tick(room, ctx);
  const res = move(room, guest ? guest.pid : me.id, m, ctx) ?? {};
  publish(true);
  return res;
}

/** Make a move: the host applies it right away, guests send it to the host. */
function act(t, extra = {}) {
  const m = { t, ...extra };
  if (role === 'host') return hostMove(null, m);
  relay?.send(m);
  return null;
}

function receive(s) {
  if (room && room.rid === s.rid && s.v < room.v) return;
  carry = null;
  show(s);
}

/* ---------- Drawing ---------- */

let screen = '';
let shownGame = null;
let lastEvent = 0;
let stageKey = '';
let questionKey = '';
let lastTick = null;
let sending = 0;
let lastSent = '';
let insaneShow = null;
const boardIds = new Set();

function show(next) {
  const fresh = !room || room.rid !== next.rid || lastEvent === 0;
  room = next;
  if (fresh) lastEvent = room.eventId;
  render();
  handleEvents();
}

const mySeat = () => (room?.seats ?? []).findIndex((p) => p.id === me.id);
const seatEl = (seat) => $('seats').children[seat];
const nameOf = (seat) => (room.seats[seat]?.id === me.id ? 'you' : room.seats[seat]?.name ?? 'someone');

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

function setFeedback(text, tone) {
  const node = $('feedback');
  node.textContent = text;
  node.className = tone ? `feedback is-${tone}` : 'feedback';
}

function pickScreen() {
  if (!room || (!me.active && !solo)) return 'front';
  if (room.phase === 'game') return 'game';
  if (room.phase === 'over') return 'results';
  return 'front';
}

function render() {
  if (solo && room?.phase === 'lobby') {
    stopHosting();
    solo = false;
    role = null;
    room = null;
  }
  const next = pickScreen();
  if (next !== screen) {
    screen = next;
    ['front', 'game', 'results'].forEach((id) => {
      $(id).hidden = id !== next;
    });
    stageKey = '';
    window.scrollTo(0, 0);
  }
  $('conn').hidden = !(me.active && (status === 'offline' || (status === 'connecting' && room)));
  if (screen === 'front') renderFront();
  else if (screen === 'game') renderGame();
  else renderResults();
}

/* ---------- Front and lobby ---------- */

function renderFront() {
  const joining = me.active && !room;
  const inLobby = Boolean(me.active && room && room.phase === 'lobby');
  const notice = $('notice');
  notice.textContent = joining ? (status === 'offline' ? 'Can’t reach the game relay. Still trying.' : 'Joining the room') : '';
  notice.hidden = !notice.textContent;
  notice.classList.toggle('is-error', joining && status === 'offline');

  $('joinForm').hidden = me.active;
  $('soloBtn').hidden = me.active;
  $('joinError').textContent = joinError;
  if (!me.active && !$('nameInput').value && me.name && document.activeElement !== $('nameInput')) $('nameInput').value = me.name;
  $('lobbyActions').hidden = !inLobby;
  $('roomSection').hidden = !inLobby;
  if (!inLobby) return;

  const here = new Set(room.here ?? []);
  const people = room.roster.filter((p) => p.id === me.id || here.has(p.id));
  renderRoster(people);
  $('roomCount').textContent = String(people.length);
  $('roomEmpty').hidden = people.length > 0;
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

/* ---------- Game ---------- */

function renderGame() {
  const gameKey = `${room.rid}:${room.game}`;
  if (shownGame !== gameKey) {
    shownGame = gameKey;
    $('seats').replaceChildren();
    $('board').replaceChildren();
    boardIds.clear();
    questionKey = '';
    stageKey = '';
    setFeedback('');
  }
  renderSeats();
  const progress = `Question ${room.qi + 1} of ${room.qCount}`;
  $('progress').textContent = room.pass > 0 ? `${progress}, overtime` : progress;
  const key = `${room.rid}:${room.game}:${room.played}`;
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
      ...room.seats.map((p) => {
        const node = make('div', 'seat');
        node.append(avatar(p, 'seat'), make('span', 'seat__name'), make('span', room.mode === 'solo' ? 'seat__score' : 'hearts'));
        return node;
      }),
    );
    stageKey = '';
  }
  room.seats.forEach((p, i) => {
    const node = seatEl(i);
    node.classList.toggle('is-out', p.out);
    node.classList.toggle('is-me', p.id === me.id);
    node.classList.toggle('is-away', !p.out && Array.isArray(room.here) && !room.here.includes(p.id));
    node.querySelector('.seat__name').textContent = p.id === me.id ? 'You' : p.name;
    if (room.mode === 'solo') {
      const score = node.querySelector('.seat__score');
      if (score.textContent !== String(p.score)) {
        score.textContent = String(p.score);
        score.animate([{ transform: 'scale(1.4)' }, { transform: 'none' }], { duration: 400, easing: 'ease-out' });
      }
      return;
    }
    const hearts = node.querySelector('.hearts');
    hearts.replaceChildren(...Array.from({ length: p.maxHearts }, (_, h) => heartIcon(h < p.hearts)));
    hearts.setAttribute('aria-label', p.out ? 'Out' : `${p.hearts} of ${p.maxHearts} hearts`);
  });
}

function renderBoard() {
  const board = $('board');
  for (const entry of room.round?.found ?? []) {
    if (boardIds.has(entry.id)) continue;
    boardIds.add(entry.id);
    const finder = room.seats[entry.seat] ?? { name: '?', color: 0 };
    const li = make('li', 'found');
    li.dataset.tier = entry.tier;
    li.title = `${finder.name}, ${tierName(entry.tier)}`;
    li.append(avatar(finder, 'xs'), make('span', 'found__label', entry.label));
    board.prepend(li);
    li.animate([{ opacity: 0, transform: 'scale(.7)' }, { opacity: 1, transform: 'scale(1.06)', offset: 0.7 }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
  }
}

function listNames(seats) {
  const names = seats.map((seat) => (room.seats[seat]?.id === me.id ? 'You' : room.seats[seat]?.name ?? 'Someone'));
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function recapReason(st) {
  const missed = st.failed ?? [];
  const outNow = missed.filter((seat) => room.seats[seat]?.out && room.seats[seat]?.outAt === room.played);
  let text = '';
  if (room.mode === 'solo') {
    if (st.reason === 'cleared') return 'Board cleared. You found every answer.';
    if (st.reason === 'skipped') return 'Moved on.';
    if (st.reason === 'long') return 'That is plenty for this one.';
    return 'Time\u2019s up.';
  }
  if (st.reason === 'missed') text = `${listNames(missed)} ran out of time.`;
  else if (st.reason === 'cleared') text = 'Every answer on the board was found.';
  else if (st.reason === 'low') text = 'Not enough answers left to go around.';
  else if (st.reason === 'long') text = 'Five full circles without a miss. On to the next one.';
  else if (st.reason === 'standing') text = 'Only one player is left.';
  else text = 'Nobody could take a turn.';
  if (outNow.length) {
    const plural = outNow.length > 1 || room.seats[outNow[0]]?.id === me.id;
    text += ` ${listNames(outNow)} ${plural ? 'are' : 'is'} out.`;
  }
  return text;
}

function fillRecap(st) {
  $('recapReason').textContent = recapReason(st);
  const rows = (st.reveal ?? []).map((row) => {
    const section = make('section', 'tier-row');
    const head = make('div', 'tier-row__head');
    const pill = make('span', 'pill', tierName(row.tier));
    pill.dataset.tier = row.tier;
    const count = row.total === null ? `${row.found.length} found` : `${row.found.length} of ${row.total} found`;
    head.append(pill, make('span', 'tier-row__count', count));
    const chips = make('div', 'chips');
    row.found.forEach((f) => {
      const chip = make('span', 'chip is-found');
      chip.dataset.tier = row.tier;
      chip.append(avatar(room.seats[f.seat] ?? { name: '?', color: 0 }, 'xs'), make('span', null, f.label));
      chips.append(chip);
    });
    row.missing.forEach((label) => chips.append(make('span', 'chip', label)));
    if (row.more) chips.append(make('span', 'chip chip--more', `${row.more} more`));
    section.append(head, chips);
    return section;
  });
  $('reveal').replaceChildren(...rows);
  const next = $('nextBtn');
  next.textContent = st.final ? (room.mode === 'solo' ? 'See your score' : 'See who won') : 'Next question';
  next.disabled = true;
}

/** The stage to show now. A turn the host already planned starts on time without waiting for it. */
function derive(now) {
  const st = room?.stage;
  if (!st || room.phase !== 'game') return null;
  if (now < st.until) return st;
  if ((st.kind === 'resolve' || st.kind === 'insane') && st.next?.kind === 'turn') {
    return { kind: 'turn', seat: st.next.seat, from: st.until, until: st.until + room.turnMs, predicted: true };
  }
  if (st.kind === 'intro') return { kind: 'turn', seat: st.seat, from: st.until, until: st.until + room.turnMs, predicted: true };
  return st;
}

function onStage(st) {
  const game = $('game');
  const kind = st?.kind ?? '';
  game.dataset.stage = kind;
  if (kind !== 'insane' && insaneShow) {
    insaneShow.close();
    insaneShow = null;
  }

  const recap = kind === 'round';
  $('playArea').hidden = recap;
  $('recap').hidden = !recap;
  if (recap) fillRecap(st);
  const soloTurn = room.mode === 'solo' && room.seats[0]?.id === me.id && (kind === 'turn' || kind === 'intro');
  $('skipBtn').hidden = !soloTurn;

  const activeSeat = ['intro', 'turn', 'resolve', 'insane'].includes(kind) ? st.seat : -1;
  [...$('seats').children].forEach((node, i) => node.classList.toggle('is-active', i === activeSeat));

  const player = room.seats[st?.seat];
  const mine = Boolean(player) && player.id === me.id;
  game.dataset.mine = mine ? 'yes' : 'no';
  const input = $('answer');
  const canType = kind === 'turn' && mine;
  input.disabled = !canType;
  $('sendBtn').disabled = !canType;

  if (player && (kind === 'intro' || kind === 'turn')) {
    $('turnName').textContent = kind === 'intro' ? (mine ? 'You go first' : `${player.name} goes first`) : mine ? 'Your turn' : `${player.name}’s turn`;
    $('turnAvatar').replaceWith(Object.assign(avatar(player), { id: 'turnAvatar' }));
    $('turn').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
  }

  const seat = mySeat();
  if (seat < 0) input.placeholder = 'You’re in for the next game';
  else if (room.seats[seat].out) input.placeholder = 'You’re out. Watch the rest';
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
  if (!st) return;
  const fill = $('timerFill');
  const num = $('timerNum');
  const game = $('game');
  if (st.kind === 'turn' || st.kind === 'round') {
    const total = st.until - st.from;
    const left = Math.max(0, Math.min(total, st.until - now));
    const ratio = total > 0 ? left / total : 0;
    fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    num.textContent = String(Math.ceil(left / 1000));
    if (st.kind === 'round') {
      game.dataset.timer = 'idle';
      $('nextBtn').disabled = now < st.from + engine.RULES.roundMinMs;
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
    num.textContent = String(Math.round(room.turnMs / 1000));
  }
}

function frame() {
  requestAnimationFrame(frame);
  if (screen !== 'game' || !room) return;
  const now = clock();
  const st = derive(now);
  const key = st ? `${room.game}:${room.played}:${st.kind}:${st.seat ?? ''}:${st.from}` : 'none';
  if (key !== stageKey) {
    stageKey = key;
    onStage(st);
  }
  drawTimer(st, now);
}

/* ---------- Moments everyone sees ---------- */

function inputCenter() {
  const r = $('answer').getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

function stamp(label, tone, points) {
  const node = $('stamp');
  node.dataset.tier = tone;
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
  fx.burst(r.left + r.width / 2, r.top + r.height / 2, { colors: [css('--heart'), css('--fg')], count: 16, speed: 4.5, size: [3, 7], life: [25, 45] });
  const ghost = heartIcon(true);
  Object.assign(ghost.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: 50, pointerEvents: 'none' });
  document.body.append(ghost);
  ghost
    .animate(
      [
        { transform: 'scale(1) rotate(0)', opacity: 1 },
        { transform: 'scale(2.6) rotate(-12deg)', opacity: 1, offset: 0.3 },
        { transform: 'translateY(44px) scale(1.4) rotate(25deg)', opacity: 0 },
      ],
      { duration: 760, easing: 'cubic-bezier(.3,.6,.4,1)' },
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

function prettify(text) {
  const forms = { mr: 'Mr.', mrs: 'Mrs.', ms: 'Ms.', dr: 'Dr.' };
  return String(text)
    .split(' ')
    .filter(Boolean)
    .map((w) => forms[w.toLowerCase().replace(/\./g, '')] ?? (w.length >= 5 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function handleEvents() {
  const fresh = room.events.filter((e) => e.id > lastEvent);
  lastEvent = Math.max(lastEvent, room.eventId);
  const now = clock();
  for (const e of fresh) {
    if (now - e.t > 8000 || screen === 'front') continue;
    onEvent(e, now);
  }
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
      } else shake($('feedback'), 5, 280);
      sound.wrong();
      break;
    }
    case 'hit': {
      const rank = tierRank(e.tier);
      stamp(tierName(e.tier), e.tier, room.mode === 'solo' ? e.points : 0);
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
      break;
    }
    case 'insane': {
      if (mine) $('answer').value = '';
      if (now - e.t > 6000 || !player) break;
      $('answer').blur();
      insaneShow = playInsane({
        answer: prettify(e.text),
        player: { name: player.name, initials: initials(player.name), color: player.color % 8 },
        fx,
        sound,
        origin: inputCenter(),
        scene: $('game'),
        canContinueAt: Math.max(0, e.t + engine.RULES.insaneMinMs - now),
        onContinue: () => act('continue'),
      });
      break;
    }
    case 'timeout': {
      stamp('Time’s up', 'miss');
      if (room.mode === 'solo') {
        sound.timeout();
        break;
      }
      breakHeart(e.seat);
      const who = mine ? 'You' : player?.name ?? 'Someone';
      if (e.out) setFeedback(`${who} ${mine ? 'are' : 'is'} out`, 'error');
      else setFeedback(`${who} ${mine ? 'lose' : 'loses'} a heart`, 'error');
      shake($('stage'), 8);
      sound.timeout();
      if (mine) navigator.vibrate?.([80, 60, 80]);
      break;
    }
    case 'overtime':
      setFeedback('Overtime. Turns are shorter now.');
      break;
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

function celebrate() {
  const colors = TIERS.map((t) => tierColor(t.id));
  [0, 260, 520].forEach((d, i) => {
    setTimeout(() => fx.burst(window.innerWidth * (0.25 + i * 0.25), window.innerHeight * 0.22, { colors, count: 60, speed: 12, gravity: 0.25, life: [70, 120] }), d);
  });
}

/* ---------- Results ---------- */

/** Everything typed in a solo run, grouped by question, ready to paste back to Claude. */
function exportText() {
  const p = room.seats[0];
  const lines = [`Yo UnCrillion solo run, ${new Date().toLocaleDateString()}`, `Score: ${p.score}`, ''];
  const groups = [
    ['hit', 'Accepted'],
    ['miss', 'Not on the board'],
    ['used', 'Already said'],
    ['random', 'Looked like gibberish'],
    ['blocked', 'Blocked'],
  ];
  for (let qi = 0; qi < room.qCount; qi++) {
    const tries = room.log.filter((l) => l.qi === qi);
    if (!tries.length) continue;
    lines.push(`${qi + 1}. ${bank?.[qi]?.prompt ?? `Question ${qi + 1}`}`);
    for (const [verdict, title] of groups) {
      const items = tries.filter((l) => l.verdict === verdict);
      if (!items.length) continue;
      const bare = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
      const shown = items.map((l) => (verdict === 'hit' ? `${l.text} (${tierName(l.tier)}${l.label && bare(l.label) !== bare(l.text) ? `, counted as ${l.label}` : ''})` : l.text));
      lines.push(`${title}: ${shown.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

/** The high score from before this run, so a new record still reads as new after a redraw. */
let bestBefore = { key: '', best: 0 };
function previousBest() {
  const key = `${room.rid}:${room.game}`;
  if (bestBefore.key !== key) bestBefore = { key, best: Number(store.get(BEST_KEY)) || 0 };
  return bestBefore.best;
}

function renderSoloResults() {
  const p = room.seats[0];
  const best = previousBest();
  const record = p.score > best;
  if (record) store.set(BEST_KEY, p.score);
  $('winnerAvatar').hidden = true;
  $('winnerTitle').textContent = `${p.score} points`;
  $('winnerSub').textContent = record ? 'New high score' : `High score ${best}`;
  $('standings').replaceChildren(
    ...Array.from({ length: room.qCount }, (_, qi) => {
      const found = room.log.filter((l) => l.qi === qi && l.verdict === 'hit');
      const pts = found.reduce((sum, l) => sum + (TIERS.find((t) => t.id === l.tier)?.points ?? 0), 0);
      const li = make('li', 'solo-row');
      const q = make('div', 'solo-row__q');
      q.append(make('span', 'solo-row__prompt', bank?.[qi]?.prompt ?? `Question ${qi + 1}`), make('span', 'solo-row__meta', `${found.length} found`));
      li.append(make('span', 'standing__rank', String(qi + 1)), q, make('span', 'solo-row__pts', String(pts)));
      return li;
    }),
  );
  $('againBtn').hidden = !solo;
  $('exportBtn').hidden = false;
  $('lobbyBtn').textContent = solo ? 'Back to start' : 'Back to the room';
  $('lobbyBtn').className = solo ? 'btn btn--ghost btn--lg' : 'btn btn--primary btn--lg';
}

function renderResults() {
  if (room.mode === 'solo') {
    renderSoloResults();
    return;
  }
  $('againBtn').hidden = true;
  $('exportBtn').hidden = true;
  $('exportText').hidden = true;
  $('exportNote').textContent = '';
  $('lobbyBtn').textContent = 'Back to the room';
  $('lobbyBtn').className = 'btn btn--primary btn--lg';
  const rows = engine.standings(room);
  const winners = rows.filter((p) => p.rank === 1);
  const top = winners[0];
  if (!top) return;
  const solo = room.seats.length === 1;
  const tie = winners.length > 1;
  const iWon = winners.some((p) => p.id === me.id);
  $('winnerTitle').textContent = tie ? 'It’s a tie' : iWon ? 'You win' : `${top.name} wins`;
  if (solo) $('winnerSub').textContent = `You lasted ${room.played} question${room.played === 1 ? '' : 's'}`;
  else if (tie) $('winnerSub').textContent = `${listNames(winners.map((p) => p.seat))} went out together`;
  else $('winnerSub').textContent = 'Last one standing';
  const big = $('winnerAvatar');
  big.textContent = initials(top.name);
  big.style.setProperty('--c', `var(--p${(top.color % 8) + 1})`);
  big.hidden = tie;

  $('standings').replaceChildren(
    ...rows.map((p) => {
      const li = make('li', p.id === me.id ? 'standing is-me' : 'standing');
      const who = make('div', 'standing__who');
      who.append(make('span', 'standing__name', p.id === me.id ? `${p.name} (you)` : p.name));
      const line = make('div', 'standing__best');
      const best = [...p.finds].sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];
      if (best) {
        const pill = make('span', 'pill pill--sm', tierName(best.tier));
        pill.dataset.tier = best.tier;
        line.append(pill, make('span', null, best.label));
      } else line.append(make('span', null, 'No answers found'));
      who.append(line);
      const status = p.out ? `Out on question ${p.outAt}` : p.rank === 1 ? 'Winner' : `${p.hearts} left`;
      li.append(make('span', 'standing__rank', String(p.rank)), avatar(p, 'lg'), who, make('span', 'standing__status', status));
      return li;
    }),
  );
}

/* ---------- Controls ---------- */

$('joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sound.unlock();
  const name = engine.cleanName($('nameInput').value);
  if (!name) {
    joinError = 'Type your name first';
    renderFront();
    $('nameInput').focus();
    return;
  }
  $('nameInput').blur();
  joinRoom(name);
});

$('startBtn').addEventListener('click', () => {
  sound.unlock();
  act('start');
});
$('leaveBtn').addEventListener('click', leaveRoom);
$('nextBtn').addEventListener('click', () => {
  $('nextBtn').disabled = true;
  act('next');
});
$('lobbyBtn').addEventListener('click', () => (solo ? exitSolo() : act('lobby')));
$('skipBtn').addEventListener('click', () => act('skip'));
$('soloBtn').addEventListener('click', () => {
  const name = engine.cleanName($('nameInput').value);
  if (name) {
    me.name = name;
    saveMe();
  }
  startSolo();
});
$('againBtn').addEventListener('click', () => {
  $('exportText').hidden = true;
  $('exportNote').textContent = '';
  startSolo();
});
$('exportBtn').addEventListener('click', async () => {
  const text = exportText();
  const box = $('exportText');
  box.value = text;
  try {
    await navigator.clipboard.writeText(text);
    $('exportNote').textContent = 'Copied. Paste it to Claude to add answers to the bank.';
  } catch {
    box.hidden = false;
    box.focus();
    box.select();
    $('exportNote').textContent = 'Select all and copy it from here.';
  }
});
$('answer').addEventListener('input', () => $('answerForm').classList.remove('is-wrong'));
$('answerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('answer');
  const text = input.value.trim();
  if (!text || input.disabled || (text === lastSent && Date.now() - sending < 600)) return;
  sending = Date.now();
  lastSent = text;
  act('answer', { text });
});

const soundBtn = $('soundBtn');
const syncSoundButton = () => soundBtn.setAttribute('aria-pressed', String(sound.enabled));
soundBtn.addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  if (sound.enabled) sound.unlock();
  store.set(SOUND_KEY, sound.enabled);
  syncSoundButton();
});

document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
document.addEventListener('keydown', (e) => {
  if (insaneShow?.ready && ['Enter', ' ', 'Escape'].includes(e.key)) {
    e.preventDefault();
    $('insaneGo').click();
  }
});
window.addEventListener('pagehide', () => relay?.stop());
window.addEventListener('pageshow', (e) => {
  if (e.persisted && me.active && me.name) joinRoom(me.name);
});

syncSoundButton();
loadBank().catch(() => {});
render();
if (me.active && me.name) joinRoom(me.name);
requestAnimationFrame(frame);
