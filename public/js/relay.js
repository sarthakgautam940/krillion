// Network layer, ported from spelling-race. Phones talk through public MQTT brokers over secure
// WebSockets, so there is no server and nothing to set up. The earliest player present is the host:
// it runs the game and broadcasts the room, everyone else sends their moves to it. If the host
// leaves, the next player in line takes over with the last room they saw.

const perf = () => performance.now();
const te = new TextEncoder();
const td = new TextDecoder();

/** Timers that keep running on time even when the tab is in the background. */
export const Timers = (() => {
  let worker = null;
  let seq = 0;
  const cbs = new Map();
  try {
    const src =
      'const t=new Map();onmessage=e=>{const d=e.data;if(d.c){clearTimeout(t.get(d.c));t.delete(d.c);return}' +
      'if(d.i){const id=d.i;t.set(id,setTimeout(()=>{t.delete(id);postMessage(id)},d.ms))}};';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const fn = cbs.get(e.data);
      if (fn) {
        cbs.delete(e.data);
        fn();
      }
    };
  } catch {
    worker = null;
  }
  const api = {
    after(ms, fn) {
      const id = ++seq;
      if (!worker) {
        cbs.set(`h${id}`, setTimeout(fn, ms));
        return id;
      }
      cbs.set(id, fn);
      worker.postMessage({ i: id, ms });
      return id;
    },
    clear(id) {
      if (!id) return;
      if (!worker) {
        clearTimeout(cbs.get(`h${id}`));
        cbs.delete(`h${id}`);
        return;
      }
      if (cbs.delete(id)) worker.postMessage({ c: id });
    },
    every(ms, fn) {
      let id;
      let stopped = false;
      const loop = () => {
        if (stopped) return;
        fn();
        id = api.after(ms, loop);
      };
      id = api.after(ms, loop);
      return () => {
        stopped = true;
        api.clear(id);
      };
    },
  };
  return api;
})();

/* ---------- Minimal MQTT 3.1.1 client over WebSocket (QoS 0) ---------- */

const mstr = (s) => {
  const b = te.encode(s);
  const o = new Uint8Array(2 + b.length);
  o[0] = b.length >> 8;
  o[1] = b.length & 255;
  o.set(b, 2);
  return o;
};
const varint = (n) => {
  const o = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 128;
    o.push(d);
  } while (n > 0);
  return Uint8Array.from(o);
};
const cat = (...parts) => {
  let n = 0;
  for (const x of parts) n += x.length;
  const o = new Uint8Array(n);
  let p = 0;
  for (const x of parts) {
    o.set(x, p);
    p += x.length;
  }
  return o;
};
const packet = (b0, body) => cat(Uint8Array.of(b0), varint(body.length), body);

