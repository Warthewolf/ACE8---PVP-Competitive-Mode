'use strict';
// The two PCs' link (relay-only Steam P2P): each pilot's mod posts its own SteamID64 for the match; only the
// opponent sees it.
const test = require('node:test');
const assert = require('node:assert');
const { setup, log, mirror } = require('./helpers');

const HOST_ID = '76561190000000101';
const GUEST_ID = '76561190000000202';

async function pair(env) {
  const a = await env.register('Trigger'); const b = await env.register('Mihaly');
  for (const p of [a, b]) {
    const s = await p.call('POST', '/api/integrity/report', env.cleanReport());
    await p.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region: 'eu' });
  }
  const sa = await a.call('GET', '/api/queue/status');
  const host = sa.match.role === 'host' ? a : b;
  const guest = host === a ? b : a;
  return { id: sa.match.id, host, guest };
}

const status = async (p, method, path, body) => {
  try { await p.call(method, path, body); return 200; } catch (e) { return e.status; }
};

test('link: each pilot posts its SteamID; each sees the other\'s, nobody else sees either; the host\'s post opens the match', async () => {
  const env = await setup();
  try {
    const { id, host, guest } = await pair(env);
    let h = await host.call('GET', `/api/matches/${id}`);
    assert.deepEqual(h.link, { self: null, peer: null });
    assert.equal(h.state, 'pending');
    const g1 = await guest.call('POST', `/api/matches/${id}/link`, { steamId: GUEST_ID });
    assert.deepEqual(g1.link, { self: GUEST_ID, peer: null });
    assert.equal(g1.state, 'pending', 'the guest\'s post alone does not open the match');
    const h1 = await host.call('POST', `/api/matches/${id}/link`, { steamId: HOST_ID });
    assert.deepEqual(h1.link, { self: HOST_ID, peer: GUEST_ID });
    assert.equal(h1.state, 'live', 'the host\'s post opens the match');
    const g2 = await guest.call('GET', `/api/matches/${id}`);
    assert.deepEqual(g2.link, { self: GUEST_ID, peer: HOST_ID });
    // a third pilot and the public views see no link
    const c = await env.register('Pixy');
    const other = await c.call('GET', `/api/matches/${id}`);
    assert.equal(other.link, undefined);
    const pub = await (await fetch(`${env.url}/api/matches?limit=50`)).text();
    assert.ok(!pub.includes(HOST_ID) && !pub.includes(GUEST_ID), 'no SteamID in the public match list');
    assert.equal(await status(c, 'POST', `/api/matches/${id}/link`, { steamId: '76561190000000303' }), 403);
    // the same id again is fine (a restarted mod); another is refused
    assert.equal(await status(host, 'POST', `/api/matches/${id}/link`, { steamId: HOST_ID }), 200);
    assert.equal(await status(host, 'POST', `/api/matches/${id}/link`, { steamId: '76561190000000909' }), 409);
  } finally { await env.close(); }
});

test('link: only a SteamID64, never both pilots on one account, never after the match', async () => {
  const env = await setup();
  try {
    const { id, host, guest } = await pair(env);
    for (const bad of ['', '123', '7656119000000010', '765611900000001010', '86561190000000101', 'abc', null, 76561190000000101, { x: 1 }]) {
      assert.equal(await status(host, 'POST', `/api/matches/${id}/link`, { steamId: bad }), 400, `refused: ${JSON.stringify(bad)}`);
    }
    await host.call('POST', `/api/matches/${id}/link`, { steamId: HOST_ID });
    assert.equal(await status(guest, 'POST', `/api/matches/${id}/link`, { steamId: HOST_ID }), 400, 'one Steam account for both');
    assert.equal(await status(guest, 'POST', '/api/matches/nope/link', { steamId: GUEST_ID }), 404);
    await guest.call('POST', `/api/matches/${id}/link`, { steamId: GUEST_ID });
    await host.call('POST', `/api/matches/${id}/report`, log());
    await guest.call('POST', `/api/matches/${id}/report`, mirror());
    const m = await host.call('GET', `/api/matches/${id}`);
    assert.notEqual(m.state, 'live');
    assert.equal(await status(guest, 'POST', `/api/matches/${id}/link`, { steamId: GUEST_ID }), 409, 'no link once the match is over');
  } finally { await env.close(); }
});
