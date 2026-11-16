'use strict';
// Regression tests for the third review: mod builds, rooms closed by the sweep, walkovers, upgrades and
// hostile input.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, log, mirror, queuePair, pub, BASE_FILES, MOD_FILE, AIRCRAFT, H, config } = require('./helpers');
const { openDb } = require('../src/db');
const { clientKey, jsonTooDeep } = require('../src/app');
const { signedHeaders } = require('../../client/lib/sign');
const svc = require('../src/service');

const MIN = 60 * 1000;
const me = (p) => p.call('GET', '/api/me');
const matchOf = (env, id) => pub(env, `/api/matches/${id}/public`);
const rejectsWith = (code, re) => (e) => e.status === code && (!re || re.test(e.message));
const report = (p, id, body) => p.call('POST', `/api/matches/${id}/report`, body);
const scan = (p, env, over) => p.call('POST', '/api/integrity/report', env.cleanReport(over));
const resolve = (env, id, body) => env.admin('POST', `/api/admin/matches/${id}/resolve`, body);
const codes = (r) => r.findings.map((f) => f.code);

test('hostile query strings and deeply nested bodies get a 200 or a 400, never a 500', async () => {
  const env = await setup();
  try {
    const status = async (p, headers = {}) => (await fetch(env.url + p, { headers })).status;
    for (const q of ['/api/leaderboard?limit[toString]=1', '/api/leaderboard?offset[toString]=1', '/api/matches?limit[toString]=1',
      '/api/matches?limit[0][toString]=1', '/api/leaderboard?limit[valueOf]=1&offset[]=2']) assert.equal(await status(q), 200, q);
    assert.equal(await status('/api/admin/integrity?limit[toString]=1', { authorization: 'Bearer test-admin' }), 200);
    assert.equal((await pub(env, '/api/leaderboard?limit=1&offset[toString]=1')).length <= 1, true, 'plain values still apply');

    const a = await env.register('Deep0001'); const b = await env.register('Deep0002');
    const m = await queuePair(env, a, b);
    // Sent as raw text: building such a value in this process would overflow JSON.stringify here too.
    for (const [open, close] of [['[', ']'], ['{"a":', '}']]) {
      const body = JSON.stringify(log()).slice(0, -1) + ',"x":' + open.repeat(5000) + (open === '[' ? '' : '0') + close.repeat(5000) + '}';
      const p = `/api/matches/${m.id}/report`;
      const res = await fetch(env.url + p, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signedHeaders(m.host, 'POST', p, body) } });
      assert.deepEqual([res.status, (await res.json()).error], [400, 'JSON nested too deeply']);
    }
    assert.equal((await report(m.host, m.id, log())).state, 'awaiting_reports', 'the honest log is still accepted');
    assert.equal((await report(m.guest, m.id, mirror())).state, 'verified');
  } finally { await env.close(); }
});

test('stored findings keep the evidence that flagged the account, and one finding of every code', async () => {
  const env = await setup();
  try {
    const a = await env.register('Evidence1');
    const paks = Array.from({ length: 250 }, (_, i) => ({ path: `ACE8/Content/Paks/~mods/skin${String(i).padStart(3, '0')}_P.pak`, size: 9, sha256: H('e') }));
    const r = await scan(a, env, { files: [...BASE_FILES, MOD_FILE, ...paks, { path: 'ACE8/Binaries/Win64/x.ini', size: 1, sha256: H('f') }],
      runtime: { aircraft: { ...AIRCRAFT, f22a: { ...AIRCRAFT.f22a, turnRate: 45 } } } });
    assert.equal(r.verdict, 'rejected');
    assert.equal((await me(a)).status, 'flagged');
    const stored = (await env.admin('GET', '/api/admin/integrity?limit=1'))[0].findings;
    const stat = stored.find((f) => f.code === 'aircraft_stat_modified');
    assert.deepEqual([stat.aircraft, stat.stat, stat.expected, stat.actual], ['f22a', 'turnRate', 30, 45]);
    for (const code of ['unapproved_pak_mod', 'unapproved_config', 'findings_truncated']) assert.ok(stored.some((f) => f.code === code), code);
    assert.deepEqual(codes(r).slice(0, 2), ['aircraft_stat_modified', 'unapproved_pak_mod'], 'what flagged the account comes first');
  } finally { await env.close(); }
});

