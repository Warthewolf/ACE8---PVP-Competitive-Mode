'use strict';
// Regression tests for the second review of the audit fixes, through the real HTTP API.
const test = require('node:test');
const assert = require('node:assert');
const { setup, log, mirror, queuePair, pub, BASE_FILES, MOD_FILE, AIRCRAFT, H, config } = require('./helpers');
const svc = require('../src/service');
const tournaments = require('../src/tournaments');

const MIN = 60 * 1000;
const me = (p) => p.call('GET', '/api/me');
const matchOf = (env, id) => pub(env, `/api/matches/${id}/public`);
const rejectsWith = (code, re) => (e) => e.status === code && (!re || re.test(e.message));
const report = (p, id, body) => p.call('POST', `/api/matches/${id}/report`, body);
const scan = (p, env, over) => p.call('POST', '/api/integrity/report', env.cleanReport(over));
async function event(env, players, body = {}) {
  const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Cup', size: 2, bestOf: 1, finalBestOf: 1, ...body });
  for (const p of players) await p.call('POST', `/api/tournaments/${t.id}/register`);
  return env.admin('POST', `/api/admin/tournaments/${t.id}/start`);
}
const playHonest = async (m) => { await report(m.host, m.id, log()); return report(m.guest, m.id, mirror()); };

test('untimed event rooms are not voided mid-game; an event room nobody reports goes to an admin, never to a rematch', async () => {
  const env = await setup();
  try {
    const a = await env.register('Untimed1'); const b = await env.register('Untimed2');
    const t = await event(env, [a, b], { rules: { timeLimitSec: 0, killTarget: 5 } });
    const m = await queuePair(env, a, b);
    assert.ok(m.seriesId);
    svc.sweepStaleMatches(env.db, Date.now() + 60 * MIN); // an hour into an untimed first-to-5
    assert.equal((await matchOf(env, m.id)).state, 'live');

    svc.sweepStaleMatches(env.db, Date.now() + (3 * 60 + 16) * MIN);
    const swept = await matchOf(env, m.id);
    assert.deepEqual([swept.state, swept.flags.map((f) => f.code)], ['disputed', ['no_reports']]);
    assert.deepEqual(tournaments.openSeriesFor(env.db, a.id), [], 'no series rematch while an admin has not ruled');
    const s = await scan(a, env);
    assert.equal((await a.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region: 'eu' })).state, 'queued', 'nobody is locked out');

    // Logs that arrive late still settle the game.
    assert.equal((await report(m.host, m.id, log())).state, 'disputed');
    assert.equal((await report(m.guest, m.id, mirror())).state, 'verified');
    const done = await pub(env, `/api/tournaments/${t.id}`);
    assert.deepEqual([done.state, done.champion], ['complete', m.host.id]);
  } finally { await env.close(); }
});

test('a ranked room that started late is voided by the sweep, but the late logs still count', async () => {
  const env = await setup();
  try {
    const a = await env.register('Late01'); const b = await env.register('Late02');
    const m = await queuePair(env, a, b);
    svc.sweepStaleMatches(env.db, Date.now() + 26 * MIN);
    assert.equal((await matchOf(env, m.id)).state, 'void');
    assert.equal((await report(m.host, m.id, log())).state, 'void', 'one late log keeps the room closed');
    const r = await report(m.guest, m.id, mirror());
    assert.equal(r.state, 'verified');
    assert.equal((await me(m.host)).wins, 1);
  } finally { await env.close(); }
});

test('a report retried after a lost response is recognised, even once the match is settled', async () => {
  const env = await setup();
  try {
    const a = await env.register('Retry01'); const b = await env.register('Retry02');
    const m = await queuePair(env, a, b);
    assert.equal((await playHonest(m)).state, 'verified');
    await assert.rejects(report(m.host, m.id, log()), rejectsWith(409, /already submitted/));
  } finally { await env.close(); }
});

test('an admin void removes the winner, score and rating change from the public match', async () => {
  const env = await setup();
  try {
    const a = await env.register('VoidPub1'); const b = await env.register('VoidPub2');
    const m = await queuePair(env, a, b);
    await playHonest(m);
    await env.admin('POST', `/api/admin/matches/${m.id}/resolve`, { void: true });
    const v = await matchOf(env, m.id);
    assert.deepEqual([v.state, v.winner, v.score, v.ratingDelta], ['void', null, null, null]);
    const flag = v.flags.find((f) => f.code === 'admin_void');
    assert.equal(flag.reverted.winner, m.host.id);
    const listed = (await pub(env, '/api/matches')).find((x) => x.id === m.id);
    assert.deepEqual([listed.winner, listed.ratingDelta], [null, null]);
    // An admin void is final: late logs cannot reopen it.
    await assert.rejects(report(m.host, m.id, log()), rejectsWith(409));
  } finally { await env.close(); }
});

