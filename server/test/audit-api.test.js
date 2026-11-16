'use strict';
// Regression tests for the security audit, through the real HTTP API.
const test = require('node:test');
const assert = require('node:assert');
const { setup, log, mirror, queuePair, pub, BASE_FILES, MOD_FILE, AIRCRAFT, H, config } = require('./helpers');
const svc = require('../src/service');
const { signedHeaders } = require('../../client/lib/sign');

const status = (p) => p.call('GET', '/api/queue/status');
const me = (p) => p.call('GET', '/api/me');
const rejectsWith = (code) => (e) => e.status === code;
async function scanAndJoin(env, p, { region = 'eu', report } = {}) {
  const s = await p.call('POST', '/api/integrity/report', report || env.cleanReport());
  assert.equal(s.verdict, 'clean');
  return p.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region });
}
async function cup(env, players, opts = {}) {
  const t = await env.admin('POST', '/api/admin/tournaments', { name: opts.name || 'Cup', size: opts.size || 2, bestOf: 1, finalBestOf: 1, ...opts.body });
  for (const p of players) await p.call('POST', `/api/tournaments/${t.id}/register`);
  return env.admin('POST', `/api/admin/tournaments/${t.id}/start`);
}
const playHonest = async ({ id, host, guest }) => {
  await host.call('POST', `/api/matches/${id}/report`, log());
  return guest.call('POST', `/api/matches/${id}/report`, mirror());
};

test('a forged one-sided surrender is disputed: no rating change and no tournament title', async () => {
  const env = await setup();
  try {
    const a = await env.register('Honest1'); const b = await env.register('Forger1');
    const t = await cup(env, [a, b]);
    const m = await queuePair(env, a, b);
    assert.ok(m.seriesId);
    await m.host.call('POST', `/api/matches/${m.id}/report`, log());
    const r = await m.guest.call('POST', `/api/matches/${m.id}/report`, mirror({ end: 'surrender', mirrorEvents: [{ t: 299, type: 'disconnect', actor: 'opponent' }] }));
    assert.equal(r.state, 'disputed');
    assert.ok(r.flags.some((f) => f.code === 'end_mismatch'));
    assert.equal((await me(a)).rating, 1500); assert.equal((await me(b)).rating, 1500);
    const after = await pub(env, `/api/tournaments/${t.id}`);
    assert.equal(after.state, 'running'); assert.equal(after.champion, null);
  } finally { await env.close(); }
});

test('the speed-check reference comes from the scans, not the log: a bogus gameVersion is disputed', async () => {
  const env = await setup();
  try {
    const a = await env.register('Cheat01'); const b = await env.register('Honest2');
    const m = await queuePair(env, a, b);
    await m.host.call('POST', `/api/matches/${m.id}/report`, { ...log(), gameVersion: 'nope' });
    const r = await m.guest.call('POST', `/api/matches/${m.id}/report`, mirror({ mirrorOppSpeed: 3100 }));
    assert.equal(r.state, 'disputed');
    assert.ok(r.flags.some((f) => f.code === 'game_version_mismatch' && f.player === m.host.id));
    assert.ok(r.flags.some((f) => f.code === 'speed_anomaly' && f.player === m.host.id));
  } finally { await env.close(); }
});

test('a disputed series game blocks the rematch, and the admin ruling decides the series', async () => {
  const env = await setup();
  try {
    const a = await env.register('Winner1'); const b = await env.register('Disputer');
    const t = await cup(env, [a, b]);
    const m = await queuePair(env, a, b);
    await m.host.call('POST', `/api/matches/${m.id}/report`, log());
    const d = await m.guest.call('POST', `/api/matches/${m.id}/report`, mirror({ k: 0, d: 5 }));
    assert.equal(d.state, 'disputed');
    // Both queue again: while the dispute is open they may meet in ranked, but never in a new series game.
    await scanAndJoin(env, a); await scanAndJoin(env, b);
    const again = await status(a);
    assert.ok(again.state === 'queued' || again.match.seriesId === null);
    assert.equal(env.db.prepare('SELECT COUNT(*) c FROM matches WHERE series_id = ?').get(m.seriesId).c, 1);
    await env.admin('POST', `/api/admin/matches/${m.id}/resolve`, { winner: 'host', scoreHost: 5, scoreGuest: 2 });
    const done = await pub(env, `/api/tournaments/${t.id}`);
    assert.equal(done.state, 'complete'); assert.equal(done.champion, m.host.id);
  } finally { await env.close(); }
});