test('mod builds keep their own files: shared files, add-only releases, rollbacks and re-uploaded old builds', async () => {
  const env = await setup();
  try {
    const root = 'ACE8/Binaries/Win64/ue4ss';
    const ini = { path: `${root}/UE4SS-settings.ini`, size: 20, sha256: H('2') };
    const txt = { path: `${root}/Mods/mods.txt`, size: 30, sha256: H('3') };
    const dll1 = { path: `${root}/UE4SS.dll`, size: 10, sha256: H('1') };
    const dll2 = { path: `${root}/UE4SS.dll`, size: 11, sha256: H('4') };
    const extra = { path: `${root}/Mods/shared/extra.lua`, size: 5, sha256: H('5') };
    const build = (version, files, category = 'required') => env.admin('POST', '/api/admin/mods',
      { mods: files.map((f) => ({ name: 'UE4SS', version, category, ...f })) });
    const v301 = [dll1, ini, txt]; const v302 = [dll2, ini, txt]; const v303 = [dll2, ini, txt, extra];
    const pilot = await env.register('Builds01');
    const check = async (files) => scan(pilot, env, { files: [...BASE_FILES, MOD_FILE, ...files] });

    await build('3.0.1', v301); await build('3.0.2', v302);
    assert.equal((await check(v301)).verdict, 'clean', 'the old build passes during the rollout');
    assert.equal((await check(v302)).verdict, 'clean');
    const stripped = await check([dll1, txt]);
    assert.equal(stripped.verdict, 'rejected', 'the old build still needs the settings file it shares with the new one');
    assert.ok(stripped.findings.some((f) => f.code === 'missing_required_mod' && f.path === ini.path.toLowerCase()));

    // Rolling back a bad release does not take the shared files away from the good one.
    await env.admin('POST', '/api/admin/mods/retire', { name: 'UE4SS', version: '3.0.2' });
    assert.equal((await check(v301)).verdict, 'clean');
    assert.ok(codes(await check(v302)).includes('outdated_mod'));
    await build('3.0.2', v302); // approved again: the same rows go back to required
    assert.equal((await check(v302)).verdict, 'clean');

    // Recording the old build as retired (rvng approve --category retired) leaves the current build alone.
    await build('3.0.1', v301, 'retired');
    assert.equal((await check(v302)).verdict, 'clean');
    assert.ok(codes(await check(v301)).includes('outdated_mod'));

    // An add-only release: the build it extends keeps all its files and can be retired by name and version.
    await build('3.0.3', v303);
    assert.equal((await check(v302)).verdict, 'clean');
    await env.admin('POST', '/api/admin/mods/retire', { name: 'UE4SS', version: '3.0.2' });
    assert.equal((await check(v303)).verdict, 'clean');
    const behind = await check(v302);
    assert.ok(behind.findings.some((f) => f.code === 'missing_required_mod' && f.path === extra.path.toLowerCase()));
    assert.equal((await me(pilot)).status, 'active', 'nobody is flagged by a release');

    // A loader folder approved together with the competitive mod inside it is refused.
    await assert.rejects(env.admin('POST', '/api/admin/mods', { mods: [{ name: 'UE4SS', version: '3.0.4', category: 'required', ...MOD_FILE }] }),
      rejectsWith(409, /already pinned by another mod: .* by "Project RVNG".*--exclude/));
    const rows = await env.admin('GET', '/api/admin/mods');
    assert.equal(rows.filter((m) => m.path === ini.path.toLowerCase()).length, 3, 'each build lists the shared file');
  } finally { await env.close(); }
});