test('voiding a deciding game reopens its series, but not once the next round has been played', async () => {
  const env = await setup();
  try {
    const ps = [];
    for (const n of ['Semi1', 'Semi2', 'Semi3', 'Semi4']) ps.push(await env.register(n));
    const byId = Object.fromEntries(ps.map((p) => [p.id, p]));
    const t = await event(env, ps, { size: 4 });
    const series = async () => (await pub(env, `/api/tournaments/${t.id}`)).series;
    const playSeries = async (slot, round = 1) => {
      const s = (await series()).find((x) => x.round === round && x.slot === slot);
      const m = await queuePair(env, byId[s.player_a], byId[s.player_b]);
      assert.equal(m.seriesId, s.id);
      assert.equal((await playHonest(m)).state, 'verified');
      return m;
    };
    const first = await playSeries(0);
    assert.equal((await series()).find((x) => x.round === 2).player_a, first.host.id);
    await env.admin('POST', `/api/admin/matches/${first.id}/resolve`, { void: true });
    let now = await series();
    assert.deepEqual([now[0].winner, now[0].wins_a + now[0].wins_b, now.find((x) => x.round === 2).player_a], [null, 0, null]);

    const replay = await playSeries(0); // the reopened series is played again
    await playSeries(1);
    await playSeries(0, 2); // the final
    assert.equal((await pub(env, `/api/tournaments/${t.id}`)).state, 'complete');
    await assert.rejects(env.admin('POST', `/api/admin/matches/${replay.id}/resolve`, { void: true }), rejectsWith(409, /next round/));
    now = await series();
    assert.ok(now[0].winner, 'a refused void changes nothing');
  } finally { await env.close(); }
});

test('an event never starts larger than its configured size', async () => {
  const env = await setup();
  try {
    const e = await env.register('Returner'); const l1 = await env.register('Later01'); const l2 = await env.register('Later02');
    const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Small', size: 2, bestOf: 1, finalBestOf: 3 });
    await e.call('POST', `/api/tournaments/${t.id}/register`);
    await env.admin('POST', `/api/admin/players/${e.id}/status`, { status: 'flagged' });
    await l1.call('POST', `/api/tournaments/${t.id}/register`);
    await l2.call('POST', `/api/tournaments/${t.id}/register`);
    await env.admin('POST', `/api/admin/players/${e.id}/status`, { status: 'active' }); // reinstated: 3 active entries, 2 slots
    const started = await env.admin('POST', `/api/admin/tournaments/${t.id}/start`);
    assert.equal(started.size, 2);
    assert.equal(started.series.length, 1);
    assert.deepEqual([started.series[0].player_a, started.series[0].player_b].sort(), [e.id, l1.id].sort(), 'earliest sign-ups play');
    assert.equal(started.series[0].best_of, 3);
  } finally { await env.close(); }
});

test('mod rollout: two required builds both pass while players update; retired builds are rejected without flagging', async () => {
  const env = await setup();
  try {
    const v11 = { path: MOD_FILE.path, size: 43, sha256: H('9') };
    await env.admin('POST', '/api/admin/mods', { mods: [{ name: 'Project RVNG', version: '1.1', ...v11, category: 'required' }] });
    const oldP = await env.register('OldMod1'); const newP = await env.register('NewMod1');
    assert.equal((await scan(oldP, env)).verdict, 'clean');
    assert.equal((await scan(newP, env, { files: [...BASE_FILES, v11] })).verdict, 'clean');

    await env.admin('POST', '/api/admin/mods/retire', { name: 'Project RVNG', version: '' });
    const r = await scan(oldP, env);
    assert.equal(r.verdict, 'rejected');
    assert.ok(r.findings.some((f) => f.code === 'outdated_mod'));
    assert.equal((await me(oldP)).status, 'active', 'an out-of-date build is not a tampered one');
    assert.equal((await scan(oldP, env, { files: [...BASE_FILES, v11] })).verdict, 'clean');

    // Withdrawing a cosmetic build with DELETE also retires it: pilots who still have it are not flagged.
    const hudPath = 'ACE8/Content/Paks/~mods/hud_P.pak';
    const list = await env.admin('POST', '/api/admin/mods', { mods: [
      { name: 'HUD', version: '1', path: hudPath, size: 7, sha256: H('d') }, { name: 'HUD', version: '2', path: hudPath, size: 8, sha256: H('e') }] });
    await env.admin('DELETE', `/api/admin/mods/${list.find((m) => m.name === 'HUD' && m.version === '1').id}`);
    const hud = await scan(newP, env, { files: [...BASE_FILES, v11, { path: hudPath, size: 7, sha256: H('d') }] });
    assert.ok(hud.findings.some((f) => f.code === 'outdated_mod'));
    assert.equal((await me(newP)).status, 'active');
  } finally { await env.close(); }
});