test('a live room that nobody reports on is voided, so neither pilot stays locked out', async () => {
  const env = await setup();
  try {
    const a = await env.register('Griefer'); const b = await env.register('Victim1');
    const m = await queuePair(env, a, b);
    assert.equal((await status(b)).match.state, 'live');
    svc.sweepStaleMatches(env.db, Date.now() + 10 * 60 * 1000); // inside time limit + grace
    assert.equal((await pub(env, `/api/matches/${m.id}/public`)).state, 'live');
    svc.sweepStaleMatches(env.db, Date.now() + 26 * 60 * 1000);
    assert.equal((await pub(env, `/api/matches/${m.id}/public`)).state, 'void');
    assert.equal((await scanAndJoin(env, b)).state, 'queued');
  } finally { await env.close(); }
});

test('a resubmitted report is refused, so the report window cannot be stretched', async () => {
  const env = await setup();
  try {
    const a = await env.register('Staller'); const b = await env.register('Waiter1');
    const m = await queuePair(env, a, b);
    await m.host.call('POST', `/api/matches/${m.id}/report`, log());
    await assert.rejects(m.host.call('POST', `/api/matches/${m.id}/report`, log()), (e) => e.status === 409 && /already submitted/.test(e.message));
  } finally { await env.close(); }
});

test('brackets far from full shrink and finish; byes never block a round', async () => {
  const env = await setup();
  try {
    const ps = [];
    for (const n of ['Seed1', 'Seed2', 'Seed3']) ps.push(await env.register(n));
    const t = await cup(env, ps, { size: 8 });
    assert.equal(t.size, 4);
    assert.ok(t.series.filter((s) => s.round === 1).every((s) => s.player_a || s.player_b));
    const byId = Object.fromEntries(ps.map((p) => [p.id, p]));
    for (let i = 0; i < 2; i++) {
      const s = (await pub(env, `/api/tournaments/${t.id}`)).series.find((x) => x.player_a && x.player_b && !x.winner);
      await playHonest(await queuePair(env, byId[s.player_a], byId[s.player_b]));
    }
    assert.equal((await pub(env, `/api/tournaments/${t.id}`)).state, 'complete');

    const two = await cup(env, [await env.register('Duo1'), await env.register('Duo2')], { size: 8, name: 'Duo' });
    assert.equal(two.size, 2);
    assert.ok(two.series[0].player_a && two.series[0].player_b);
    await assert.rejects(env.admin('POST', '/api/admin/tournaments', { name: 'Bad', size: 2.5 }), rejectsWith(400));
  } finally { await env.close(); }
});

test('flagged pilots cannot enter events, are not seeded, and an admin can walk a series over', async () => {
  const env = await setup();
  try {
    const a = await env.register('Entrant1'); const b = await env.register('Entrant2'); const c = await env.register('Flagged1');
    await env.admin('POST', `/api/admin/players/${c.id}/status`, { status: 'flagged' });
    const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Clean Cup', size: 4, bestOf: 1, finalBestOf: 1 });
    await assert.rejects(c.call('POST', `/api/tournaments/${t.id}/register`), rejectsWith(403));
    await a.call('POST', `/api/tournaments/${t.id}/register`); await b.call('POST', `/api/tournaments/${t.id}/register`);
    await env.admin('POST', `/api/admin/players/${c.id}/status`, { status: 'active' });
    await c.call('POST', `/api/tournaments/${t.id}/register`);
    await env.admin('POST', `/api/admin/players/${c.id}/status`, { status: 'flagged' }); // flagged again before the start
    const started = await env.admin('POST', `/api/admin/tournaments/${t.id}/start`);
    assert.equal(started.size, 2);
    assert.ok(!started.entrants.find((e) => e.id === c.id).seed);
    const s = started.series[0];
    await assert.rejects(env.admin('POST', `/api/admin/series/${s.id}/forfeit`, { winner: c.id }), rejectsWith(400));
    const done = await env.admin('POST', `/api/admin/series/${s.id}/forfeit`, { winner: b.id });
    assert.equal(done.state, 'complete'); assert.equal(done.champion, b.id);
  } finally { await env.close(); }
});

