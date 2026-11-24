// Talks to /api/room: who you are, a clock synced to the server, polling and moves.

const ME_KEY = 'yuc.me';

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** This browser's player id and last used name. */
export function loadMe() {
  try {
    const saved = JSON.parse(localStorage.getItem(ME_KEY));
    if (saved && typeof saved.id === 'string' && saved.id.length >= 8) return saved;
  } catch {
    /* storage can be unavailable */
  }
  const me = { id: makeId(), name: '' };
  saveMe(me);
  return me;
}

export function saveMe(me) {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    /* fine, it just will not be remembered */
  }
}

// Server clock: keep the offset from the fastest round trip seen, so timers agree across phones.
let offset = 0;
let bestTrip = Infinity;

function sync(sentAt, serverTime) {
  const back = Date.now();
  const trip = back - sentAt;
  bestTrip = Math.min(bestTrip + 2, trip);
  if (trip <= bestTrip + 25) offset = serverTime + trip / 2 - back;
}

export const serverNow = () => Date.now() + offset;

/**
 * Opens the room connection.
 *   onState(state, here)  a newer room, and in the lobby the ids of people present
 *   onStatus(status)      'ok', 'offline' or 'setup'
 */
export function connect({ me, onState, onStatus }) {
  let version = -1;
  let timer = 0;
  let lastBeat = 0;
  let failures = 0;
  let lobby = true;
  let wakeAt = null;
  let inFlight = false;

  function accept(data) {
    if (typeof data.now === 'number') onStatus('ok');
    if (data.state && data.v >= version) {
      version = data.v;
      onState(data.state, data.here ?? null);
    } else if (data.here) {
      onState(null, data.here);
    }
  }

  async function poll() {
    clearTimeout(timer);
    if (inFlight) return;
    inFlight = true;
    const beat = Date.now() - lastBeat > 4000;
    const query = new URLSearchParams({ pid: me.id, v: String(version) });
    if (lobby) query.set('lobby', '1');
    if (beat) query.set('beat', '1');
    const sent = Date.now();
    try {
      const res = await fetch(`/api/room?${query}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.message || `HTTP ${res.status}`), { code: data.error });
      if (beat) lastBeat = sent;
      sync(sent, data.now);
      failures = 0;
      accept(data);
    } catch (err) {
      failures += 1;
      onStatus(err.code === 'setup' ? 'setup' : 'offline');
    } finally {
      inFlight = false;
      schedule();
    }
  }

  function schedule() {
    clearTimeout(timer);
    let wait = failures ? Math.min(8000, 700 * 2 ** failures) : document.hidden ? 4000 : lobby ? 1500 : 800;
    if (wakeAt !== null && !failures) {
      const until = wakeAt - serverNow() + 120;
      if (until > 0 && until < wait) wait = until;
    }
    timer = setTimeout(poll, wait);
  }

  /** Make a move. Resolves with the server reply, or { error } when offline. */
  async function act(action, extra = {}) {
    const sent = Date.now();
    try {
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, pid: me.id, ...extra }),
      });
      const data = await res.json();
      if (data.now) sync(sent, data.now);
      if (data.error === 'setup') onStatus('setup');
      accept(data);
      return data;
    } catch {
      onStatus('offline');
      return { error: 'offline', message: 'Could not reach the room. Check your connection.' };
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });

  return {
    act,
    poll,
    setLobby(flag) {
      lobby = flag;
    },
    /** Poll again just after this server time, so stage changes show up promptly. */
    wakeAt(t) {
      wakeAt = t;
      if (!inFlight) schedule();
    },
  };
}