function Mqtt(o) {
  const self = { open: false, url: o.url };
  const subs = new Set();
  let ws = null;
  let buf = new Uint8Array(0);
  let pid = 1;
  let stopPing = null;
  let closed = false;
  let retryT = 0;
  let tries = 0;

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(o.url, 'mqtt');
    } catch {
      later();
      return;
    }
    const sock = ws;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => {
      buf = new Uint8Array(0);
      const flags = 0x02 | (o.will ? 0x04 | 0x20 : 0); // clean session, retained will
      const client = mstr(o.clientId + Math.random().toString(36).slice(2, 6));
      const will = o.will ? [mstr(o.will.topic), Uint8Array.of(0, 0)] : [];
      sock.send(packet(0x10, cat(mstr('MQTT'), Uint8Array.of(4, flags, o.keepalive >> 8, o.keepalive & 255), client, ...will)));
    };
    sock.onmessage = (e) => {
      buf = cat(buf, new Uint8Array(e.data));
      parse(sock);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      if (self.open) {
        self.open = false;
        o.onClose?.();
      }
      if (stopPing) {
        stopPing();
        stopPing = null;
      }
      later();
    };
    sock.onerror = () => {};
  }

  function later() {
    if (closed) return;
    clearTimeout(retryT);
    retryT = setTimeout(connect, Math.min(8000, 700 * 1.6 ** tries++));
  }

  function parse(sock) {
    for (;;) {
      if (buf.length < 2) return;
      let len = 0;
      let mul = 1;
      let i = 1;
      let b;
      do {
        if (i >= buf.length) return;
        b = buf[i++];
        len += (b & 127) * mul;
        mul *= 128;
      } while (b & 128 && i < 5);
      if (buf.length < i + len) return;
      const b0 = buf[0];
      const body = buf.subarray(i, i + len);
      buf = buf.slice(i + len);
      const type = b0 >> 4;
      if (type === 2) {
        if (body[1] === 0) {
          tries = 0;
          self.open = true;
          if (subs.size) sock.send(subscribePacket([...subs]));
          if (!stopPing) {
            stopPing = Timers.every(Math.max(2000, o.keepalive * 500), () => {
              if (self.open) {
                try {
                  sock.send(Uint8Array.of(0xc0, 0));
                } catch {
                  /* reconnect handles it */
                }
              }
            });
          }
          o.onOpen?.();
        } else {
          try {
            sock.close();
          } catch {
            /* ignore */
          }
        }
      } else if (type === 3) {
        const qos = (b0 >> 1) & 3;
        const tl = (body[0] << 8) | body[1];
        const topic = td.decode(body.subarray(2, 2 + tl));
        const p = 2 + tl + (qos ? 2 : 0);
        o.onMessage?.(topic, td.decode(body.subarray(p)), Boolean(b0 & 1));
      }
    }
  }

  function subscribePacket(topics) {
    const id = pid++ & 0xffff || 1;
    return packet(0x82, cat(Uint8Array.of(id >> 8, id & 255), ...topics.map((t) => cat(mstr(t), Uint8Array.of(0)))));
  }

  self.subscribe = (topic) => {
    subs.add(topic);
    if (self.open) {
      try {
        ws.send(subscribePacket([topic]));
      } catch {
        /* resubscribed on reconnect */
      }
    }
  };
  self.unsubscribe = (topic) => {
    subs.delete(topic);
    if (!self.open) return;
    const id = pid++ & 0xffff || 1;
    try {
      ws.send(packet(0xa2, cat(Uint8Array.of(id >> 8, id & 255), mstr(topic))));
    } catch {
      /* ignore */
    }
  };
  self.publish = (topic, text, retain) => {
    if (!self.open) return false;
    try {
      ws.send(packet(0x30 | (retain ? 1 : 0), cat(mstr(topic), te.encode(text))));
      return true;
    } catch {
      return false;
    }
  };
  // Close without telling the broker, so it publishes our will.
  self.drop = () => {
    closed = true;
    clearTimeout(retryT);
    if (stopPing) {
      stopPing();
      stopPing = null;
    }
    self.open = false;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };
  connect();
  return self;
}

/* ---------- The room ---------- */

/**
 * cfg: { room, name, pid, brokers, max, debug, on: { status, role, welcome, hello, msg, guestLeft, hostLost, rejected } }
 *   hello(m, accept)   host only: a phone wants in. Call accept(ok, why, extra).
 *   msg(m, guest)      host: a move from guest { name, pid }. Guest: a message from the host.
 */
