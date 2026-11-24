// Where the room lives. On Vercel that is Upstash Redis over its REST API; locally it is memory.
import { emptyRoom } from './engine.js';

const ROOM = 'yuc:room';
const VERSION = 'yuc:room:v';
const HERE = 'yuc:here';
const TTL = String(60 * 60 * 24 * 3);

// Save only if nobody else saved first. Two phones can never overwrite each other's move.
const SAVE_IF_UNCHANGED = `
local current = redis.call('GET', KEYS[2])
if (current or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
return 1`;

const parse = (raw) => {
  if (!raw) return emptyRoom();
  try {
    return JSON.parse(raw);
  } catch {
    return emptyRoom();
  }
};

const pairs = (raw) => {
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  const out = {};
  for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1];
  return out;
};

/** Find the REST credentials the Vercel Upstash integration adds, whatever prefix was chosen. */
export function restConfig(env) {
  const known = [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ];
  for (const [u, t] of known) if (env[u] && env[t]) return { url: env[u].replace(/\/$/, ''), token: env[t] };
  for (const name of Object.keys(env)) {
    const m = name.match(/^(.*)_(KV_REST_API|REST_API|REDIS_REST)_URL$/);
    if (!m) continue;
    const token = env[`${m[1]}_${m[2]}_TOKEN`];
    if (env[name] && token) return { url: env[name].replace(/\/$/, ''), token };
  }
  return null;
}

/** Returns null when deployed without a database, so the API can say what is missing. */
export function openStore(env = process.env) {
  const config = restConfig(env);
  if (config) return upstash(config);
  return env.VERCEL ? null : memory();
}

function upstash({ url, token }) {
  async function send(path, body) {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data === null) throw new Error(`Redis ${res.status}${data?.error ? `: ${data.error}` : ''}`);
    return data;
  }
  const run = async (command) => {
    const data = await send('', command);
    if (data.error) throw new Error(data.error);
    return data.result;
  };
  const batch = async (commands) => {
    const data = await send('/pipeline', commands);
    return data.map((item) => {
      if (item.error) throw new Error(item.error);
      return item.result;
    });
  };

  return {
    kind: 'upstash',
    async load({ presence = false, touch = null } = {}) {
      const commands = [['GET', ROOM]];
      if (presence) commands.push(['HGETALL', HERE]);
      if (touch) commands.push(['HSET', HERE, touch.id, String(touch.at)]);
      const out = commands.length === 1 ? [await run(commands[0])] : await batch(commands);
      return { state: parse(out[0]), presence: presence ? pairs(out[1]) : null };
    },
    async save(state, prevVersion) {
      const ok = await run(['EVAL', SAVE_IF_UNCHANGED, '2', ROOM, VERSION, String(prevVersion), JSON.stringify(state), String(state.v), TTL]);
      return Number(ok) === 1;
    },
    async touch(id, at) {
      await batch([['HSET', HERE, id, String(at)], ['EXPIRE', HERE, TTL]]);
    },
  };
}

function memory() {
  let raw = null;
  let version = 0;
  const here = {};
  return {
    kind: 'memory',
    async load({ presence = false, touch = null } = {}) {
      if (touch) here[touch.id] = String(touch.at);
      return { state: parse(raw), presence: presence ? { ...here } : null };
    },
    async save(state, prevVersion) {
      if (version !== prevVersion) return false;
      raw = JSON.stringify(state);
      version = state.v;
      return true;
    },
    async touch(id, at) {
      here[id] = String(at);
    },
  };
}