test('rooms closed by the sweep: an admin can settle or void them, late logs have a deadline, older closures stay closed', async () => {
  const env = await setup();
  try {
    const ps = [];
    for (let i = 0; i < 8; i++) ps.push(await env.register(`Sweep${i}00`));
    const swept = async (a, b) => {
      const m = await queuePair(env, a, b);
      svc.sweepStaleMatches(env.db, Date.now() + 26 * MIN);
      assert.equal((await matchOf(env, m.id)).state, 'void');
      return m;
    };
    // Settled by an admin with no logs at all.
    const m1 = await swept(ps[0], ps[1]);
    assert.equal((await resolve(env, m1.id, { winner: 'host', scoreHost: 5, scoreGuest: 1 })).state, 'verified');
    assert.equal((await me(m1.host)).wins, 1);

    // Voided for good: the late log is refused.
    const m2 = await swept(ps[2], ps[3]);
    const v = await resolve(env, m2.id, { void: true });
    assert.deepEqual(v.flags.map((f) => f.code), ['no_reports', 'admin_void']);
    await assert.rejects(report(m2.host, m2.id, log()), rejectsWith(409, /void/));

    // Logs a day after the sweep are refused; the admin can still close the match.
    const m3 = await swept(ps[4], ps[5]);
    env.db.prepare('UPDATE matches SET swept_at = ? WHERE id = ?').run(Date.now() - config.match.lateReportMs - MIN, m3.id);
    await assert.rejects(report(m3.host, m3.id, log()), rejectsWith(409, /due long ago/));
    assert.equal((await resolve(env, m3.id, { void: true })).state, 'void');

    // A void from an older release (no swept_at), even with a sweep flag, never reopens; nor does a voided event game.
    const m4 = await queuePair(env, ps[6], ps[7]);
    await report(m4.host, m4.id, log());
    svc.sweepStaleMatches(env.db, Date.now() + 16 * MIN);
    assert.equal((await matchOf(env, m4.id)).state, 'disputed');
    env.db.prepare("UPDATE matches SET state = 'void', swept_at = NULL WHERE id = ?").run(m4.id);
    await assert.rejects(report(m4.guest, m4.id, mirror()), rejectsWith(409, /void/));
    await assert.rejects(resolve(env, m4.id, { winner: 'host' }), rejectsWith(409));
    env.db.exec('PRAGMA foreign_keys = OFF'); // a voided event game with a sweep flag: not produced by this release
    env.db.prepare("UPDATE matches SET swept_at = ?, series_id = 999, flags = '[{\"code\":\"no_reports\"}]' WHERE id = ?").run(Date.now(), m4.id);
    env.db.exec('PRAGMA foreign_keys = ON');
    await assert.rejects(report(m4.guest, m4.id, mirror()), rejectsWith(409, /void/));
    assert.equal((await me(m4.host)).wins, 0);
  } finally { await env.close(); }
});