test('integrity reports: override.txt is a loader file; odd values and oversized strings are refused without a 500', async () => {
  const env = await setup();
  const saved = { ...config.integrity };
  try {
    const a = await env.register('Odd0001');
    const files = (...extra) => ({ files: [...BASE_FILES, MOD_FILE, ...extra] });
    const ov = await scan(a, env, files({ path: 'ACE8/Binaries/Win64/override.txt', size: 20, sha256: H('8') }));
    assert.equal(ov.verdict, 'rejected');
    assert.ok(ov.findings.some((f) => f.code === 'unapproved_loader_file'));

    const weird = { toString: 1 };
    for (const over of [files({ path: 'x/y.pak', size: weird, sha256: H('a') }), files({ path: 'x/y.pak', size: 1, sha256: weird }),
      { runtime: { aircraft: AIRCRAFT, loadedModules: [weird] } }, files({ ...BASE_FILES[0], size: weird })]) {
      const r = await scan(a, env, over);
      assert.equal(r.verdict, 'rejected');
    }
    const long = 'a'.repeat(2000);
    for (const over of [files({ path: `x/${long}.pak`, size: 1, sha256: H('a') }), { runtime: { aircraft: AIRCRAFT, loadedModules: [long] } },
      { runtime: { aircraft: { ...AIRCRAFT, [long]: {} } } }]) {
      await assert.rejects(scan(a, env, over), rejectsWith(413));
    }
    const gv = await scan(a, env, { gameVersion: 'v'.repeat(100000) });
    assert.equal(gv.findings[0].gameVersion.length, 32);

    // Stored findings and mods stay under the byte cap; the summary keeps the counts.
    Object.assign(config.integrity, { maxStoredBytes: 4000 });
    const junk = Array.from({ length: 40 }, (_, i) => ({ path: `ACE8/Content/Paks/~mods/${'p'.repeat(900)}${i}.pak`, size: 1, sha256: H('a') }));
    const big = await scan(a, env, files(...junk));
    assert.equal(big.findings.at(-1).code, 'findings_truncated');
    assert.equal(big.findings.at(-1).counts.unapproved_pak_mod, 40);
    const row = env.db.prepare('SELECT findings, mods FROM integrity_reports WHERE player_id = ? ORDER BY id DESC LIMIT 1').get(a.id);
    assert.ok(row.findings.length + row.mods.length < 5000, `stored ${row.findings.length + row.mods.length} bytes`);
  } finally { Object.assign(config.integrity, saved); await env.close(); }
});

test('the findings that explain a rejection are kept first when a report is truncated', async () => {
  const env = await setup();
  const saved = { ...config.integrity };
  try {
    Object.assign(config.integrity, { storedFindings: 5 });
    const a = await env.register('Overlay1');
    const strays = Array.from({ length: 20 }, (_, i) => ({ path: `ACE8/Manuals/page${i}.txt`, size: 1, sha256: H('f') }));
    const r = await scan(a, env, { files: [...BASE_FILES, MOD_FILE, ...strays], runtime: { aircraft: AIRCRAFT, loadedModules: ['overlay.dll'] } });
    assert.equal(r.verdict, 'rejected');
    assert.equal(r.findings[0].code, 'unexpected_loaded_module');
    const logged = (await env.admin('GET', '/api/admin/integrity')).find((x) => x.player_id === a.id);
    assert.equal(logged.findings[0].code, 'unexpected_loaded_module');
  } finally { Object.assign(config.integrity, saved); await env.close(); }
});

test('admin mod uploads with a null entry are a 400, not a 500', async () => {
  const env = await setup();
  try {
    for (const mods of [[null], [MOD_FILE, null]]) {
      await assert.rejects(env.admin('POST', '/api/admin/mods', { mods }), rejectsWith(400));
    }
  } finally { await env.close(); }
});

test('behind a proxy, sign-ups are limited per client address, and per /64 network for IPv6', async () => {
  const saved = { trustProxy: config.trustProxy, max: config.registration.max };
  config.trustProxy = config.parseTrustProxy('1');
  config.registration.max = 2;
  const env = await setup();
  try {
    let n = 0;
    const signUp = async (ip) => (await fetch(env.url + '/api/players/register', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ name: `Proxied${n++}` }) })).status;
    assert.deepEqual([await signUp('203.0.113.5'), await signUp('203.0.113.5'), await signUp('203.0.113.5')], [201, 201, 429]);
    assert.equal(await signUp('203.0.113.6'), 201, 'another client behind the same proxy is not affected');
    assert.deepEqual([await signUp('2001:db8:1:2::1'), await signUp('2001:db8:1:2:ffff::9'), await signUp('2001:db8:1:2::77')], [201, 201, 429]);
  } finally { Object.assign(config, { trustProxy: saved.trustProxy }); config.registration.max = saved.max; await env.close(); }
});
