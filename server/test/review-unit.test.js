'use strict';
// Regression tests for the second review of the audit fixes: pure functions and database upgrades.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { log, mirror, AIRCRAFT } = require('./helpers');
const { reconcile } = require('../src/matchlog');
const { parseTrustProxy } = require('../src/config');
const { rateLimiter, clientKey } = require('../src/app');
const { openDb } = require('../src/db');
const svc = require('../src/service');

const RULES = { timeLimitSec: 600, killTarget: 5, respawn: true, specialWeapons: true, aircraftBans: [] };
const ctx = { rules: RULES, aircraftStats: AIRCRAFT, playerA: 1, playerB: 2, minDurationSec: 30 };
const codes = (r) => r.flags.map((f) => f.code);

test('TRUST_PROXY takes a hop count or proxy addresses, ignores case and stray whitespace, and refuses true', () => {
  assert.deepEqual(['', 'false', ' FALSE\r', '1', ' 1 ', '1\r', '2', 'loopback, 10.0.0.0/8'].map(parseTrustProxy),
    [false, false, false, 1, 1, 1, 2, ['loopback', '10.0.0.0/8']]);
  assert.equal(parseTrustProxy(undefined), false);
  for (const v of ['true', 'True', ' TRUE\r']) assert.throws(() => parseTrustProxy(v), /X-Forwarded-For/);
});

test('sign-up limiter: IPv4-mapped and IPv6 /64 keys, bounded memory, no full scan per request', () => {
  assert.equal(clientKey('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(clientKey('2001:db8:aa:bb:1::5'), clientKey('2001:0db8:00aa:00bb:ffff:ffff:ffff:ffff'));
  assert.notEqual(clientKey('2001:db8:aa:bb::1'), clientKey('2001:db8:aa:bc::1'));
  const allow = rateLimiter({ windowMs: 1000, max: 1, maxTracked: 100 });
  for (let i = 0; i < 10000; i++) allow(`k${i}`, 0);
  assert.equal(allow('k9999', 1), false, 'recent keys are still limited');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) allow(`n${i}`, 2);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 2000, 'admission stays cheap with a full table');
  assert.equal(allow('fresh', 5000), true, 'expired windows are dropped');
});

test('live stats: the highest and lowest samples are both checked, in either direction', () => {
  const up = { ...AIRCRAFT.f22a, turnRate: 39 }; const down = { ...AIRCRAFT.f22a, hp: 50 };
  // Trainer already on at match start, one clean sample later: the highest sample still has it.
  const onAtStart = reconcile(log({ stats: up, minStats: AIRCRAFT.f22a }), mirror(), ctx);
  assert.deepEqual(onAtStart.flags.filter((f) => f.code === 'aircraft_stat_modified').map((f) => [f.player, f.stat]), [[1, 'turnRate']]);
  const lowered = reconcile(log({ stats: AIRCRAFT.f22a, minStats: down }), mirror(), ctx);
  assert.ok(lowered.flags.some((f) => f.code === 'aircraft_stat_modified' && f.stat === 'hp'));
  // Both samples tampered the same way: one flag per stat.
  assert.equal(reconcile(log({ stats: up }), mirror(), ctx).flags.filter((f) => f.code === 'aircraft_stat_modified').length, 1);
  const noMin = log(); delete noMin.runtime.aircraftMin;
  assert.ok(codes(reconcile(noMin, mirror(), ctx)).includes('runtime_stats_missing'));
  assert.deepEqual(reconcile(log(), mirror(), ctx).flags, []);
});

test('upgrading a database keeps matches in play verifiable and voids exact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-mig-'));
  const file = path.join(dir, 'old.sqlite');
  try {
    let db = openDb(file);
    const ins = db.prepare("INSERT INTO players (name, api_key_hash, api_secret, rating, peak_rating, kills, deaths, wins, losses, created_at) VALUES (?, ?, 's', ?, ?, ?, ?, ?, ?, 0)");
    ins.run('OldA', 'ka', 1520, 1520, 5, 3, 1, 0); ins.run('OldB', 'kb', 1480, 1480, 2, 6, 0, 1);
    ins.run('OldC', 'kc', 1500, 1500, 0, 0, 0, 0); ins.run('OldD', 'kd', 1500, 1500, 0, 0, 0, 0);
    svc.putBaseline(db, { gameVersion: '1.0.0', manifest: { files: [] }, aircraft: AIRCRAFT });
    const scan = db.prepare("INSERT INTO integrity_reports (player_id, game_version, verdict, findings, mods, manifest_hash, created_at) VALUES (?, '1.0.0', 'clean', '[]', '[]', '', 10)");
    for (const id of [1, 2, 3, 4]) scan.run(id);
    db.prepare(`INSERT INTO queue (player_id, rating, region, integrity_id, joined_at) VALUES (3, 1500, 'eu', 3, 20)`).run();
    db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, lobby_code, created_at) VALUES ('m_live', 1, 2, ?, 'live', 'R1', 20)`).run(JSON.stringify(RULES));
    // A verified match where pilot A also crashed once (deaths above the opponent's kills).
    db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, winner, score_a, score_b, rating_delta_a, rating_delta_b, created_at)
      VALUES ('m_old', 1, 2, ?, 'verified', 1, 5, 2, 20, -20, 5)`).run(JSON.stringify(RULES));
    const rep = db.prepare('INSERT INTO match_reports (match_id, player_id, report, received_at) VALUES (?, ?, ?, 0)');
    rep.run('m_old', 1, JSON.stringify({ self: { kills: 5, deaths: 3 } })); rep.run('m_old', 2, JSON.stringify({ self: { kills: 2, deaths: 5 } }));
    // Back to the first release's schema.
    for (const [t, c] of [['matches', 'game_version'], ['matches', 'kills_a'], ['matches', 'deaths_a'], ['matches', 'kills_b'],
      ['matches', 'deaths_b'], ['matches', 'live_at'], ['matches', 'swept_at'], ['queue', 'game_version']]) db.exec(`ALTER TABLE ${t} DROP COLUMN ${c}`);
    db.exec(`DROP TABLE approved_mods; CREATE TABLE approved_mods (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'cosmetic', UNIQUE (path, sha256))`);
    db.close();

    db = openDb(file);
    assert.equal(db.prepare("SELECT game_version FROM matches WHERE id = 'm_live'").get().game_version, '1.0.0');
    assert.equal(db.prepare('SELECT game_version FROM queue WHERE player_id = 3').get().game_version, '1.0.0');
    const old = db.prepare("SELECT kills_a, deaths_a, kills_b, deaths_b FROM matches WHERE id = 'm_old'").get();
    assert.deepEqual({ ...old }, { kills_a: 5, deaths_a: 3, kills_b: 2, deaths_b: 5 });

    const player = (id) => db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    db.prepare("INSERT INTO match_reports (match_id, player_id, report, received_at) VALUES ('m_live', 1, ?, ?)").run(JSON.stringify(log()), Date.now());
    db.prepare("UPDATE matches SET state = 'awaiting_reports' WHERE id = 'm_live'").run();
    assert.equal(svc.submitReport(db, player(2), 'm_live', mirror()).state, 'verified', 'an honest match in play at upgrade still verifies');

    const before = player(1);
    svc.resolveDispute(db, 'm_old', { void: true });
    const a = player(1);
    assert.deepEqual([before.kills - a.kills, before.deaths - a.deaths], [5, 3], 'voiding a pre-upgrade match undoes exactly what it credited');
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