test('voiding a semifinal win still reverts the match when the final was decided by walkover', async () => {
  const env = await setup();
  try {
    const ps = [];
    for (const n of ['Walk1', 'Walk2', 'Walk3', 'Walk4']) ps.push(await env.register(n));
    const byId = Object.fromEntries(ps.map((p) => [p.id, p]));
    const t = await env.admin('POST', '/api/admin/tournaments', { name: 'Walk', size: 4, bestOf: 1, finalBestOf: 1 });
    for (const p of ps) await p.call('POST', `/api/tournaments/${t.id}/register`);
    await env.admin('POST', `/api/admin/tournaments/${t.id}/start`);
    const series = async () => (await pub(env, `/api/tournaments/${t.id}`)).series;
    const play = async (slot) => {
      const s = (await series()).find((x) => x.round === 1 && x.slot === slot);
      const m = await queuePair(env, byId[s.player_a], byId[s.player_b]);
      await report(m.host, m.id, log());
      assert.equal((await report(m.guest, m.id, mirror())).state, 'verified');
      return m;
    };
    const cheat = await play(0); await play(1);
    const final = (await series()).find((x) => x.round === 2);
    const other = final.player_a === cheat.host.id ? final.player_b : final.player_a;
    // The cheater is banned and the final walked over, then the cheated semifinal is voided.
    await env.admin('POST', `/api/admin/players/${cheat.host.id}/status`, { status: 'banned' });
    await env.admin('POST', `/api/admin/series/${final.id}/forfeit`, { winner: other });
    const before = await pub(env, `/api/players/${cheat.guest.id}`);
    const v = await resolve(env, cheat.id, { void: true });
    assert.equal(v.flags.find((f) => f.code === 'admin_void').series, 'kept');
    const victim = await pub(env, `/api/players/${cheat.guest.id}`);
    assert.deepEqual([victim.losses, victim.rating], [before.losses - 1, 1500]);
    const cheater = await pub(env, `/api/players/${cheat.host.id}`);
    assert.deepEqual([cheater.wins, cheater.rating, cheater.kills], [0, 1500, 0]);
    const done = await pub(env, `/api/tournaments/${t.id}`);
    assert.deepEqual([done.state, done.champion?.id ?? done.champion], ['complete', other], 'a walkover result stands');
  } finally { await env.close(); }
});

