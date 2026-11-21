'use strict';
// Invite-only accounts, roles and notes, player reports, casual mode with its hidden rating, repeat opponents,
// hidden ratings, the ranked switch and lapsed matches, through the real HTTP API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, log, mirror, queuePair, pub, AIRCRAFT, config } = require('./helpers');
const { openDb } = require('../src/db');
const svc = require('../src/service');

const MIN = 60 * 1000;
const me = (p) => p.call('GET', '/api/me');
const status = (p) => p.call('GET', '/api/queue/status');
const rejectsWith = (code, re) => (e) => e.status === code && (!re || re.test(e.message));
const row = (env, id) => env.db.prepare('SELECT * FROM players WHERE id = ?').get(id);
async function join(env, p, { mode, region = 'eu' } = {}) {
  const s = await p.call('POST', '/api/integrity/report', env.cleanReport());
  assert.equal(s.verdict, 'clean');
  return p.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region, ...(mode === undefined ? {} : { mode }) });
}
// Both pilots join, then the host opens the room. Returns the live match.
async function pair(env, a, b, opts) {
  await join(env, a, opts); await join(env, b, opts);
  const sa = await status(a);
  assert.equal(sa.state, 'matched');
  const host = sa.match.role === 'host' ? a : b; const guest = host === a ? b : a;
  await host.call('POST', `/api/matches/${sa.match.id}/lobby`, { lobbyCode: 'ROOM1234' });
  return { id: sa.match.id, mode: sa.match.mode, seriesId: sa.match.seriesId, host, guest };
}
const playHonest = async (m) => { await m.host.call('POST', `/api/matches/${m.id}/report`, log()); return m.guest.call('POST', `/api/matches/${m.id}/report`, mirror()); };
// No key that names or carries the casual rating, anywhere in a response.
const noCasual = (what, x) => assert.ok(!/casual_?rating|casual_?delta|casual_?games|casualMmr/i.test(JSON.stringify(x)), `${what} exposes the casual rating`);
function withConfig(over, fn) {
  const saved = over.map(([obj, key]) => [obj, key, obj[key]]);
  for (const [obj, key, v] of over) obj[key] = v;
  return Promise.resolve().then(fn).finally(() => { for (const [obj, key, v] of saved) obj[key] = v; });
}

test('on/off env switches: the usual spellings, the default when unset, and a typo is refused', () => {
  assert.deepEqual(['1', 'true', 'ON', ' yes '].map((v) => config.parseFlag(v, false)), [true, true, true, true]);
  assert.deepEqual(['0', 'false', 'Off', 'no'].map((v) => config.parseFlag(v, true)), [false, false, false, false]);
  assert.deepEqual([config.parseFlag(undefined, true), config.parseFlag('', false)], [true, false]);
  assert.throws(() => config.parseFlag('ture', false, 'RVNG_INVITE_ONLY'), /RVNG_INVITE_ONLY=ture is not an on\/off value/);
  // Defaults: open sign-ups and ranked on, as before these switches existed.
  assert.deepEqual([config.access.inviteOnly, config.modes.ranked], [false, true]);
});

