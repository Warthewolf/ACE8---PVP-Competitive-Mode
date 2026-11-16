'use strict';
// Regression tests for the fifth review: builds approved in parts, pseudo-builds left required by an earlier
// upgrade, outdated-mod naming, body charsets and career totals after earlier voids.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, log, queuePair, MOD_FILE, BASE_FILES, AIRCRAFT, H, config } = require('./helpers');
const { signedHeaders } = require('../../client/lib/sign');
const { openDb } = require('../src/db');
const integrity = require('../src/integrity');
const svc = require('../src/service');

const scan = (p, env, over) => p.call('POST', '/api/integrity/report', env.cleanReport(over));
const RVNG = 'ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG';
const UE = 'ACE8/Binaries/Win64/ue4ss';
const DLL = { path: 'ACE8/Binaries/Win64/dwmapi.dll', size: 12, sha256: H('a') };
const f = (p, size, h) => ({ path: p, size, sha256: H(h) });
const baseline = { manifest: { files: BASE_FILES }, aircraft: AIRCRAFT };
const verdict = (approved, files) => integrity.evaluate({ files: [...BASE_FILES, ...files], runtime: { aircraft: AIRCRAFT } }, baseline, approved);
function tempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-r5-'));
  try { return fn(path.join(dir, 'db.sqlite')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('a required pseudo-build stored by an earlier upgrade is retired when the database is opened', () => tempDb((file) => {
  let db = openDb(file);
  const ins = db.prepare('INSERT INTO approved_mods (id, name, path, size, sha256, category, version) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const main = f(`${RVNG}/scripts/main.lua`, 42, '4'); const enabled = f(`${RVNG}/enabled.txt`, 0, '3');
  ins.run(10, 'Project RVNG', main.path.toLowerCase(), 40, H('1'), 'required', '1.0'); // the stale file took the real slot
  ins.run(11, 'Project RVNG', enabled.path.toLowerCase(), 0, H('3'), 'required', '1.0');
  // The current file as a pseudo-build: releases name it after its own row id.
  ins.run(12, 'Project RVNG', main.path.toLowerCase(), 42, H('4'), 'required', '1.0#12');
  db.close();
  db = openDb(file);
  const rows = svc.listApprovedMods(db);
  assert.equal(rows.find((r) => r.version === '1.0#12').category, 'retired');
  assert.equal(verdict(rows, [main]).verdict, 'rejected', 'a one-file install no longer passes');
  db.close();
}));

test('a build approved in parts: a re-upload retires the files it dropped under its own folders only; outdated files name the right mod', async () => {
  const env = await setup();
  try {
    const main1 = f(`${RVNG}/Scripts/main.lua`, 42, '4'); const net = f(`${RVNG}/Scripts/net.lua`, 7, '5'); const en = f(`${RVNG}/enabled.txt`, 0, '3');
    const as = (name, version, files) => files.map((x) => ({ name, version, category: 'required', ...x }));
    svc.retireMods(env.db, { name: 'Project RVNG' }); // the setup's version-less build
    await env.admin('POST', '/api/admin/mods', { roots: [RVNG], mods: as('Project RVNG', '1.0', [main1, net, en]) });
    await env.admin('POST', '/api/admin/mods', { roots: [DLL.path], mods: as('Project RVNG', '1.0', [DLL]) }); // a second part of the same build
    const pilot = await env.register('Parts001');
    assert.equal((await scan(pilot, env, { files: [...BASE_FILES, main1, net, en, DLL] })).verdict, 'clean');
    // 1.0 approved again under the same version without net.lua: the fixed build passes, the dropped file is retired.
    await env.admin('POST', '/api/admin/mods', { roots: [RVNG], mods: as('Project RVNG', '1.0', [main1, en]) });
    assert.equal((await scan(pilot, env, { files: [...BASE_FILES, main1, en, DLL] })).verdict, 'clean');
    const stale = await scan(pilot, env, { files: [...BASE_FILES, main1, net, en, DLL] });
    assert.deepEqual(stale.findings.filter((x) => x.code === 'outdated_mod').map((x) => [x.name, x.version]), [['Project RVNG', '1.0']]);
    const noDll = await scan(pilot, env, { files: [...BASE_FILES, main1, en] });
    assert.equal(noDll.verdict, 'rejected', 'the part outside the re-uploaded folder is still required');

    // A changed file kept as "1.0#<id>" is reported as version 1.0.
    await env.admin('POST', '/api/admin/mods', { roots: [RVNG], mods: as('Project RVNG', '1.0', [f(main1.path, 43, '6'), en]) });
    const old = await scan(pilot, env, { files: [...BASE_FILES, main1, en, DLL] });
    assert.deepEqual(old.findings.filter((x) => x.code === 'outdated_mod').map((x) => [x.name, x.version]), [['Project RVNG', '1.0']]);
  } finally { await env.close(); }
});

test('outdated files are named after the mod that still has a current build at that path', () => {
  const p = `${RVNG}/scripts/main.lua`.toLowerCase();
  const rows = [
    { id: 3, name: 'UE4SS', version: '3.0.2', category: 'retired', path: p, size: 40, sha256: H('1') }, // captured by an old loader upload
    { id: 9, name: 'Project RVNG', version: '1.0', category: 'retired', path: p, size: 40, sha256: H('1') },
    { id: 14, name: 'Project RVNG', version: '1.1', category: 'required', path: p, size: 41, sha256: H('2') },
  ];
  const r = verdict(rows, [f(p, 40, '1')]);
  assert.deepEqual(r.findings.filter((x) => x.code === 'outdated_mod').map((x) => [x.name, x.version]), [['Project RVNG', '1.0']]);
});

test('request bodies must be UTF-8: UTF-7 and UTF-16 cannot slip deep nesting past the check', async () => {
  const env = await setup();
  try {
    const a = await env.register('Charset1'); const b = await env.register('Charset2');
    const m = await queuePair(env, a, b);
    const p = `/api/matches/${m.id}/report`;
    const post = async (body, charset) => {
      const headers = { 'content-type': `application/json; charset=${charset}`, ...signedHeaders(m.host, 'POST', p, body.toString('utf8')) };
      const res = await fetch(env.url + p, { method: 'POST', body, headers });
      return [res.status, (await res.json()).error];
    };
    const deep = JSON.stringify(log()).slice(0, -1) + ',"x":' + '['.repeat(3000) + ']'.repeat(3000) + '}';
    const utf7 = Buffer.from(deep.replace(/\[/g, '+AFs-').replace(/\]/g, '+AF0-'), 'ascii');
    assert.deepEqual(await post(utf7, 'utf-7'), [415, 'request bodies must be UTF-8']);
    assert.deepEqual(await post(Buffer.from(deep, 'utf16le'), 'utf-16le'), [415, 'request bodies must be UTF-8']);
    assert.deepEqual(await post(Buffer.from(JSON.stringify(log())), 'UTF-8'), [200, undefined]);
  } finally { await env.close(); }
});

test('career totals are recounted from verified matches, repairing totals that voids on earlier releases took too much from', () => tempDb((file) => {
  let db = openDb(file);
  const ins = db.prepare("INSERT INTO players (name, api_key_hash, api_secret, rating, peak_rating, kills, deaths, wins, losses, draws, created_at) VALUES (?, ?, 's', 1500, 1500, ?, ?, ?, ?, ?, 0)");
  ins.run('TotA', 'ka', 1, 4, 0, 0, 0); ins.run('TotB', 'kb', 0, 0, 0, 0, 0); // over-subtracted by voids on an older release
  const rules = JSON.stringify(config.match.defaultRules);
  db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, winner, score_a, score_b, rating_delta_a, rating_delta_b, flags,
    kills_a, deaths_a, kills_b, deaths_b, created_at) VALUES ('m_ok', 1, 2, ?, 'verified', 1, 5, 2, 10, -10, '[]', 5, 3, 2, 5, 5)`).run(rules);
  db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, flags, created_at) VALUES ('m_void', 1, 2, ?, 'void', '[{"code":"admin_void"}]', 6)`).run(rules);
  db.close();
  db = openDb(file);
  const t = (id) => ({ ...db.prepare('SELECT kills, deaths, wins, losses, draws FROM players WHERE id = ?').get(id) });
  assert.deepEqual([t(1), t(2)], [{ kills: 5, deaths: 3, wins: 1, losses: 0, draws: 0 }, { kills: 2, deaths: 5, wins: 0, losses: 1, draws: 0 }]);
  db.close();
}));