test('upgrade: admin-settled K/D, old approved builds and databases an earlier release already upgraded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-mig3-'));
  const file = path.join(dir, 'old.sqlite');
  try {
    let db = openDb(file);
    const ins = db.prepare("INSERT INTO players (name, api_key_hash, api_secret, rating, peak_rating, kills, deaths, wins, losses, created_at) VALUES (?, ?, 's', 1500, 1500, ?, ?, ?, ?, 0)");
    ins.run('SetA', 'ka', 5, 3, 2, 0); ins.run('SetB', 'kb', 2, 5, 0, 2); // what the two matches below credited
    svc.putBaseline(db, { gameVersion: '1.0.0', manifest: { files: [] }, aircraft: AIRCRAFT });
    for (const id of [1, 2]) {
      db.prepare("INSERT INTO integrity_reports (player_id, game_version, verdict, findings, mods, manifest_hash, created_at) VALUES (?, '1.0.0', 'clean', '[]', '[]', '', 10)").run(id);
    }
    const rules = JSON.stringify(config.match.defaultRules);
    const match = db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, winner, score_a, score_b, rating_delta_a, rating_delta_b, flags, created_at)
      VALUES (?, 1, 2, ?, 'verified', 1, ?, ?, 0, 0, ?, 5)`);
    // Settled by an admin after the logs disagreed: the old release credited the admin's scores (3-1).
    match.run('m_admin', rules, 3, 1, JSON.stringify([{ code: 'score_mismatch' }]));
    match.run('m_auto', rules, 2, 1, '[]'); // verified by itself: the logs were credited (A crashed once)
    const rep = db.prepare('INSERT INTO match_reports (match_id, player_id, report, received_at) VALUES (?, ?, ?, 0)');
    rep.run('m_admin', 1, JSON.stringify({ self: { kills: 5, deaths: 2 } })); rep.run('m_admin', 2, JSON.stringify({ self: { kills: 2, deaths: 4 } }));
    rep.run('m_auto', 1, JSON.stringify({ self: { kills: 2, deaths: 2 } })); rep.run('m_auto', 2, JSON.stringify({ self: { kills: 1, deaths: 2 } }));
    db.prepare("INSERT INTO matches (id, player_a, player_b, rules, state, created_at) VALUES ('m_open', 1, 2, ?, 'live', 20)").run(rules);
    // An earlier release added the columns without filling them; the first release keyed mods by (path, sha256).
    db.exec(`DROP TABLE approved_mods; CREATE TABLE approved_mods (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'cosmetic', version TEXT NOT NULL DEFAULT '', UNIQUE (path, sha256))`);
    const mod = db.prepare('INSERT INTO approved_mods (name, path, size, sha256, category) VALUES (?, ?, ?, ?, ?)');
    mod.run('HUD', 'x/hud_P.pak', 7, H('d'), 'cosmetic'); mod.run('HUD', 'x/hud_P.pak', 8, H('e'), 'cosmetic');
    mod.run('Project RVNG', MOD_FILE.path, MOD_FILE.size, MOD_FILE.sha256, 'required');
    db.close();

    db = openDb(file);
    const kd = (id) => ({ ...db.prepare('SELECT kills_a, deaths_a, kills_b, deaths_b FROM matches WHERE id = ?').get(id) });
    assert.deepEqual(kd('m_admin'), { kills_a: 3, deaths_a: 1, kills_b: 1, deaths_b: 3 }, 'what the admin settle credited');
    assert.deepEqual(kd('m_auto'), { kills_a: 2, deaths_a: 2, kills_b: 1, deaths_b: 2 }, 'what the logs credited');
    assert.equal(db.prepare("SELECT game_version FROM matches WHERE id = 'm_open'").get().game_version, '1.0.0');
    const hud = db.prepare("SELECT size, version FROM approved_mods WHERE name = 'HUD' ORDER BY id").all().map((r) => ({ ...r }));
    assert.deepEqual(hud, [{ size: 7, version: '#1' }, { size: 8, version: '' }], 'both approved files are kept, the newest in the build');
    svc.addApprovedMods(db, { mods: [{ name: 'Project RVNG', version: '1.1', category: 'required', ...MOD_FILE }] });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM approved_mods WHERE path = ?').get(MOD_FILE.path.toLowerCase()).c, 2, 'a second build can list the same file');

    const p = (id) => db.prepare('SELECT kills, deaths FROM players WHERE id = ?').get(id);
    svc.resolveDispute(db, 'm_admin', { void: true });
    assert.deepEqual([{ ...p(1) }, { ...p(2) }], [{ kills: 2, deaths: 2 }, { kills: 1, deaths: 2 }], 'the void undoes exactly what was credited');
    db.close();
    db = openDb(file); // opening again changes nothing
    assert.deepEqual(kd('m_auto'), { kills_a: 2, deaths_a: 2, kills_b: 1, deaths_b: 2 });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM approved_mods').get().c, 4);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('client keys: IPv6 prefixes with a compressed zero run, IPv4-mapped forms, and anything that is not an address', () => {
  assert.equal(clientKey('3fff::1:a:b:c:d'), clientKey('3fff:0:0:1::5'));
  assert.notEqual(clientKey('2001:0:0:1::5'), clientKey('2001:0:0:2::5'));
  assert.equal(clientKey('::ffff:c633:6407'), '198.51.100.7');
  assert.equal(clientKey('64:ff9b::1.2.3.4'), '64:ff9b:0:0::/64');
  for (const junk of ['x'.repeat(5000), '1.2.3.4, 5.6.7.8', '', undefined]) assert.equal(clientKey(junk), null);
  const deep = (t) => jsonTooDeep(Buffer.from(t), 3);
  assert.deepEqual(['{"a":[1,{"b":2}]}', '{"a":[1,{"b":[]}]}', '{"a":"[[[[{{{{\\"[[[["}', '["\\\\",[[[]]]]'].map(deep), [false, true, false, true]);
});

test('behind a proxy, a forwarded value that is not an address falls back to the connection address', async () => {
  const saved = { trustProxy: config.trustProxy, max: config.registration.max };
  config.trustProxy = 1;
  config.registration.max = 2;
  const env = await setup();
  try {
    let n = 0;
    const signUp = async (ip) => (await fetch(env.url + '/api/players/register', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ name: `Junk${n++}x` }) })).status;
    assert.deepEqual([await signUp('a'.repeat(4000)), await signUp('b'.repeat(4000)), await signUp('not-an-ip')], [201, 201, 429]);
  } finally { Object.assign(config, { trustProxy: saved.trustProxy }); config.registration.max = saved.max; await env.close(); }
});