test('series pairing: every open series is tried, and entrants are held for their opponent, not paired in ranked', async () => {
  const env = await setup();
  try {
    const [x, p, q, r] = [await env.register('PilotX'), await env.register('PilotP'), await env.register('PilotQ'), await env.register('PilotR')];
    await cup(env, [x, p], { name: 'T1' }); await cup(env, [q, r], { name: 'T3' });
    const t2 = await cup(env, [x, q], { name: 'T2' });
    await scanAndJoin(env, x); await scanAndJoin(env, q);
    assert.equal((await status(x)).match.seriesId, t2.series[0].id);

    const ranked = await env.register('Ranked1');
    await scanAndJoin(env, ranked);
    assert.equal((await scanAndJoin(env, p)).state, 'queued'); // P owes T1 (opponent X is busy): no ranked game
    assert.equal((await status(ranked)).state, 'queued');
  } finally { await env.close(); }
});

test('voiding a verified match reverts it; voiding a won final reopens it', async () => {
  const env = await setup();
  try {
    const a = await env.register('Revert1'); const b = await env.register('Revert2');
    const m = await queuePair(env, a, b);
    assert.equal((await playHonest(m)).state, 'verified');
    const v = await env.admin('POST', `/api/admin/matches/${m.id}/resolve`, { void: true });
    assert.equal(v.state, 'void');
    for (const p of [a, b]) {
      const x = await me(p);
      assert.deepEqual([x.rating, x.wins, x.losses, x.kills, x.deaths], [1500, 0, 0, 0, 0]);
    }
    await assert.rejects(env.admin('POST', `/api/admin/matches/${m.id}/resolve`, { winner: 'host', scoreHost: 'x' }), rejectsWith(409));

    const c = await env.register('Final1'); const d = await env.register('Final2');
    const t = await cup(env, [c, d]);
    const fm = await queuePair(env, c, d);
    await playHonest(fm);
    assert.equal((await pub(env, `/api/tournaments/${t.id}`)).champion, fm.host.id);
    await env.admin('POST', `/api/admin/matches/${fm.id}/resolve`, { void: true });
    const reopened = await pub(env, `/api/tournaments/${t.id}`);
    assert.deepEqual([reopened.state, reopened.champion, reopened.series[0].winner], ['running', null, null]);
  } finally { await env.close(); }
});

test('draws count as games played and put a pilot on the leaderboard', async () => {
  const env = await setup();
  try {
    const a = await env.register('Drawer1'); const b = await env.register('Drawer2');
    const m = await queuePair(env, a, b);
    const zero = { k: 0, d: 0, dur: 600, end: 'time_limit' };
    await m.host.call('POST', `/api/matches/${m.id}/report`, log(zero));
    const r = await m.guest.call('POST', `/api/matches/${m.id}/report`, mirror(zero));
    assert.equal(r.state, 'verified'); assert.equal(r.winner, null);
    assert.equal((await me(a)).draws, 1);
    assert.equal((await pub(env, '/api/leaderboard')).length, 2);
  } finally { await env.close(); }
});