export function connectRelay(cfg) {
  // Until pings settle the clock, assume the host's clock matches this phone's.
  const self = { role: null, rtt: null, off: Date.now() - perf(), synced: false };
  const emit = (k, ...a) => cfg.on[k]?.(...a);
  const dbg = (...a) => {
    if (cfg.debug) console.log(`[relay ${Math.round(perf())}]`, ...a);
  };
  const me = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  const P = `uplevel-uncrillion/v1/${cfg.room}`;
  const tPres = `${P}/p/`;
  const tUp = `${P}/up`;
  const tAll = `${P}/dn/all`;
  const tMine = `${P}/dn/${me}`;

  const conns = [];
  const presence = [];
  const seen = new Set();
  const seenQ = [];
  const guests = new Map(); // host side: client id -> { name, pid, lastSeen, rtt }
  const samples = [];
  const dead = new Map();
  let seq = 0;
  let stopped = false;
  let settled = false;
  let mySince = 0;
  let evalT = 0;
  let host = null;
  let joined = false;
  let pendingState = null;
  let helloStop = null;
  let helloStart = 0;
  let pingStop = null;
  let hostChk = null;
  let lastSeen = 0;
  let firstOpen = 0;
  let offlineT = 0;

  const nid = () => `${me}.${++seq}`;
  function pub(topic, env, retain) {
    const s = typeof env === 'string' ? env : JSON.stringify(env);
    for (const c of conns) c.publish(topic, s, retain);
  }
  const open = () => conns.some((c) => c.open);

  /* ----- Presence and election ----- */
  function union() {
    const u = new Map();
    for (const m of presence) {
      for (const [id, v] of m) {
        if (dead.has(id) && dead.get(id) > Date.now() && id !== me) continue;
        const cur = u.get(id);
        if (!cur || v.since < cur.since) u.set(id, v);
      }
    }
    return u;
  }
  function elected() {
    const u = union();
    if (settled && mySince) u.set(me, { since: mySince });
    let best = null;
    let bs = Infinity;
    for (const [id, v] of u) {
      if (v.since < bs || (v.since === bs && id < best)) {
        best = id;
        bs = v.since;
      }
    }
    return best;
  }
  const scheduleEval = () => {
    if (settled && !evalT) {
      evalT = setTimeout(() => {
        evalT = 0;
        evaluate();
      }, 120);
    }
  };

  function evaluate() {
    if (stopped || !settled) return;
    const h = elected();
    if (h === host) return;
    dbg('elected', h, h === me ? '(me)' : '');
    if (self.role === 'host' && h !== me) stepDown();
    else if (joined) {
      joined = false;
      self.role = null;
      stopGuest();
      emit('hostLost');
    }
    stopHello();
    pendingState = null;
    host = h;
    if (!h) return;
    if (h === me) becomeHost();
    else startJoin();
  }

  function stepDown() {
    for (const c of conns) c.unsubscribe(tUp);
    if (hostChk) {
      hostChk();
      hostChk = null;
    }
    guests.clear();
    self.role = null;
    self.synced = false;
    self.rtt = null;
    samples.length = 0;
    emit('hostLost');
  }
  function stopGuest() {
    if (pingStop) {
      pingStop();
      pingStop = null;
    }
    self.synced = false;
    self.rtt = null;
    samples.length = 0;
  }
  function stopHello() {
    if (helloStop) {
      helloStop();
      helloStop = null;
    }
  }

  function becomeHost() {
    self.role = 'host';
    joined = false;
    for (const c of conns) c.subscribe(tUp);
    hostChk = Timers.every(1000, () => {
      for (const [id, g] of guests) {
        if (perf() - g.lastSeen > 7000) {
          guests.delete(id);
          emit('guestLeft', g);
        }
      }
    });
    emit('role', 'host');
    emit('status', 'online');
  }

  function startJoin() {
    helloStart = perf();
    const hello = () => {
      if (!host || host === me || joined) return;
      if (perf() - helloStart > 8000) {
        dead.set(host, Date.now() + 300000);
        dbg('host never answered, ignoring', host);
        stopHello();
        host = null;
        scheduleEval();
        return;
      }
      pub(tUp, { i: nid(), f: me, m: { t: 'hello', name: cfg.name, pid: cfg.pid } });
    };
    hello();
    helloStop = Timers.every(1000, hello);
  }

  /* ----- Messages ----- */
  function onMessage(k, topic, text) {
    if (topic.startsWith(tPres)) {
      const id = topic.slice(tPres.length);
      if (!text) presence[k].delete(id);
      else {
        try {
          presence[k].set(id, JSON.parse(text));
        } catch {
          return;
        }
      }
      scheduleEval();
      return;
    }
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      return;
    }
    if (!env || !env.m || !env.f || env.f === me) return;
    if (seen.has(env.i)) return;
    seen.add(env.i);
    seenQ.push(env.i);
    if (seenQ.length > 600) seen.delete(seenQ.shift());
    if (topic === tUp) {
      if (self.role === 'host') fromGuest(env);
      return;
    }
    if (env.x === me) return;
    if (env.f !== host) return; // only the elected host speaks to us
    fromHost(env.m);
  }

  function fromGuest(env) {
    const m = env.m;
    const f = env.f;
    const g = guests.get(f);
    if (m.t === 'hello') {
      if (g) {
        g.lastSeen = perf();
        sendTo(f, { t: 'welcome', name: g.name });
        return;
      }
      for (const [oid, og] of guests) {
        // the same player on a new connection: drop the old one
        if (og.pid === m.pid) {
          guests.delete(oid);
          emit('guestLeft', og);
        }
      }
      if (guests.size >= cfg.max - 1) {
        sendTo(f, { t: 'reject', why: 'full' });
        return;
      }
      emit('hello', m, (ok, why, extra) => {
        if (!ok) {
          sendTo(f, { t: 'reject', why });
          return;
        }
        guests.set(f, { name: extra?.name || m.name, pid: m.pid, lastSeen: perf(), rtt: null });
        sendTo(f, { t: 'welcome', ...(extra || {}) });
      });
      return;
    }
    if (!g) {
      // A phone we dropped while it was asleep is back: ask it to say hello again.
      if (m.t === 'ping') sendTo(f, { t: 'who' });
      return;
    }
    g.lastSeen = perf();
    if (m.t === 'ping') {
      g.rtt = m.rtt;
      sendTo(f, { t: 'pong', c: m.c, h: Date.now() });
      return;
    }
    emit('msg', m, g);
  }

  function fromHost(m) {
    lastSeen = perf();
    if (!joined) {
      if (m.t === 'welcome') {
        joined = true;
        stopHello();
        self.role = 'guest';
        lastSeen = perf();
        startPings();
        emit('welcome', m);
        emit('role', 'guest');
        emit('status', 'online');
        if (pendingState) {
          const ps = pendingState;
          pendingState = null;
          emit('msg', ps);
        }
      } else if (m.t === 'state') pendingState = m;
      else if (m.t === 'reject') {
        stopped = true;
        stopHello();
        emit('rejected', m.why);
        self.stop();
      }
      return;
    }
    if (m.t === 'pong') {
      onPong(m);
      return;
    }
    if (m.t === 'who') {
      joined = false;
      self.role = null;
      stopGuest();
      startJoin();
      return;
    }
    emit('msg', m);
  }

  function startPings() {
    let burst = 0;
    const ping = () => pub(tUp, { i: nid(), f: me, m: { t: 'ping', c: perf(), rtt: self.rtt } });
    ping();
    const fast = setInterval(() => {
      ping();
      if (++burst >= 10) clearInterval(fast);
    }, 150);
    const slow = Timers.every(1000, () => {
      ping();
      if (joined && perf() - lastSeen > 6000) {
        // the host went quiet: wait for the election to settle or for it to come back
        joined = false;
        self.role = null;
        stopGuest();
        emit('hostLost');
        startJoin();
      }
    });
    pingStop = () => {
      clearInterval(fast);
      slow();
    };
  }

  function onPong(m) {
    const t = perf();
    const rtt = t - m.c;
    samples.push({ rtt, off: m.h + rtt / 2 - t });
    if (samples.length > 14) samples.shift();
    let best = samples[0];
    for (const s of samples) if (s.rtt < best.rtt) best = s;
    self.off = best.off;
    self.synced = true;
    self.rtt = self.rtt == null ? rtt : self.rtt * 0.6 + rtt * 0.4;
  }

  function sendTo(id, m) {
    pub(`${P}/dn/${id}`, { i: nid(), f: me, m });
  }

  /* ----- Brokers ----- */
  function startBrokers() {
    cfg.brokers.forEach((url, k) => {
      presence[k] = new Map();
      const c = Mqtt({
        url,
        clientId: `yuc-${me}-${k}`,
        keepalive: 6,
        will: { topic: tPres + me },
        onOpen() {
          dbg('broker up', url);
          c.subscribe(`${tPres}+`);
          c.subscribe(tAll);
          c.subscribe(tMine);
          if (self.role === 'host') c.subscribe(tUp);
          if (self.role) emit('status', 'online');
          else if (firstOpen) emit('status', 'connecting');
          if (settled && mySince) c.publish(tPres + me, JSON.stringify({ since: mySince, n: cfg.name }), true);
          if (!firstOpen) {
            firstOpen = Date.now();
            clearTimeout(offlineT);
            emit('status', 'connecting');
            setTimeout(settle, 900); // collect everyone's retained presence before taking a place in line
          }
        },
        onClose() {
          dbg('broker down', url);
          presence[k].clear();
          if (!stopped && !open()) emit('status', 'offline');
        },
        onMessage: (topic, text) => onMessage(k, topic, text),
      });
      conns.push(c);
    });
    offlineT = setTimeout(() => {
      if (!firstOpen && !stopped) emit('status', 'offline');
    }, 7000);
  }

  function settle() {
    if (stopped || settled) return;
    let max = 0;
    for (const m of presence) for (const v of m.values()) if (v.since > max) max = v.since;
    mySince = Math.max(Date.now(), max + 1); // always behind whoever is already here
    pub(tPres + me, { since: mySince, n: cfg.name }, true);
    setTimeout(() => {
      settled = true;
      evaluate();
    }, 350);
  }

  /** Guest: send a move to the host. */
  self.send = (m) => {
    if (joined) pub(tUp, { i: nid(), f: me, m });
  };
  /** Host: send to every phone. */
  self.sendAll = (m) => pub(tAll, { i: nid(), f: me, m });
  /** Host: player ids connected right now, with when each was last heard from (wall clock ms). */
  self.online = () => {
    const out = {};
    const wall = Date.now();
    const t = perf();
    for (const g of guests.values()) if (g.pid) out[g.pid] = Math.max(out[g.pid] ?? 0, wall - (t - g.lastSeen));
    return out;
  };
  /** The host's wall clock, as seen from this phone. */
  self.hostNow = () => (self.role === 'host' ? Date.now() : perf() + self.off);
  function shutdown(clear) {
    stopped = true;
    clearTimeout(evalT);
    clearTimeout(offlineT);
    stopHello();
    stopGuest();
    if (hostChk) {
      hostChk();
      hostChk = null;
    }
    if (clear) pub(tPres + me, '', true);
    for (const c of conns) c.drop();
    conns.length = 0;
    guests.clear();
    self.role = null;
  }
  self.stop = () => shutdown(true);
  self.crash = () => shutdown(false);
  self.start = () => startBrokers();
  self.id = me;
  return self;
}
