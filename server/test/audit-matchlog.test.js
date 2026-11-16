'use strict';
// Regression tests for the security audit: match-log reconciliation (pure functions).
const test = require('node:test');
const assert = require('node:assert');
const { reconcile, validateShape } = require('../src/matchlog');
const { log, mirror, AIRCRAFT } = require('./helpers');

const RULES = { timeLimitSec: 600, killTarget: 5, respawn: true, specialWeapons: true, aircraftBans: [] };
const ctx = (over = {}) => ({ rules: RULES, aircraftStats: AIRCRAFT, playerA: 1, playerB: 2, minDurationSec: 30, ...over });
const codes = (r) => r.flags.map((f) => f.code);
const leftEvent = (actor) => ({ t: 299, type: 'disconnect', actor });

test('honest agreeing logs verify with no flags', () => {
  const r = reconcile(log(), mirror(), ctx());
  assert.deepEqual(r.flags, []);
  assert.equal(r.outcome, 'a');
});

test('a one-sided "opponent surrendered/disconnected" claim cannot flip the result', () => {
  for (const end of ['surrender', 'disconnect']) {
    // Host won 5-2 honestly; the losing guest mirrors everything but claims the host left.
    const forged = mirror({ end, mirrorEvents: [leftEvent('opponent')] });
    const r = reconcile(log(), forged, ctx());
    assert.ok(codes(r).includes('end_mismatch'), end);
    assert.ok(!r.ok);
  }
});

test('both pilots blaming each other for leaving is disputed, not decided by score', () => {
  // The host quit while ahead and also claims the guest left.
  const host = log({ k: 1, d: 0, dur: 60, end: 'disconnect', events: [leftEvent('opponent')] });
  const guest = mirror({ k: 1, d: 0, dur: 60, end: 'disconnect', mirrorEvents: [leftEvent('opponent')] });
  const r = reconcile(host, guest, ctx());
  assert.ok(codes(r).includes('end_mismatch'));
});

test('a surrender both logs agree on is a loss for the leaver, whatever the score', () => {
  // Host leads 3-1 and surrenders; both logs record it.
  const host = log({ k: 3, d: 1, dur: 200, end: 'surrender', events: [leftEvent('self')] });
  const guest = mirror({ k: 3, d: 1, dur: 200, end: 'surrender', mirrorEvents: [leftEvent('opponent')] });
  const r = reconcile(host, guest, ctx());
  assert.deepEqual(r.flags, []);
  assert.equal(r.outcome, 'b');
});

test('ending early while ahead, or with a lower kill target, is flagged', () => {
  const early = reconcile(log({ k: 1, d: 0, dur: 35 }), mirror({ k: 1, d: 0, dur: 35 }), ctx());
  assert.ok(codes(early).includes('premature_end'));
  const short = reconcile(log({ end: 'time_limit', dur: 120 }), mirror({ end: 'time_limit', dur: 120 }), ctx());
  assert.ok(codes(short).includes('premature_end'));
  const tooShort = reconcile(log({ k: 0, d: 0, dur: 10, end: 'time_limit' }), mirror({ k: 0, d: 0, dur: 10, end: 'time_limit' }), ctx({ rules: { ...RULES, timeLimitSec: 0 } }));
  assert.ok(codes(tooShort).includes('too_short'));
  const mismatch = reconcile(log(), mirror({ end: 'time_limit' }), ctx());
  assert.ok(codes(mismatch).includes('end_reason_mismatch'));
});

test('a banned special weapon is caught from the opponent\'s log even if stripped from your own', () => {
  const rules = { ...RULES, specialWeapons: false };
  const r = reconcile(log(), mirror({ mirrorEvents: [{ t: 50, type: 'special_fired', actor: 'opponent' }] }), ctx({ rules }));
  const f = r.flags.find((x) => x.code === 'special_weapon_used');
  assert.equal(f.player, 1);
});

test('tampered or missing live stats in a pilot\'s own log are flagged against that pilot', () => {
  const tampered = reconcile(log({ stats: { ...AIRCRAFT.f22a, turnRate: 45 } }), mirror(), ctx());
  const f = tampered.flags.find((x) => x.code === 'aircraft_stat_modified');
  assert.deepEqual([f.player, f.stat], [1, 'turnRate']);
  const missing = { ...log(), runtime: { aircraft: {} } };
  assert.ok(reconcile(missing, mirror(), ctx()).flags.some((x) => x.code === 'runtime_stats_missing' && x.player === 1));
});

test('no reference stats for an aircraft means a dispute, not a skipped speed check', () => {
  const r = reconcile(log({ oppSpeed: 9000 }), mirror({ mirrorOppSpeed: 9000 }), ctx({ aircraftStats: {} }));
  assert.ok(codes(r).includes('unknown_reference'));
  assert.ok(!r.ok);
});

test('telemetry and shapes are validated, and an empty events object from older mods is accepted', () => {
  assert.ok(validateShape({ ...log(), telemetry: { opponentMaxSpeed: 1e9 } }).includes('telemetry.opponentMaxSpeed'));
  assert.ok(validateShape({ ...log(), telemetry: { opponentMaxSpeed: -1 } }).includes('telemetry.opponentMaxSpeed'));
  assert.ok(validateShape({ ...log(), telemetry: 'fast' }).includes('telemetry'));
  const old = { ...log({ k: 0, d: 0 }), events: {} };
  assert.deepEqual(validateShape(old), []);
  assert.deepEqual(old.events, []);
  assert.ok(validateShape({ ...log(), self: null }).includes('self'));
});
