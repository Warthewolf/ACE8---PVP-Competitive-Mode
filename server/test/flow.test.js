'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { setup, log, mirror } = require('./helpers');
const { seedOrder } = require('../src/tournaments');

async function queuePair(env, a, b) {
  for (const p of [a, b]) {
    const s = await p.call('POST', '/api/integrity/report', env.cleanReport());
    assert.equal(s.verdict, 'clean');
    await p.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region: 'eu' });
  }
  const sa = await a.call('GET', '/api/queue/status');
  const sb = await b.call('GET', '/api/queue/status');
  assert.equal(sa.state, 'matched'); assert.equal(sb.state, 'matched');
  assert.equal(sa.match.id, sb.match.id);
  const host = sa.match.role === 'host' ? a : b;
  const guest = host === a ? b : a;
  await host.call('POST', `/api/matches/${sa.match.id}/lobby`, { lobbyCode: 'ROOM1234' });
  const g = await guest.call('GET', `/api/matches/${sa.match.id}`);
  assert.equal(g.lobbyCode, 'ROOM1234');
  return { id: sa.match.id, host, guest };
}

test('full ranked flow: scan, queue, lobby, two agreeing logs, rating update', async () => {
  const env = await setup();
  try {
    const a = await env.register('Trigger'); const b = await env.register('Mihaly');
    const { id, host, guest } = await queuePair(env, a, b);
    const r1 = await host.call('POST', `/api/matches/${id}/report`, log());
    assert.equal(r1.state, 'awaiting_reports');
    const r2 = await guest.call('POST', `/api/matches/${id}/report`, mirror());
    assert.equal(r2.state, 'verified');
    assert.deepEqual(r2.score, { host: 5, guest: 2 });
    assert.ok(r2.ratingDelta.host > 0 && r2.ratingDelta.guest < 0);
    const lb = await (await fetch(env.url + '/api/leaderboard')).json();
    assert.equal(lb[0].id, host.id); assert.equal(lb[0].wins, 1); assert.equal(lb[0].kills, 5);
    // Lobby codes are private to participants.
    const pub = await (await fetch(`${env.url}/api/matches/${id}/public`)).json();
    assert.equal(pub.lobbyCode, undefined);
  } finally { await env.close(); }
});

test('disagreeing logs are disputed and do not change ratings', async () => {
  const env = await setup();
  try {
    const a = await env.register('Alpha1'); const b = await env.register('Bravo2');
    const { id, host, guest } = await queuePair(env, a, b);
    await host.call('POST', `/api/matches/${id}/report`, log({ k: 5, d: 0 }));
    const r = await guest.call('POST', `/api/matches/${id}/report`, mirror({ k: 3, d: 5 }));
    assert.equal(r.state, 'disputed');
    assert.ok(r.flags.some((f) => f.code === 'score_mismatch'));
    assert.equal((await a.call('GET', '/api/me')).rating, 1500);
    const resolved = await env.admin('POST', `/api/admin/matches/${id}/resolve`, { winner: 'guest', scoreHost: 3, scoreGuest: 5 });
    assert.equal(resolved.state, 'verified');
  } finally { await env.close(); }
});

test('speed anomaly seen in the opponent log flags the cheater', async () => {
  const env = await setup();
  try {
    const a = await env.register('Speedy'); const b = await env.register('Honest');
    const { id, host, guest } = await queuePair(env, a, b);
    await host.call('POST', `/api/matches/${id}/report`, log());
    // Guest saw the host's F-22 (max 2400) doing 3100 km/h.
    const r = await guest.call('POST', `/api/matches/${id}/report`, mirror({ mirrorOppSpeed: 3100 }));
    assert.equal(r.state, 'disputed');
    const f = r.flags.find((x) => x.code === 'speed_anomaly');
    assert.equal(f.player, host.id);
    await assert.rejects(host.call('GET', '/api/me').then((me) => { if (me.status === 'flagged') throw new Error('flagged'); }), /flagged/);
  } finally { await env.close(); }
});

test('tampered client cannot queue; replayed or forged requests are refused', async () => {
  const env = await setup();
  try {
    const a = await env.register('Cheater');
    const bad = await a.call('POST', '/api/integrity/report', env.cleanReport({ runtime: { aircraft: { f22a: { maxSpeed: 9999, turnRate: 30, hp: 100 }, su57: { maxSpeed: 2450, turnRate: 32, hp: 100 } } } }));
    assert.equal(bad.verdict, 'rejected'); assert.equal(bad.integrityToken, null);
    await assert.rejects(a.call('POST', '/api/queue/join', { integrityToken: 'it_fake' }), (e) => e.status === 403);

    const forged = await fetch(env.url + '/api/me', { headers: { 'x-player-key': a.apiKey, 'x-timestamp': String(Date.now()), 'x-nonce': 'abcdefghijklmnop1234', 'x-signature': 'ab'.repeat(32) } });
    assert.equal(forged.status, 401);
    const { signedHeaders } = require('../../client/lib/sign');
    const h = signedHeaders(a, 'GET', '/api/me', '');
    assert.equal((await fetch(env.url + '/api/me', { headers: h })).status, 200);
    assert.equal((await fetch(env.url + '/api/me', { headers: h })).status, 401); // replay
  } finally { await env.close(); }
});

test('seed order keeps top seeds apart', () => {
  assert.deepEqual(seedOrder(4), [1, 4, 2, 3]);
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test('knockout event: byes, best-of series, championship final', async () => {
  const env = await setup();
  try {
    const players = [];
    for (const n of ['Ace1', 'Ace2', 'Ace3']) players.push(await env.register(n));
    const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Theve Cup', size: 4, bestOf: 1, finalBestOf: 3 });
    for (const p of players) await p.call('POST', `/api/tournaments/${t.id}/register`);
    const started = await env.admin('POST', `/api/admin/tournaments/${t.id}/start`);
    // 3 players in a 4 bracket: seed 1 gets a bye straight into the final.
    const final = started.series.find((s) => s.round === 2);
    assert.ok(final.player_a && !final.player_b);

    const byId = Object.fromEntries(players.map((p) => [p.id, p]));
    const playSeries = async (round) => {
      const s = (await (await fetch(`${env.url}/api/tournaments/${t.id}`)).json()).series.find((x) => x.round === round && x.player_a && x.player_b && !x.winner);
      const { id, host, guest } = await queuePair(env, byId[s.player_a], byId[s.player_b]);
      await host.call('POST', `/api/matches/${id}/report`, log());
      const r = await guest.call('POST', `/api/matches/${id}/report`, mirror());
      assert.equal(r.state, 'verified'); assert.ok(r.seriesId);
      return host.id;
    };
    const semiWinner = await playSeries(1);
    const f2 = (await (await fetch(`${env.url}/api/tournaments/${t.id}`)).json()).series.find((s) => s.round === 2);
    assert.equal(f2.player_b, semiWinner);

    const w1 = await playSeries(2); const w2 = await playSeries(2);
    let done = await (await fetch(`${env.url}/api/tournaments/${t.id}`)).json();
    if (done.state !== 'complete') { await playSeries(2); done = await (await fetch(`${env.url}/api/tournaments/${t.id}`)).json(); }
    assert.equal(done.state, 'complete');
    assert.ok([w1, w2].includes(done.champion));
  } finally { await env.close(); }
});
