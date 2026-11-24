// Drives the real API handler against the in-memory store, the way phones would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST } from '../api/room.js';

const base = 'http://localhost/api/room';
const post = async (body) => (await POST(new Request(base, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))).json();
const get = async (params) => (await GET(new Request(`${base}?${new URLSearchParams(params)}`))).json();
const pid = (n) => `player-${n}-xxxxxxxx`;

test('six phones joining at once all get in', async () => {
  const names = ['Sar', 'Balaji', 'Pranav', 'Jo', 'Shalav', 'Eshan'];
  const replies = await Promise.all(names.map((n) => post({ action: 'join', pid: pid(n), name: n })));
  replies.forEach((r) => assert.equal(r.error, null));
  const poll = await get({ pid: pid('Sar'), v: '-1', lobby: '1', beat: '1' });
  assert.equal(poll.state.roster.length, 6);
  assert.equal(poll.here.length, 6);
  assert.equal(poll.state.v, 6);
});

test('a game runs through the API', async () => {
  const start = await post({ action: 'start', pid: pid('Sar') });
  assert.equal(start.error, null);
  assert.equal(start.state.phase, 'game');
  assert.equal(start.state.seats.length, 6);
  const early = await post({ action: 'answer', pid: pid('Sar'), text: 'gaga' });
  assert.match(early.error, /your turn/);
  const same = await get({ pid: pid('Jo'), v: String(start.v) });
  assert.equal(same.state, null);
  assert.equal(typeof same.now, 'number');
});

test('unknown moves and bad ids are refused', async () => {
  assert.equal((await post({ action: 'explode', pid: pid('Sar') })).error, 'bad-request');
  assert.equal((await post({ action: 'join', pid: 'x', name: 'Hi' })).error, 'bad-request');
});