test('invite-only: a new account is pending and cannot scan, queue, enter events or report until an admin lets it in', async () => {
  const env = await setup();
  try {
    await withConfig([[config.access, 'inviteOnly', true]], async () => {
      const a = await env.register('Invited1'); const b = await env.register('Invited2');
      assert.equal(a.status, 'pending');
      assert.equal((await me(a)).status, 'pending', 'the account can read its own profile');
      const pending = rejectsWith(403, /waiting for an admin to let you in/);
      await assert.rejects(a.call('POST', '/api/integrity/report', env.cleanReport()), pending);
      await assert.rejects(a.call('POST', '/api/queue/join', { integrityToken: 'it_x', region: 'eu' }), pending);
      const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Closed Cup', size: 2, bestOf: 1, finalBestOf: 1 });
      await assert.rejects(a.call('POST', `/api/tournaments/${t.id}/register`), pending);
      await assert.rejects(a.call('POST', '/api/reports', { playerId: b.id, reason: 'abuse' }), pending);
      assert.equal(env.db.prepare('SELECT COUNT(*) c FROM integrity_reports').get().c, 0, 'nothing stored for a pending account');

      const list = await env.admin('GET', '/api/admin/players?status=pending');
      assert.deepEqual(list.map((p) => p.name).sort(), ['Invited1', 'Invited2']);
      for (const p of [a, b]) await env.admin('POST', `/api/admin/players/${p.id}/status`, { status: 'active' });
      assert.equal((await join(env, a)).state, 'queued');
      // Taken back out of play: off the queue at once.
      await env.admin('POST', `/api/admin/players/${a.id}/status`, { status: 'pending' });
      assert.equal((await status(a)).state, 'idle');
      await assert.rejects(env.admin('POST', '/api/admin/players/99999/status', { status: 'active' }), rejectsWith(404));
      await assert.rejects(env.admin('POST', `/api/admin/players/${a.id}/status`, { status: 'vip' }), rejectsWith(400));
    });
    assert.equal((await env.register('OpenDoor')).status, 'active', 'sign-ups are active while invite-only is off');
  } finally { await env.close(); }
});

test('roles and notes: admin-set, validated, shown on player cards, leaderboard and match lists', async () => {
  const env = await setup();
  try {
    const a = await env.register('Tester01'); const b = await env.register('Regular1');
    const m = await queuePair(env, a, b);
    await playHonest(m);
    const note = 'Runs the Tuesday test nights <img src=x onerror=alert(1)>';
    const card = await env.admin('POST', `/api/admin/players/${a.id}/role`, { role: 'tester', note });
    assert.deepEqual([card.role, card.note], ['tester', note]);
    const prof = await pub(env, `/api/players/${a.id}`);
    assert.deepEqual([prof.role, prof.note], ['tester', note]);
    assert.deepEqual([(await pub(env, `/api/players/${b.id}`)).role, (await pub(env, `/api/players/${b.id}`)).note], ['player', '']);
    const lb = await pub(env, '/api/leaderboard');
    assert.deepEqual(lb.find((p) => p.id === a.id).role, 'tester');
    const listed = (await pub(env, '/api/matches')).find((x) => x.id === m.id);
    const side = listed.host.id === a.id ? listed.host : listed.guest;
    assert.equal(side.role, 'tester');
    const view = await pub(env, `/api/matches/${m.id}/public`);
    assert.equal((view.host.id === a.id ? view.host : view.guest).note, note);

    // Only the role may change; an empty note clears it.
    assert.equal((await env.admin('POST', `/api/admin/players/${a.id}/role`, { role: 'veteran' })).note, note);
    assert.equal((await env.admin('POST', `/api/admin/players/${a.id}/role`, { note: '' })).note, '');
    for (const body of [{}, { role: 'admin' }, { role: 7 }, { note: 'x'.repeat(201) }, { note: 'two\nlines' }, { note: 'evil \u202Eetoner' }, { note: { toString: 1 } }]) {
      await assert.rejects(env.admin('POST', `/api/admin/players/${a.id}/role`, body), rejectsWith(400), JSON.stringify(body));
    }
    await assert.rejects(env.admin('POST', '/api/admin/players/99999/role', { role: 'tester' }), rejectsWith(404));
    const noAuth = await fetch(`${env.url}/api/admin/players/${a.id}/role`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"role":"tester"}' });
    assert.equal(noAuth.status, 403);
  } finally { await env.close(); }
});