test('queue eligibility: re-checked status, same build only, fixed regions, no pairing on status polls', async () => {
  const env = await setup();
  try {
    // Flagged after joining: removed from the queue, never paired.
    const a = await env.register('Queued1'); const b = await env.register('Queued2');
    await scanAndJoin(env, a);
    const bad = await a.call('POST', '/api/integrity/report', env.cleanReport({ runtime: { aircraft: { ...AIRCRAFT, f22a: { ...AIRCRAFT.f22a, maxSpeed: 9999 } } } }));
    assert.equal(bad.verdict, 'rejected');
    assert.equal((await me(a)).status, 'flagged');
    assert.equal((await scanAndJoin(env, b)).state, 'queued');

    // Different builds are not paired.
    await env.admin('PUT', '/api/admin/baselines', { gameVersion: '1.0.1', manifest: { files: BASE_FILES }, aircraft: AIRCRAFT });
    const c = await env.register('NewBuild');
    assert.equal((await scanAndJoin(env, c, { report: env.cleanReport({ gameVersion: '1.0.1' }) })).state, 'queued');
    assert.equal((await status(b)).state, 'queued');

    // Regions come from a fixed list; malformed values are 400/403, not 500.
    const s = await b.call('POST', '/api/integrity/report', env.cleanReport());
    for (const region of ['r1', { toString: 1 }, 7]) {
      await assert.rejects(b.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region }), rejectsWith(400));
    }
    await assert.rejects(b.call('POST', '/api/queue/join', { integrityToken: { toString: 1 } }), rejectsWith(403));

    // Status polls do not pair: only a join or the background tick does.
    const d = await env.register('Patient1'); const e = await env.register('Patient2');
    await scanAndJoin(env, d, { region: 'na' }); await scanAndJoin(env, e, { region: 'oce' });
    env.db.prepare('UPDATE queue SET joined_at = joined_at - 200000 WHERE player_id IN (?, ?)').run(d.id, e.id);
    assert.equal((await status(d)).state, 'queued');
    svc.runMatchmaker(env.db);
    assert.equal((await status(d)).state, 'matched');
  } finally { await env.close(); }
});

test('retired builds stop queueing; withdrawn mods are retired, and purged only on request', async () => {
  const env = await setup();
  try {
    const a = await env.register('OldBuild');
    const s = await a.call('POST', '/api/integrity/report', env.cleanReport());
    await env.admin('POST', '/api/admin/baselines/1.0.0/active', { active: false });
    await assert.rejects(a.call('POST', '/api/queue/join', { integrityToken: s.integrityToken }), rejectsWith(403));
    const again = await a.call('POST', '/api/integrity/report', env.cleanReport());
    assert.ok(again.findings.some((f) => f.code === 'unsupported_game_version'));
    await env.admin('POST', '/api/admin/baselines/1.0.0/active', { active: true });

    const mods = await env.admin('POST', '/api/admin/mods', { mods: [{ name: 'HUD', path: 'ACE8/Content/Paks/~mods/hud_P.pak', size: 7, sha256: H('d') }] });
    const hud = mods.find((m) => m.name === 'HUD');
    const left = await env.admin('DELETE', `/api/admin/mods/${hud.id}`);
    assert.equal(left.find((m) => m.name === 'HUD').category, 'retired');
    const purged = await env.admin('DELETE', `/api/admin/mods/${hud.id}?purge=1`);
    assert.ok(!purged.some((m) => m.name === 'HUD'));
  } finally { await env.close(); }
});

