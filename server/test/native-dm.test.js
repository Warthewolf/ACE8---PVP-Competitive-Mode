'use strict';
// The game's own deathmatch (RVNG runtime 0.4.4, docs/re/DEATHMATCH_NATIVE.md 9.15): the mod's result.json is decided by
// score at time-up; kills are the other pilot's deaths; both logs must agree on everything.
const test = require('node:test');
const assert = require('node:assert');
const { setup } = require('./helpers');
const { reconcileNativeDm, validateShape } = require('../src/matchlog');

// a host's log and the guest's mirror of the same match (scores as the game shows them, one decimal)
function nativeLog({ k = 2, d = 1, s = 3702.0, os = 2650.5, dur = 214, end = 'time_limit', me = '21010', opp = '10034010' } = {}) {
  const events = [];
  for (let i = 0; i < k; i++) events.push({ t: 30 + i, type: 'kill', actor: 'self' }, { t: 30 + i, type: 'death', actor: 'opponent' });
  for (let i = 0; i < d; i++) events.push({ t: 90 + i, type: 'kill', actor: 'opponent' }, { t: 90 + i, type: 'death', actor: 'self' });
  return {
    format: 'native_dm', gameVersion: 'TODO', runtimeVersion: '0.4.4', durationSec: dur, endReason: end,
    self: { aircraftId: me, kills: k, deaths: d, score: s }, opponent: { aircraftId: opp, kills: d, deaths: k, score: os }, events,
  };
}
function nativeMirror(o = {}) {
  const host = nativeLog(o);
  const g = nativeLog({ k: host.opponent.kills, d: host.self.kills, s: host.opponent.score, os: host.self.score,
    dur: host.durationSec, end: host.endReason, me: host.opponent.aircraftId, opp: host.self.aircraftId });
  return Object.assign(g, o.patch || {});
}
const ctx = (over = {}) => ({ rules: {}, playerA: 1, playerB: 2, minDurationSec: 30, ...over });
const codes = (r) => r.flags.map((f) => f.code);

test('native deathmatch: agreeing logs are decided by score, not kills', () => {
  // The host has fewer kills but the higher score: the score decides
  const host = nativeLog({ k: 1, d: 2, s: 4100.0, os: 3900.0 });
  const r = reconcileNativeDm(host, nativeMirror({ k: 1, d: 2, s: 4100.0, os: 3900.0 }), ctx());
  assert.deepEqual(r.flags, []);
  assert.equal(r.outcome, 'a');
  assert.deepEqual([r.scoreA, r.scoreB], [4100, 3900]);
  const draw = reconcileNativeDm(nativeLog({ s: 0, os: 0, k: 0, d: 0 }), nativeMirror({ s: 0, os: 0, k: 0, d: 0 }), ctx());
  assert.equal(draw.outcome, 'draw');
  assert.ok(draw.ok);
});

test('native deathmatch: logs that disagree are disputed', () => {
  const host = nativeLog();
  assert.ok(codes(reconcileNativeDm(host, nativeMirror({ patch: { self: { aircraftId: '10034010', kills: 1, deaths: 2, score: 9999 } } }), ctx())).includes('score_mismatch'));
  const fewer = nativeMirror(); fewer.opponent = { ...fewer.opponent, kills: 3 };
  assert.ok(codes(reconcileNativeDm(host, fewer, ctx())).includes('kills_mismatch'));
  const plane = nativeMirror(); plane.self = { ...plane.self, aircraftId: '5010' };
  assert.ok(codes(reconcileNativeDm(host, plane, ctx())).includes('aircraft_mismatch'));
  const old = nativeMirror(); delete old.format;
  assert.ok(codes(reconcileNativeDm(host, old, ctx())).includes('format_mismatch'));
});

test('native deathmatch: a lost link goes to an admin; a length off the game clock is flagged', () => {
  const lost = reconcileNativeDm(nativeLog({ end: 'disconnect', dur: 120 }), nativeMirror({ end: 'disconnect', dur: 120 }), ctx());
  assert.ok(codes(lost).includes('link_lost') && !lost.ok);
  const short = reconcileNativeDm(nativeLog({ dur: 120 }), nativeMirror({ dur: 120 }), ctx());
  assert.ok(codes(short).includes('duration_off_clock'));
  const banned = reconcileNativeDm(nativeLog(), nativeMirror(), ctx({ rules: { aircraftBans: ['21010'] } }));
  assert.ok(codes(banned).includes('banned_aircraft'));
});

test('native deathmatch: kill events must account for the kills; the shape needs both scores', () => {
  const host = nativeLog();
  host.events = host.events.filter((e) => !(e.type === 'kill' && e.actor === 'self'));
  assert.ok(codes(reconcileNativeDm(host, nativeMirror(), ctx())).includes('kill_events_inconsistent'));
  assert.deepEqual(validateShape(nativeLog()), []);
  const noScore = nativeLog(); delete noScore.self.score;
  assert.ok(validateShape(noScore).includes('self.score'));
  assert.ok(validateShape({ ...nativeLog(), format: 'other' }).includes('format'));
});

test('native deathmatch end to end: two agreeing result.json logs verify the match and update the leaderboard', async () => {
  const env = await setup();
  try {
    const a = await env.register('Trigger'); const b = await env.register('Mihaly');
    for (const p of [a, b]) {
      const s = await p.call('POST', '/api/integrity/report', env.cleanReport());
      await p.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region: 'eu' });
    }
    const sa = await a.call('GET', '/api/queue/status');
    assert.equal(sa.state, 'matched');
    const host = sa.match.role === 'host' ? a : b;
    const guest = host === a ? b : a;
    const id = sa.match.id;
    // (the native match needs no room code: the two PCs link over Steam; link.json carries each PC's SteamID, and the
    // host's makes the match live)
    await host.call('POST', `/api/matches/${id}/link`, { steamId: '76561190000000011' });
    await guest.call('POST', `/api/matches/${id}/link`, { steamId: '76561190000000022' });
    const r1 = await host.call('POST', `/api/matches/${id}/report`, nativeLog({ k: 2, d: 1, s: 3702.0, os: 2650.5 }));
    assert.equal(r1.state, 'awaiting_reports');
    const r2 = await guest.call('POST', `/api/matches/${id}/report`, nativeMirror({ k: 2, d: 1, s: 3702.0, os: 2650.5 }));
    assert.equal(r2.state, 'verified');
    assert.deepEqual(r2.score, { host: 3702, guest: 2651 });
    assert.ok(r2.ratingDelta.host > 0 && r2.ratingDelta.guest < 0);
    const lb = await (await fetch(env.url + '/api/leaderboard')).json();
    assert.equal(lb[0].id, host.id);
    assert.equal(lb[0].wins, 1);
    assert.equal(lb[0].kills, 2);
  } finally { await env.close(); }
});
