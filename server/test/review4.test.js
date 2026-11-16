'use strict';
// Regression tests for the fourth review: approved-mod upgrades and re-approvals, path spellings, and the
// repair of databases that earlier releases had already upgraded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, MOD_FILE, BASE_FILES, AIRCRAFT, H, config } = require('./helpers');
const { openDb } = require('../src/db');
const integrity = require('../src/integrity');
const svc = require('../src/service');

const me = (p) => p.call('GET', '/api/me');
const rejectsWith = (code, re) => (e) => e.status === code && (!re || re.test(e.message));
const scan = (p, env, over) => p.call('POST', '/api/integrity/report', env.cleanReport(over));
const codes = (r) => r.findings.map((f) => f.code);
const RVNG = 'ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG';
const baseline = { manifest: { files: BASE_FILES }, aircraft: AIRCRAFT };
const verdict = (approved, files) => integrity.evaluate({ files: [...BASE_FILES, ...files], runtime: { aircraft: AIRCRAFT } }, baseline, approved);

function tempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-r4-'));
  try { return fn(path.join(dir, 'db.sqlite')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// approved_mods as the release before per-build rows left it.
const OLD_MODS = `DROP TABLE approved_mods; CREATE TABLE approved_mods (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'cosmetic', version TEXT NOT NULL DEFAULT '', UNIQUE (path, sha256))`;

test('upgrade: a build re-pinned under the same version keeps the current file in the build; the stale one stays retired', () => tempDb((file) => {
  let db = openDb(file);
  db.exec(OLD_MODS);
  const ins = db.prepare('INSERT INTO approved_mods (id, name, path, size, sha256, category, version) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run(10, 'Project RVNG', `${RVNG}/Scripts/main.lua`, 40, H('1'), 'retired', '1.0'); // withdrawn hotfix predecessor
  ins.run(11, 'Project RVNG', `${RVNG}/Scripts/json.lua`, 41, H('2'), 'required', '1.0');
  ins.run(12, 'Project RVNG', `${RVNG}/enabled.txt`, 0, H('3'), 'required', '1.0');
  ins.run(13, 'Project RVNG', `${RVNG}/Scripts/main.lua`, 42, H('4'), 'required', '1.0'); // the current main.lua
  ins.run(14, 'Project RVNG', `.\\${RVNG.replace(/\//g, '\\')}\\Extra.lua`, 5, H('5'), 'required', '1.0'); // typed with .\ and backslashes
  db.close();

  db = openDb(file);
  const rows = svc.listApprovedMods(db);
  assert.deepEqual(rows.filter((r) => r.category === 'required').map((r) => r.version), ['1.0', '1.0', '1.0', '1.0'], 'no required pseudo-build');
  assert.deepEqual(rows.filter((r) => r.version.includes('#')).map((r) => [r.version, r.category]), [['1.0#10', 'retired']]);
  assert.ok(rows.every((r) => r.path === integrity.canonPath(r.path)), 'paths are stored as the scan compares them');
  const f = (n, size, h) => ({ path: `${RVNG}/${n}`, size, sha256: H(h) });
  const full = [f('Scripts/main.lua', 42, '4'), f('Scripts/json.lua', 41, '2'), f('enabled.txt', 0, '3'), f('Extra.lua', 5, '5')];
  assert.equal(verdict(rows, full).verdict, 'clean');
  for (let i = 0; i < full.length; i++) {
    assert.equal(verdict(rows, full.filter((_, j) => j !== i)).verdict, 'rejected', `without ${full[i].path}`);
  }
  assert.equal(verdict(rows, [full[0]]).verdict, 'rejected', 'main.lua alone is not a build');
  const stale = verdict(rows, [f('Scripts/main.lua', 40, '1'), ...full.slice(1)]);
  assert.ok(codes(stale).includes('outdated_mod') && !codes(stale).includes('approved_mod_tampered'));
  db.close();
}));

test('approving a build again with a changed file keeps the old file known: its pilots are told to update, never flagged', async () => {
  const env = await setup();
  try {
    const ini = (h) => ({ name: 'UE4SS', version: '3.0.1', category: 'required', path: 'ACE8/Binaries/Win64/ue4ss/UE4SS-settings.ini', size: 20, sha256: H(h) });
    await env.admin('POST', '/api/admin/mods', { mods: [ini('6')] }); // pinned with the console on
    const early = await env.register('Early001'); const late = await env.register('Late0001');
    const files = (h) => ({ files: [...BASE_FILES, MOD_FILE, { ...ini(h), name: undefined }] });
    assert.equal((await scan(early, env, files('6'))).verdict, 'clean');
    await env.admin('POST', '/api/admin/mods', { mods: [ini('7')] }); // fixed and approved again under the same version
    const old = await scan(early, env, files('6'));
    assert.deepEqual([old.verdict, codes(old).includes('outdated_mod'), codes(old).includes('approved_mod_tampered')], ['rejected', true, false]);
    assert.equal((await me(early)).status, 'active');
    assert.equal((await scan(late, env, files('7'))).verdict, 'clean');
    // The same file approved again changes nothing.
    await env.admin('POST', '/api/admin/mods', { mods: [ini('7')] });
    assert.equal((await env.admin('GET', '/api/admin/mods')).filter((m) => m.name === 'UE4SS').length, 2);
    await assert.rejects(env.admin('POST', '/api/admin/mods', { mods: [{ ...ini('7'), version: '3.0.1#9' }] }), rejectsWith(400, /without #/));
  } finally { await env.close(); }
});

test('the "pinned by another mod" check sees every spelling of a path, and its message says how to get out', async () => {
  const env = await setup(); // Project RVNG pins MOD_FILE
  try {
    const p = MOD_FILE.path;
    for (const spelling of [`./${p}`, p.toLowerCase(), `.\\${p.replace(/\//g, '\\')}`, `/${p}`, p.replace('/Mods/', '//Mods/')]) {
      await assert.rejects(env.admin('POST', '/api/admin/mods', { mods: [{ name: 'UE4SS', version: '3.0.1', category: 'required', ...MOD_FILE, path: spelling }] }),
        rejectsWith(409, /already pinned by the mod "Project RVNG" version "" \(id \d+\).*retire it/), spelling);
    }
    await assert.rejects(env.admin('POST', '/api/admin/mods', { name: 'X', ...MOD_FILE, path: 'ACE8/../x.pak' }), rejectsWith(400));

    // A loader build from an older release that holds the competitive mod's files: retire it, upload it again
    // without them, then the competitive mod can be approved and released.
    const env2 = env.db; svc.retireMods(env2, { name: 'Project RVNG' });
    const loader = [{ path: 'ACE8/Binaries/Win64/ue4ss/UE4SS.dll', size: 10, sha256: H('1') }];
    await env.admin('POST', '/api/admin/mods', { mods: [...loader, MOD_FILE].map((f) => ({ name: 'UE4SS', version: '3.0.2', category: 'required', ...f })) });
    const rvng = { name: 'Project RVNG', version: '1.1', category: 'required', ...MOD_FILE, sha256: H('9') };
    await assert.rejects(env.admin('POST', '/api/admin/mods', { mods: [rvng] }), rejectsWith(409, /version "3.0.2"/));
    await env.admin('POST', '/api/admin/mods/retire', { name: 'UE4SS', version: '3.0.2' });
    await env.admin('POST', '/api/admin/mods', { mods: loader.map((f) => ({ name: 'UE4SS', version: '3.0.2', category: 'required', ...f })) });
    await env.admin('POST', '/api/admin/mods', { mods: [rvng] });
    const pilot = await env.register('Recover1');
    assert.equal((await scan(pilot, env, { files: [...BASE_FILES, ...loader, { ...MOD_FILE, sha256: H('9') }] })).verdict, 'clean');
    // Version-less builds from before versions existed are retired by name alone.
    const r = await env.admin('POST', '/api/admin/mods/retire', { name: 'Project RVNG' });
    assert.ok(r.filter((m) => m.name === 'Project RVNG' && m.version === '').every((m) => m.category === 'retired'));
  } finally { await env.close(); }
});

test('upgrade repair: admin-settled K/D written from the logs by an earlier upgrade, and draws never counted', () => tempDb((file) => {
  let db = openDb(file);
  const ins = db.prepare("INSERT INTO players (name, api_key_hash, api_secret, rating, peak_rating, kills, deaths, wins, losses, draws, created_at) VALUES (?, ?, 's', 1500, 1500, ?, ?, ?, ?, 0, 0)");
  ins.run('RepA', 'ka', 7, 5, 1, 0); ins.run('RepB', 'kb', 5, 7, 0, 1);
  const rules = JSON.stringify(config.match.defaultRules);
  const m = db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, winner, score_a, score_b, rating_delta_a, rating_delta_b,
    flags, kills_a, deaths_a, kills_b, deaths_b, created_at) VALUES (?, 1, 2, ?, 'verified', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 5)`);
  // Settled by an admin at 3-1 (credited 3/1 and 1/3), but an earlier upgrade stored the disputed logs' 5/2 and 2/4.
  m.run('m_set', rules, 1, 3, 1, JSON.stringify([{ code: 'score_mismatch' }]), 5, 2, 2, 4);
  // Settled late from the logs after a sweep: the logs were credited, keep them.
  m.run('m_late', rules, 1, 2, 1, JSON.stringify([{ code: 'no_reports' }]), 2, 2, 1, 2);
  // Two draws from the first release, which had no draws column.
  m.run('m_d1', rules, null, 2, 2, '[]', 2, 2, 2, 2); m.run('m_d2', rules, null, 0, 0, '[]', 0, 0, 0, 0);
  db.close();

  db = openDb(file);
  const kd = (id) => Object.values({ ...db.prepare('SELECT kills_a, deaths_a, kills_b, deaths_b FROM matches WHERE id = ?').get(id) });
  assert.deepEqual(kd('m_set'), [3, 1, 1, 3]);
  assert.deepEqual(kd('m_late'), [2, 2, 1, 2]);
  const draws = () => db.prepare('SELECT draws FROM players ORDER BY id').all().map((p) => p.draws);
  assert.deepEqual(draws(), [2, 2]);
  svc.resolveDispute(db, 'm_d1', { void: true });
  assert.deepEqual(draws(), [1, 1], 'voiding a pre-upgrade draw leaves the other draw on record');
  db.close();
  db = openDb(file);
  assert.deepEqual(draws(), [1, 1]);
  db.close();
}));