test('player reports: validated, limited, one open report per pilot and match, and they never change ratings', async () => {
  const env = await setup();
  try {
    const a = await env.register('Reporter'); const b = await env.register('Suspect1'); const c = await env.register('Bystand1');
    const m = await queuePair(env, a, b);
    await playHonest(m);
    const before = [row(env, a.id), row(env, b.id)].map((p) => [p.rating, p.wins, p.losses, p.status]);

    const r1 = await a.call('POST', '/api/reports', { playerId: b.id, matchId: m.id, reason: 'cheating', details: 'Turned faster than an F-22 can.\r\nTwice.' });
    assert.equal(r1.state, 'open');
    await assert.rejects(a.call('POST', '/api/reports', { playerId: b.id, matchId: m.id, reason: 'griefing' }), rejectsWith(409, /already have an open report/));
    await a.call('POST', '/api/reports', { playerId: b.id, reason: 'abuse' }); // no match: its own report
    await assert.rejects(a.call('POST', '/api/reports', { playerId: b.id, reason: 'abuse' }), rejectsWith(409));

    const bad = [
      [{ playerId: a.id, reason: 'cheating' }, 400, /yourself/], [{ playerId: 99999, reason: 'cheating' }, 404],
      [{ playerId: b.id, reason: 'lag' }, 400, /reason/], [{ playerId: String(b.id), reason: 'other' }, 400],
      [{ playerId: b.id, reason: 'other', details: 'x'.repeat(501) }, 400], [{ playerId: b.id, reason: 'other', details: 'bell\u0007' }, 400],
      [{ playerId: b.id, reason: 'other', details: { toString: 1 } }, 400], [{ playerId: b.id, reason: 'other', matchId: 'm_nope' }, 404],
      [{ playerId: c.id, reason: 'other', matchId: m.id }, 403, /played against this pilot/], [{ playerId: b.id, reason: 'other', matchId: 5 }, 400],
    ];
    for (const [body, code, re] of bad) await assert.rejects(a.call('POST', '/api/reports', body), rejectsWith(code, re), JSON.stringify(body));
    const unsigned = await fetch(`${env.url}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId: b.id, reason: 'other' }) });
    assert.equal(unsigned.status, 401);

    // Five per hour per reporter.
    const others = [];
    for (let i = 0; i < 4; i++) others.push(await env.register(`Target${i}x`));
    for (const o of others.slice(0, 3)) await a.call('POST', '/api/reports', { playerId: o.id, reason: 'other' });
    await assert.rejects(a.call('POST', '/api/reports', { playerId: others[3].id, reason: 'other' }), rejectsWith(429, /at most 5 per hour/));
    assert.equal((await c.call('POST', '/api/reports', { playerId: b.id, reason: 'griefing' })).state, 'open', 'the limit is per reporter');

    const after = [row(env, a.id), row(env, b.id)].map((p) => [p.rating, p.wins, p.losses, p.status]);
    assert.deepEqual(after, before, 'reports change nothing by themselves');

    const open = await env.admin('GET', '/api/admin/reports');
    assert.equal(open.length, 6);
    const first = open[0];
    assert.deepEqual([first.id, first.reason, first.matchId, first.reporter.name, first.reported.name, first.reported.openReports],
      [r1.id, 'cheating', m.id, 'Reporter', 'Suspect1', 3]);
    assert.equal(first.details, 'Turned faster than an F-22 can.\nTwice.');
    const closed = await env.admin('POST', `/api/admin/reports/${r1.id}/close`, { state: 'dismissed', note: 'Within the speed tolerance.' });
    assert.deepEqual([closed.state, closed.resolution], ['dismissed', 'Within the speed tolerance.']);
    await assert.rejects(env.admin('POST', `/api/admin/reports/${r1.id}/close`, { state: 'resolved' }), rejectsWith(409));
    await assert.rejects(env.admin('POST', `/api/admin/reports/${open[1].id}/close`, { state: 'open' }), rejectsWith(400));
    await assert.rejects(env.admin('POST', '/api/admin/reports/99999/close', { state: 'resolved' }), rejectsWith(404));
    assert.equal((await env.admin('GET', '/api/admin/reports?state=dismissed')).length, 1);
    assert.equal((await env.admin('GET', '/api/admin/reports?state=all')).length, 6);
    await assert.rejects(env.admin('GET', '/api/admin/reports?state=bogus'), rejectsWith(400));
    assert.equal((await env.admin('GET', '/api/admin/players')).find((p) => p.id === b.id).open_reports, 2);
    assert.deepEqual([row(env, b.id).rating, row(env, b.id).status], [before[1][0], 'active'], 'closing a report changes nothing either');
  } finally { await env.close(); }
});

test('casual: looser matching on a hidden rating seeded from ranked; results never touch ranked, the leaderboard or events', async () => {
  const env = await setup();
  try {
    const a = await env.register('Casual01'); const b = await env.register('Casual02');
    env.db.prepare('UPDATE players SET rating = 1800, peak_rating = 1800 WHERE id = ?').run(b.id);
    // 300 apart: too far for ranked right away, fine for casual.
    assert.equal((await join(env, a, { mode: 'ranked' })).state, 'queued');
    assert.equal((await join(env, b, { mode: 'ranked' })).state, 'queued');
    await a.call('POST', '/api/queue/leave'); await b.call('POST', '/api/queue/leave');
    const q = await join(env, a, { mode: 'casual' });
    assert.deepEqual([q.state, q.mode], ['queued', 'casual']);
    const s = await join(env, b, { mode: 'casual' });
    assert.deepEqual([s.state, s.match.mode, s.match.seriesId], ['matched', 'casual', null]);
    const host = s.match.role === 'host' ? b : a;
    const m = { id: s.match.id, host, guest: host === a ? b : a };
    await host.call('POST', `/api/matches/${m.id}/lobby`, { lobbyCode: 'ROOM1234' });
    const r = await playHonest(m);
    assert.deepEqual([r.state, r.ratingDelta], ['verified', null]);

    for (const p of [a, b]) {
      const x = row(env, p.id);
      assert.deepEqual([x.wins, x.losses, x.draws, x.kills, x.deaths, x.casual_games], [0, 0, 0, 0, 0, 1]);
    }
    assert.equal(row(env, a.id).rating, 1500); assert.equal(row(env, b.id).rating, 1800);
    const hostSeed = m.host.id === b.id ? 1800 : 1500;
    const md = env.db.prepare('SELECT casual_delta_a, casual_delta_b FROM matches WHERE id = ?').get(m.id);
    assert.ok(md.casual_delta_a > 0 && md.casual_delta_b < 0);
    assert.equal(row(env, m.host.id).casual_rating, hostSeed + md.casual_delta_a, 'seeded from the ranked rating, then moved');
    assert.deepEqual(await pub(env, '/api/leaderboard'), [], 'casual games never put anyone on the ranked leaderboard');

    // The casual rating is never part of any public or player view.
    noCasual('leaderboard', await pub(env, '/api/leaderboard'));
    noCasual('profile', await pub(env, `/api/players/${a.id}`));
    noCasual('own profile', await me(a));
    noCasual('match list', await pub(env, '/api/matches'));
    noCasual('public match', await pub(env, `/api/matches/${m.id}/public`));
    noCasual('own match', await a.call('GET', `/api/matches/${m.id}`));
    noCasual('stats', await pub(env, '/api/stats'));
    noCasual('admin players', await env.admin('GET', '/api/admin/players'));
    noCasual('queue status', await join(env, a, { mode: 'casual' }));

    // A void reverts the casual rating only; disagreeing casual logs are disputed like ranked ones.
    const cr = row(env, m.host.id).casual_rating;
    const v = await env.admin('POST', `/api/admin/matches/${m.id}/resolve`, { void: true });
    assert.equal(v.state, 'void');
    assert.equal(row(env, m.host.id).casual_rating, cr - md.casual_delta_a);
    assert.deepEqual([row(env, m.host.id).casual_games, row(env, m.host.id).rating], [0, hostSeed]);
    noCasual('void flag', v);
    await a.call('POST', '/api/queue/leave');

    const c = await env.register('Casual03'); const d = await env.register('Casual04');
    const m2 = await pair(env, c, d, { mode: 'casual' });
    await m2.host.call('POST', `/api/matches/${m2.id}/report`, log({ k: 5, d: 0 }));
    const disputed = await m2.guest.call('POST', `/api/matches/${m2.id}/report`, mirror({ k: 3, d: 5 }));
    assert.equal(disputed.state, 'disputed');
    assert.equal(row(env, c.id).casual_rating, null, 'no casual change for a disputed match');
    const settled = await env.admin('POST', `/api/admin/matches/${m2.id}/resolve`, { winner: 'host', scoreHost: 5, scoreGuest: 3 });
    assert.deepEqual([settled.state, settled.ratingDelta], ['verified', null]);
    assert.deepEqual([row(env, m2.host.id).rating, row(env, m2.host.id).wins], [1500, 0]);
    assert.ok(row(env, m2.host.id).casual_rating > 1500);
  } finally { await env.close(); }
});

test('casual and ranked queues never pair with each other, and casual pilots are not pulled into their event series', async () => {
  const env = await setup();
  try {
    const a = await env.register('Ranked01'); const b = await env.register('Casual05');
    assert.equal((await join(env, a, { mode: 'ranked' })).state, 'queued');
    assert.equal((await join(env, b, { mode: 'casual' })).state, 'queued');
    svc.runMatchmaker(env.db, Date.now() + 5 * MIN); // long past every window and the cross-region wait
    assert.deepEqual([(await status(a)).state, (await status(b)).state], ['queued', 'queued']);
    await assert.rejects(join(env, a, { mode: 'arcade' }), rejectsWith(400, /mode must be one of: ranked, casual/));
    await assert.rejects(join(env, a, { mode: { toString: 1 } }), rejectsWith(400));
    await a.call('POST', '/api/queue/leave'); await b.call('POST', '/api/queue/leave');

    // Two event entrants who queue casual get a casual game; their series is untouched.
    const c = await env.register('Entrant3'); const d = await env.register('Entrant4');
    const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Cup', size: 2, bestOf: 1, finalBestOf: 1 });
    for (const p of [c, d]) await p.call('POST', `/api/tournaments/${t.id}/register`);
    await env.admin('POST', `/api/admin/tournaments/${t.id}/start`);
    const m = await pair(env, c, d, { mode: 'casual' });
    assert.deepEqual([m.mode, m.seriesId], ['casual', null]);
    await playHonest(m);
    const s = (await pub(env, `/api/tournaments/${t.id}`)).series[0];
    assert.deepEqual([s.wins_a, s.wins_b, s.winner], [0, 0, null]);
    // Queued ranked (the default), they play their series game.
    const e = await queuePair(env, c, d);
    assert.equal(e.seriesId, s.id);
  } finally { await env.close(); }
});

test('repeat opponents: not paired again while someone else is there; alone together, paired after a short extra wait', async () => {
  const env = await setup();
  try {
    const a = await env.register('Repeat01'); const b = await env.register('Repeat02'); const c = await env.register('Fresh001');
    await playHonest(await queuePair(env, a, b));
    assert.equal((await join(env, a)).state, 'queued');
    assert.equal((await join(env, b)).state, 'queued', 'A and B just played: no instant rematch');
    const withC = await join(env, c);
    assert.equal(withC.state, 'matched');
    assert.ok([withC.match.host.id, withC.match.guest.id].includes(a.id), 'the oldest pilot gets the fresh opponent');
    assert.equal((await status(b)).state, 'queued');
    await b.call('POST', '/api/queue/leave');

    // Only each other: paired once both have waited the extra time.
    for (const mode of ['ranked', 'casual']) {
      const d = await env.register(`Again${mode}`); const e = await env.register(`Twice${mode}`);
      await playHonest(await pair(env, d, e, { mode }));
      await join(env, d, { mode }); await join(env, e, { mode });
      assert.equal((await status(d)).state, 'queued', mode);
      svc.runMatchmaker(env.db, Date.now() + config.matchmaking.rematch.waitMs - 5000);
      assert.equal((await status(d)).state, 'queued', `${mode}: not before the extra wait`);
      svc.runMatchmaker(env.db, Date.now() + config.matchmaking.rematch.waitMs + 1000);
      const s = await status(d);
      assert.deepEqual([s.state, s.match.mode], ['matched', mode]);
      const host = s.match.role === 'host' ? d : e;
      await host.call('POST', `/api/matches/${s.match.id}/lobby`, { lobbyCode: 'ROOM5678' });
      await env.admin('POST', `/api/admin/matches/${s.match.id}/resolve`, { void: true });
    }
  } finally { await env.close(); }
});

test('hide rating: public views show the tier only, the pilot keeps the number in their own view and their place on the board', async () => {
  const env = await setup();
  try {
    const a = await env.register('Hidden01'); const b = await env.register('Shown001');
    const m = await queuePair(env, a, b);
    await playHonest(m);
    const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Open', size: 4, bestOf: 1, finalBestOf: 1 });
    for (const p of [a, b]) await p.call('POST', `/api/tournaments/${t.id}/register`);
    const mine = await a.call('POST', '/api/me/settings', { hideRating: true });
    assert.equal(mine.ratingHidden, true);
    assert.equal(typeof mine.rating, 'number', 'the pilot still sees their own number');
    const own = row(env, a.id);

    const prof = await pub(env, `/api/players/${a.id}`);
    assert.deepEqual([prof.rating, prof.peakRating, prof.ratingHidden, prof.tier], [null, null, true, 'Pilot']);
    const lb = await pub(env, '/api/leaderboard');
    assert.deepEqual(lb.map((p) => p.id), [own.rating > 1500 ? a.id : b.id, own.rating > 1500 ? b.id : a.id], 'still in rating order');
    assert.equal(lb.find((p) => p.id === a.id).rating, null);
    assert.equal(typeof lb.find((p) => p.id === b.id).rating, 'number');
    const side = (v) => (v.host.id === a.id ? 'host' : 'guest');
    const other = (v) => (v.host.id === a.id ? 'guest' : 'host');
    const pm = await pub(env, `/api/matches/${m.id}/public`);
    assert.equal(pm[side(pm)].rating, null);
    assert.equal(pm.ratingDelta[side(pm)], null, 'their own rating changes are hidden too');
    assert.equal(typeof pm.ratingDelta[other(pm)], 'number');
    const lm = (await pub(env, '/api/matches')).find((x) => x.id === m.id);
    assert.equal(lm.ratingDelta[side(lm)], null);
    assert.equal((await pub(env, `/api/players/${a.id}`)).matches[0].ratingDelta[side(lm)], null);
    assert.equal(typeof (await me(a)).matches[0].ratingDelta[side(lm)], 'number', 'shown in the pilot\'s own view');
    const signed = await a.call('GET', `/api/matches/${m.id}`);
    assert.equal(typeof signed[side(signed)].rating, 'number');
    const entrant = (await pub(env, `/api/tournaments/${t.id}`)).entrants.find((e) => e.id === a.id);
    assert.deepEqual([entrant.rating, entrant.tier], [null, 'Pilot']);

    for (const body of [{}, { hideRating: 'yes' }, { hideRating: 1 }, []]) {
      await assert.rejects(a.call('POST', '/api/me/settings', body), rejectsWith(400), JSON.stringify(body));
    }
    await a.call('POST', '/api/me/settings', { hideRating: false });
    assert.equal((await pub(env, `/api/players/${a.id}`)).rating, Math.round(own.rating));
  } finally { await env.close(); }
});

test('ranked switch: ranked joins are refused, a join without a mode goes casual, and event games still pair', async () => {
  const env = await setup();
  try {
    await withConfig([[config.modes, 'ranked', false]], async () => {
      const a = await env.register('Paused01'); const b = await env.register('Paused02');
      await assert.rejects(join(env, a, { mode: 'ranked' }), rejectsWith(403, /ranked queue is turned off.*casual/));
      assert.deepEqual((await pub(env, '/api/stats')).queues, { ranked: false, casual: true });
      const q = await join(env, a);
      assert.deepEqual([q.state, q.mode], ['queued', 'casual'], 'an older mod that sends no mode plays casual');
      const s = await join(env, b);
      assert.deepEqual([s.state, s.match.mode], ['matched', 'casual']);

      const c = await env.register('Event001'); const d = await env.register('Event002');
      const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Paused Cup', size: 2, bestOf: 1, finalBestOf: 1 });
      for (const p of [c, d]) await p.call('POST', `/api/tournaments/${t.id}/register`);
      await env.admin('POST', `/api/admin/tournaments/${t.id}/start`);
      assert.equal((await join(env, c)).mode, 'ranked', 'a pilot who owes a series queues for it');
      const e = await join(env, d, { mode: 'ranked' });
      assert.deepEqual([e.state, e.match.mode, typeof e.match.seriesId], ['matched', 'ranked', 'number']);
    });
    assert.deepEqual((await pub(env, '/api/stats')).queues, { ranked: true, casual: true });
  } finally { await env.close(); }
});

test('dodging: the opponent is only named once the match exists; a host who lets rooms lapse gets a short cooldown', async () => {
  const env = await setup();
  try {
    const a = await env.register('Dodger01'); const b = await env.register('Waiting1');
    const q = await join(env, a);
    assert.deepEqual(Object.keys(q).sort(), ['mode', 'state', 'waitingSec'], 'nothing about other pilots while queued');
    const s = await join(env, b);
    assert.equal(s.state, 'matched');
    const host = s.match.role === 'host' ? b : a; const guest = host === a ? b : a;
    env.db.prepare('UPDATE matches SET created_at = created_at - ? WHERE id = ?').run(16 * MIN, s.match.id);
    svc.sweepStaleMatches(env.db); // the room was never opened
    assert.equal((await pub(env, `/api/matches/${s.match.id}/public`)).state, 'void');
    const lapses = env.db.prepare('SELECT player_id FROM lapses').all().map((r) => r.player_id);
    assert.deepEqual(lapses, [host.id], 'only the host can open the room: the lapse is theirs');

    // Two more lapses within the window: a cooldown for the host, nobody else.
    const rules = JSON.stringify(config.match.defaultRules);
    for (const id of ['m_lapse1', 'm_lapse2']) {
      env.db.prepare("INSERT INTO matches (id, player_a, player_b, rules, game_version, state, created_at) VALUES (?, ?, ?, ?, '1.0.0', 'pending', ?)")
        .run(id, host.id, guest.id, rules, Date.now() - 20 * MIN);
    }
    svc.sweepStaleMatches(env.db);
    assert.equal(env.db.prepare('SELECT COUNT(*) c FROM lapses WHERE player_id = ?').get(host.id).c, 3);
    svc.sweepStaleMatches(env.db); // a second sweep records nothing twice
    assert.equal(env.db.prepare('SELECT COUNT(*) c FROM lapses').get().c, 3);
    await assert.rejects(join(env, host), rejectsWith(403, /queue cooldown: 3 of your matches lapsed.*queue again in 15 min/));
    assert.equal((await join(env, guest)).state, 'queued');
    assert.ok(svc.lapseCooldown(env.db, host.id));
    assert.equal(svc.lapseCooldown(env.db, host.id, Date.now() + config.dodging.cooldownMs + 1000), null, 'the cooldown is short');
    assert.equal((await env.admin('GET', '/api/admin/players')).find((p) => p.id === host.id).lapses, 3);
    env.db.prepare('UPDATE lapses SET at = at - ?').run(config.dodging.cooldownMs);
    assert.ok(['queued', 'matched'].includes((await join(env, host)).state));
  } finally { await env.close(); }
});

test('the companion\'s report and settings commands work against the server', async () => {
  const env = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-cli-'));
  const { cmdReport, cmdSettings } = require('../../client/rvng');
  const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
  try {
    const a = await env.register('CliUser1'); const b = await env.register('CliUser2');
    const credentials = path.join(dir, 'credentials.json');
    fs.writeFileSync(credentials, JSON.stringify({ server: env.url, apiKey: a.apiKey, apiSecret: a.apiSecret, playerId: a.id, name: a.name }));
    const r = await quiet(() => cmdReport({ credentials, player: String(b.id), reason: 'griefing', details: 'rammed me at spawn' }));
    assert.deepEqual((await env.admin('GET', '/api/admin/reports')).map((x) => [x.id, x.reporter.id, x.reported.id, x.details]), [[r.id, a.id, b.id, 'rammed me at spawn']]);
    await quiet(() => cmdSettings({ credentials, 'hide-rating': 'on' }));
    assert.equal((await pub(env, `/api/players/${a.id}`)).rating, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await env.close(); }
});

test('upgrade: an existing database gets the new columns and tables in place; casual games never enter the career totals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-community-'));
  const file = path.join(dir, 'old.sqlite');
  try {
    let db = openDb(file);
    const ins = db.prepare("INSERT INTO players (name, api_key_hash, api_secret, rating, peak_rating, wins, kills, deaths, created_at) VALUES (?, ?, 's', 1500, 1500, ?, ?, ?, 0)");
    ins.run('OldPilotA', 'ka', 1, 5, 2); ins.run('OldPilotB', 'kb', 0, 2, 5);
    svc.putBaseline(db, { gameVersion: '1.0.0', manifest: { files: [] }, aircraft: AIRCRAFT });
    const rules = JSON.stringify(config.match.defaultRules);
    db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, winner, score_a, score_b, rating_delta_a, rating_delta_b,
      kills_a, deaths_a, kills_b, deaths_b, created_at) VALUES ('m_ranked', 1, 2, ?, 'verified', 1, 5, 2, 0, 0, 5, 2, 2, 5, 1)`).run(rules);
    // Back to the release before this one: no roles, notes, hidden ratings, casual mode, reports or lapses.
    for (const [t, c] of [['players', 'role'], ['players', 'note'], ['players', 'hide_rating'], ['players', 'casual_rating'],
      ['players', 'casual_games'], ['queue', 'mode'], ['matches', 'mode'], ['matches', 'casual_delta_a'], ['matches', 'casual_delta_b']]) {
      db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    }
    db.exec('DROP TABLE player_reports; DROP TABLE lapses');
    db.close();

    db = openDb(file);
    const a = db.prepare('SELECT * FROM players WHERE id = 1').get();
    assert.deepEqual([a.status, a.role, a.note, a.hide_rating, a.casual_rating, a.casual_games], ['active', 'player', '', 0, null, 0]);
    assert.equal(db.prepare("SELECT mode FROM matches WHERE id = 'm_ranked'").get().mode, 'ranked');
    for (const t of ['player_reports', 'lapses']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
    // A verified casual game, then a restart: the recount leaves the ranked totals alone.
    db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, mode, state, winner, score_a, score_b, casual_delta_a, casual_delta_b, created_at)
      VALUES ('m_casual', 1, 2, ?, 'casual', 'verified', 1, 5, 0, 20, -20, 2)`).run(rules);
    db.close();
    db = openDb(file);
    const t = (id) => ({ ...db.prepare('SELECT wins, losses, kills, deaths FROM players WHERE id = ?').get(id) });
    assert.deepEqual([t(1), t(2)], [{ wins: 1, losses: 0, kills: 5, deaths: 2 }, { wins: 0, losses: 1, kills: 2, deaths: 5 }]);
    assert.equal(db.prepare("SELECT kills_a FROM matches WHERE id = 'm_casual'").get().kills_a, null, 'nothing credited to backfill');
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
