'use strict';
// Regression tests for the sixth review: a repeated charset parameter, real builds whose version holds "#",
// the 409 that names every conflicting build, and the startup recount racing a server still running.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setup, log, queuePair, MOD_FILE, BASE_FILES, AIRCRAFT, H, config } = require('./helpers');
const { signedHeaders } = require('../../client/lib/sign');
const { openDb, tx } = require('../src/db');
const integrity = require('../src/integrity');
const svc = require('../src/service');

const scan = (p, env, over) => p.call('POST', '/api/integrity/report', env.cleanReport(over));
const rejectsWith = (code, re) => (e) => e.status === code && (!re || re.test(e.message));
const RVNG = 'ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG';
const UE = 'ACE8/Binaries/Win64/ue4ss';
const f = (p, size, h) => ({ path: p, size, sha256: H(h) });
const baseline = { manifest: { files: BASE_FILES }, aircraft: AIRCRAFT };
const verdict = (approved, files) => integrity.evaluate({ files: [...BASE_FILES, ...files], runtime: { aircraft: AIRCRAFT } }, baseline, approved);
function tempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-r6-'));
  try { return fn(path.join(dir, 'db.sqlite')); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('the charset check reads the charset body-parser decodes with: a repeated or hidden parameter cannot slip past it', async () => {
  const env = await setup();
  try {
    const a = await env.register('Charset3'); const b = await env.register('Charset4');
    const m = await queuePair(env, a, b);
    const p = `/api/matches/${m.id}/report`;
    const post = async (body, contentType) => {
      const headers = { 'content-type': contentType, ...signedHeaders(m.host, 'POST', p, body.toString('utf8')) };
      const res = await fetch(env.url + p, { method: 'POST', body, headers });
      return [res.status, (await res.json()).error];
    };
    const deep = JSON.stringify(log()).slice(0, -1) + ',"x":' + '['.repeat(3000) + ']'.repeat(3000) + '}';
    const utf7 = Buffer.from(deep.replace(/\[/g, '+AFs-').replace(/\]/g, '+AF0-'), 'ascii');
    const refused = [415, 'request bodies must be UTF-8'];
    assert.deepEqual(await post(utf7, 'application/json; charset=utf-8; charset=utf-7'), refused);
    assert.deepEqual(await post(utf7, 'application/json; a="x;charset=utf-8"; charset=utf-7'), refused);
    const wide = Buffer.from(JSON.stringify(log()).slice(0, -1) + ',"s":"∀","x":' + '['.repeat(3000) + ']'.repeat(3000) + '}', 'utf16le');
    assert.deepEqual(await post(wide, 'application/json;charset=utf-8;charset=utf-16le'), refused);
    assert.deepEqual(await post(wide, 'application/json; charset=UTF-8; charset=utf-16be'), refused);
    // Honest spellings still pass, and a UTF-8 deep body is still refused as too deep.
    assert.deepEqual(await post(Buffer.from(deep), 'application/json; charset=utf-8'), [400, 'JSON nested too deeply']);
    assert.deepEqual(await post(Buffer.from(JSON.stringify(log())), 'application/json; charset="UTF-8"'), [200, undefined]);
  } finally { await env.close(); }
});

test('a real build whose version holds "#" (accepted by earlier releases) stays required; only "<version>#<own id>" pseudo-builds are retired', () => tempDb((file) => {
  let db = openDb(file);
  const ins = db.prepare('INSERT INTO approved_mods (id, name, path, size, sha256, category, version) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const main = f(`${RVNG}/scripts/main.lua`.toLowerCase(), 42, '4'); const en = f(`${RVNG}/enabled.txt`.toLowerCase(), 0, '3');
  ins.run(4, 'Project RVNG', main.path, main.size, main.sha256, 'required', '1.0#2');
  ins.run(5, 'Project RVNG', en.path, en.size, en.sha256, 'required', '1.0#2');
  ins.run(7, 'UE4SS', `${UE}/ue4ss.dll`.toLowerCase(), 10, H('1'), 'required', '3.0#7'); // a pseudo-build: its own id
  db.close();
  db = openDb(file);
  const rows = svc.listApprovedMods(db);
  assert.deepEqual(rows.map((r) => [r.id, r.category]).sort((x, y) => x[0] - y[0]), [[4, 'required'], [5, 'required'], [7, 'retired']]);
  assert.equal(verdict(rows, [main, en]).verdict, 'clean', 'the "1.0#2" ladder still passes');
  // Retired later, it is reported under its real version.
  const old = rows.map((r) => (r.name === 'Project RVNG' ? { ...r, category: 'retired' } : r));
  assert.deepEqual(verdict(old, [main, en]).findings.filter((x) => x.code === 'outdated_mod').map((x) => x.version), ['1.0#2', '1.0#2']);
  db.close();
}));

test('the 409 names every build that pins the file, and retiring those rows by id lets the right build in without approving the other again', async () => {
  const env = await setup();
  try {
    svc.retireMods(env.db, { name: 'Project RVNG' });
    // An older release swept the competitive mod's file into two loader builds (version-less and 3.0.1).
    const ins = env.db.prepare("INSERT INTO approved_mods (name, path, size, sha256, category, version) VALUES ('UE4SS', ?, ?, ?, 'required', ?)");
    const loader = f(`${UE}/UE4SS.dll`, 10, '1');
    for (const v of ['', '3.0.1']) { ins.run(integrity.canonPath(loader.path), 10, loader.sha256, v); ins.run(integrity.canonPath(MOD_FILE.path), 42, MOD_FILE.sha256, v); }
    const ids = env.db.prepare("SELECT id FROM approved_mods WHERE name = 'UE4SS' AND path LIKE '%main.lua' ORDER BY id").all().map((r) => r.id);
    const rvng = { roots: [RVNG], mods: [{ name: 'Project RVNG', version: '1.1', category: 'required', ...MOD_FILE }] };
    const err = await env.admin('POST', '/api/admin/mods', rvng).catch((e) => e);
    assert.equal(err.status, 409);
    for (const id of ids) assert.match(err.message, new RegExp(`DELETE /api/admin/mods/${id}\\b`));
    assert.match(err.message, /version "" .*version "3\.0\.1"/);
    assert.match(err.message, /If it belongs to the other mod, leave its folder out of this approval: add it to rvng approve --exclude/);
    for (const id of ids) await env.admin('DELETE', `/api/admin/mods/${id}`);
    await env.admin('POST', '/api/admin/mods', rvng);
    const pilot = await env.register('Swept001');
    assert.equal((await scan(pilot, env, { files: [...BASE_FILES, loader, MOD_FILE] })).verdict, 'clean', 'the loader builds no longer require the file');
    await assert.rejects(env.admin('POST', '/api/admin/mods', { mods: [{ name: 'UE4SS', version: '3.0.2', category: 'required', ...MOD_FILE }] }),
      rejectsWith(409, /pinned by "Project RVNG" version "1\.1"/));
  } finally { await env.close(); }
});

test('the startup recount cannot erase a match that a server still running on the database verifies meanwhile', () => tempDb((file) => {
  const live = openDb(file);
  const ins = live.prepare("INSERT INTO players (name, api_key_hash, api_secret, rating, peak_rating, created_at) VALUES (?, ?, 's', 1500, 1500, 0)");
  ins.run('RaceA', 'ka'); ins.run('RaceB', 'kb');
  const rules = JSON.stringify(config.match.defaultRules);
  live.prepare("INSERT INTO matches (id, player_a, player_b, rules, state, created_at) VALUES ('m_race', 1, 2, ?, 'awaiting_reports', 1)").run(rules);
  // What the live server does when the second log arrives: the match and both pilots' totals in one transaction.
  const verify = () => tx(live, () => {
    live.prepare("UPDATE matches SET state = 'verified', winner = 1, score_a = 5, score_b = 2, kills_a = 5, deaths_a = 2, kills_b = 2, deaths_b = 5 WHERE id = 'm_race'").run();
    live.prepare('UPDATE players SET wins = wins + 1, kills = kills + 5, deaths = deaths + 2 WHERE id = 1').run();
    live.prepare('UPDATE players SET losses = losses + 1, kills = kills + 2, deaths = deaths + 5 WHERE id = 2').run();
  });
  // A second process opens the database; the live server verifies the match while the recount reads matches.
  const prepare = DatabaseSync.prototype.prepare;
  let verifiedDuringRecount = null;
  DatabaseSync.prototype.prepare = function (sql) {
    const st = prepare.call(this, sql);
    if (this === live || !/SELECT player_a, player_b, winner, kills_a/.test(sql)) return st;
    // Right after the recount has read the verified matches, before it writes the totals.
    return { all: (...a) => { const rows = st.all(...a); try { verify(); verifiedDuringRecount = true; } catch { verifiedDuringRecount = false; } return rows; } };
  };
  let second;
  try { second = openDb(file); } finally { DatabaseSync.prototype.prepare = prepare; }
  if (!verifiedDuringRecount) verify(); // the recount held the write lock: the live server verifies right after
  const t = (db, id) => ({ ...db.prepare('SELECT kills, deaths, wins, losses FROM players WHERE id = ?').get(id) });
  for (const db of [live, second]) {
    assert.deepEqual([t(db, 1), t(db, 2)], [{ kills: 5, deaths: 2, wins: 1, losses: 0 }, { kills: 2, deaths: 5, wins: 0, losses: 1 }]);
  }
  second.close(); live.close();
}));