test('integrity reports are size-capped, rate-limited, truncated when stored, and pruned', async () => {
  const env = await setup();
  const saved = { ...config.integrity };
  try {
    const a = await env.register('Spammer');
    Object.assign(config.integrity, { maxFiles: 10 });
    const many = Array.from({ length: 11 }, (_, i) => ({ path: `x/${i}.bin`, size: 1, sha256: H('a') }));
    await assert.rejects(a.call('POST', '/api/integrity/report', env.cleanReport({ files: many })), rejectsWith(413));

    Object.assign(config.integrity, saved, { storedFindings: 5, keepReports: 2 });
    const junk = Array.from({ length: 20 }, (_, i) => ({ path: `ACE8/Content/Paks/~mods/m${i}.pak`, size: 1, sha256: H('a') }));
    const r = await a.call('POST', '/api/integrity/report', env.cleanReport({ files: [...BASE_FILES, MOD_FILE, ...junk] }));
    assert.equal(r.findings.length, 6);
    assert.equal(r.findings[5].code, 'findings_truncated');
    assert.equal(r.findings[5].counts.unapproved_pak_mod, 20);
    for (let i = 0; i < 3; i++) await a.call('POST', '/api/integrity/report', env.cleanReport());
    assert.equal(env.db.prepare('SELECT COUNT(*) c FROM integrity_reports WHERE player_id = ?').get(a.id).c, 2);

    Object.assign(config.integrity, { minIntervalMs: 60000 });
    await assert.rejects(a.call('POST', '/api/integrity/report', env.cleanReport()), rejectsWith(429));
  } finally { Object.assign(config.integrity, saved); await env.close(); }
});

test('sign-up: names are trimmed before validation, platform ids are not accepted, sign-ups are limited per IP', async () => {
  const saved = config.registration.max;
  config.registration.max = 4;
  const env = await setup();
  try {
    const post = (body) => fetch(env.url + '/api/players/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ name: '   ' })).status, 400);
    assert.equal((await post({ name: 'a  ' })).status, 400);
    const ok = await post({ name: '  Ace  ', platformId: { a: 1 } });
    assert.equal(ok.status, 201);
    assert.equal((await ok.json()).name, 'Ace');
    assert.equal(env.db.prepare("SELECT platform_id FROM players WHERE name = 'Ace'").get().platform_id, null);
    await post({ name: 'Second' });
    assert.equal((await post({ name: 'Third' })).status, 429);
    const big = await post({ name: 'x'.repeat(100 * 1024) });
    assert.ok([413, 429].includes(big.status));
  } finally { config.registration.max = saved; await env.close(); }
});

test('public queries are range-checked and malformed values never cause a 500', async () => {
  const env = await setup();
  try {
    const a = await env.register('Lister1'); const b = await env.register('Lister2');
    for (let i = 0; i < 3; i++) {
      env.db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, created_at) VALUES (?, ?, ?, '{}', 'void', ?)`).run(`m_x${i}`, a.id, b.id, i);
    }
    assert.equal((await pub(env, '/api/matches?limit=-1')).length, 1);
    for (const q of ['/api/matches?state=a&state=b', '/api/matches?state[a]=b', '/api/leaderboard?offset=1e20', '/api/leaderboard?limit=-1e20',
      '/api/matches?limit=-1e20', '/api/leaderboard?offset=-5', '/api/players/abc', '/api/tournaments/1e400']) {
      const res = await fetch(env.url + q);
      assert.ok(res.status < 500, `${q} -> ${res.status}`);
    }
  } finally { await env.close(); }
});

test('the query string is signed; hot lookups are indexed; the CSP blocks base and form hijacks', async () => {
  const env = await setup();
  try {
    const a = await env.register('Signer1');
    const h1 = signedHeaders(a, 'GET', '/api/me', '');
    assert.equal((await fetch(env.url + '/api/me?x=1', { headers: h1 })).status, 401);
    const h2 = signedHeaders(a, 'GET', '/api/me?x=1', '');
    assert.equal((await fetch(env.url + '/api/me?x=1', { headers: h2 })).status, 200);

    const idx = env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name);
    for (const n of ['idx_nonces_seen', 'idx_players_key']) assert.ok(idx.includes(n), n);

    const csp = (await fetch(env.url + '/')).headers.get('content-security-policy');
    for (const d of ["base-uri 'none'", "form-action 'self'", "object-src 'none'", "frame-ancestors 'none'"]) assert.ok(csp.includes(d), d);
  } finally { await env.close(); }
});
