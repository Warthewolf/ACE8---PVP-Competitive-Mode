'use strict';
// The stats check (rvng_stats_1): the game's combat tables as fingerprints (mod/ProjectRVNG/Scripts/rvng_stats.lua,
// docs/re/STATS.md), compared with the clean install's. Unit checks of the comparison, then the whole path through the
// API: the baseline upload, a clean scan, a modified part, a modified plane, an added part, a forged report.
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, compareStats, validStats } = require('../src/integrity');
const { setup, BASE_FILES, MOD_FILE } = require('./helpers');

const hex = (n) => n.toString(16).padStart(16, '0');
function stats({ part = hex(0xaa), plane2010 = hex(0x2010), extraPart = false, dropPlane = false, speed2010 = 2600 } = {}) {
  const planes = { 1010: hex(0x1010), 2010: plane2010 };
  if (dropPlane) delete planes[2010];
  const parts = { 2001802: part, 2001803: hex(0xbb) };
  if (extraPart) parts[9999999] = hex(0xcc);
  // (a table's own fingerprint: anything that differs when its rows do)
  const dig = (o) => hex(Object.entries(o).reduce((n, [k, v]) => (n * 31 + Number(k) + parseInt(v.slice(-6), 16)) % 0xfffffffffff, 7));
  return {
    format: 'rvng_stats_1', leaves: 369197, ms: 900, slices: 30, skipped: { SoftObjectProperty: 456 },
    groups: {
      PlaneDataMap_: { count: Object.keys(planes).length, digest: dig(planes), entries: planes },
      PartsDataMap_: { count: Object.keys(parts).length, digest: dig(parts), entries: parts },
      WeaponDataMap_: { count: 1, digest: hex(0x77), entries: { 1: hex(0x71) } },
    },
    planes: {
      1010: { speedMax: 1890, speedStall: 140, maxHealth: 107, levels: 31, digest: planes[1010] },
      2010: { speedMax: speed2010, speedStall: 170, maxHealth: 103, levels: 31, digest: planes[2010] },
    },
  };
}
const REF = stats();
const codes = (f) => f.map((x) => x.code);

test('stats: the same tables pass, with nothing to report', () => {
  assert.deepEqual(compareStats(stats(), REF), []);
});

test('stats: a changed part names its table and row', () => {
  const f = compareStats(stats({ part: hex(0xab) }), REF);
  assert.deepEqual(f, [{ code: 'aircraft_stat_modified', severity: 'critical', table: 'PartsDataMap_', row: '2001802' }]);
});

test('stats: a changed plane names it, with its headline numbers either side', () => {
  const f = compareStats(stats({ plane2010: hex(0x2011), speed2010: 3100 }), REF);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0], { code: 'aircraft_stat_modified', severity: 'critical', table: 'PlaneDataMap_', row: '2010',
    expected: { speedMax: 2600, speedStall: 170, maxHealth: 103 }, actual: { speedMax: 3100, speedStall: 170, maxHealth: 103 } });
});

test('stats: an added row and a missing row', () => {
  const added = compareStats(stats({ extraPart: true }), REF);
  assert.deepEqual(added.map((x) => [x.code, x.row]), [['stat_row_added', '9999999']]);
  assert.equal(added[0].severity, 'critical');
  const gone = compareStats(stats({ dropPlane: true }), REF);
  assert.deepEqual(gone.map((x) => [x.code, x.row, x.severity]), [['stat_row_missing', '2010', 'high']]);
});

test('stats: a table missing from the report, and rows that add up to a different table', () => {
  const s = stats(); delete s.groups.WeaponDataMap_;
  assert.deepEqual(codes(compareStats(s, REF)), ['stat_table_missing']);
  const t = stats(); t.groups.WeaponDataMap_ = { ...t.groups.WeaponDataMap_, digest: hex(0x78) };
  assert.deepEqual(compareStats(t, REF), [{ code: 'aircraft_stat_modified', severity: 'critical', table: 'WeaponDataMap_' }]);
});

test('stats: an optional table is compared when both have it; missing only noted; one the clean install lacked is skipped', () => {
  const ref = stats(); ref.groups.DT_NPC_Weapon = { count: 1, digest: hex(0x90), entries: { row_1: hex(0x91) }, optional: true };
  ref.groups.DT_NPC_Weapon_ON = { count: 0, digest: hex(0x92), entries: {}, missing: true, optional: true };
  const same = stats(); same.groups.DT_NPC_Weapon = { ...ref.groups.DT_NPC_Weapon };
  assert.deepEqual(compareStats(same, ref), []);
  const changed = stats(); changed.groups.DT_NPC_Weapon = { count: 1, digest: hex(0x93), entries: { row_1: hex(0x94) }, optional: true };
  assert.deepEqual(compareStats(changed, ref).map((x) => [x.code, x.table, x.row]), [['aircraft_stat_modified', 'DT_NPC_Weapon', 'row_1']]);
  const absent = stats(); absent.groups.DT_NPC_Weapon = { count: 0, digest: hex(0x92), entries: {}, missing: true, optional: true };
  const f = compareStats(absent, ref);
  assert.deepEqual(f, [{ code: 'stat_table_unchecked', severity: 'info', table: 'DT_NPC_Weapon' }]);
  const baseline = { manifest: { files: BASE_FILES }, aircraft: ref };
  const rep = { files: [...BASE_FILES, MOD_FILE], runtime: { stats: absent } };
  assert.equal(evaluate(rep, baseline, [{ name: 'Project RVNG', ...MOD_FILE, category: 'required' }]).verdict, 'clean',
    'an optional table not loaded doesn\'t fail the scan');
  const req = stats(); req.groups.WeaponDataMap_ = { ...req.groups.WeaponDataMap_, missing: true, entries: {} };
  assert.deepEqual(codes(compareStats(req, REF)), ['stat_table_missing'], 'a required table reported missing still fails');
});

test('stats: no stats, malformed stats, and the bounds', () => {
  assert.deepEqual(codes(compareStats(undefined, REF)), ['runtime_stats_missing']);
  for (const bad of [{ format: 'other', groups: {} }, { ...stats(), groups: { PlaneDataMap_: { digest: 'XYZ', entries: {} } } },
    { ...stats(), groups: { PlaneDataMap_: { digest: hex(1), entries: { 1: 'not-a-digest' } } } },
    { ...stats(), groups: { ['x'.repeat(65)]: { digest: hex(1), entries: {} } } }]) {
    assert.deepEqual(compareStats(bad, REF).map((x) => [x.code, x.severity]), [['malformed_report', 'critical']]);
  }
  const many = { format: 'rvng_stats_1', groups: { G: { digest: hex(1), entries: {} } } };
  for (let i = 0; i < 20001; i++) many.groups.G.entries[i] = hex(i);
  assert.equal(validStats(many), false, 'over 20000 rows: refused');
  // a report that changes thousands of rows: its first 50 named, then a count
  const ref = { format: 'rvng_stats_1', groups: { G: { digest: hex(1), entries: {} } } };
  const got = { format: 'rvng_stats_1', groups: { G: { digest: hex(2), entries: {} } } };
  for (let i = 0; i < 300; i++) { ref.groups.G.entries[i] = hex(i); got.groups.G.entries[i] = hex(i + 1000); }
  const f = compareStats(got, ref);
  assert.equal(f.length, 51);
  assert.deepEqual(f[50], { code: 'aircraft_stat_modified', severity: 'critical', more: 250 });
});

test('stats: evaluate rejects on a modified table and passes the clean one; a baseline without stats passes nobody', () => {
  const baseline = { manifest: { files: BASE_FILES }, aircraft: REF };
  const approved = [{ name: 'Project RVNG', ...MOD_FILE, category: 'required' }];
  const rep = (s) => ({ files: [...BASE_FILES, MOD_FILE], runtime: { stats: s, aircraft: {} } });
  assert.equal(evaluate(rep(stats()), baseline, approved).verdict, 'clean');
  assert.equal(evaluate(rep(stats({ part: hex(0xab) })), baseline, approved).verdict, 'rejected');
  assert.equal(evaluate(rep(undefined), baseline, approved).verdict, 'rejected');
  const noRef = evaluate(rep(stats()), { manifest: { files: BASE_FILES }, aircraft: {} }, approved);
  assert.equal(noRef.verdict, 'rejected');
  assert.ok(codes(noRef.findings).includes('no_reference_stats'));
});

test('stats: the whole path through the API', async () => {
  const env = await setup();
  try {
    const put = await env.admin('PUT', '/api/admin/baselines', { gameVersion: 'steam-26002268', manifest: { files: BASE_FILES }, aircraft: REF });
    assert.deepEqual(put, { gameVersion: 'steam-26002268', active: true, files: 2, aircraft: 2, tables: 3, rows: 5 });
    // the admin page's list of builds: a summary of each, newest first, no file lists
    const listed = (await env.admin('GET', '/api/admin/baselines')).find((b) => b.gameVersion === 'steam-26002268');
    assert.deepEqual({ ...listed, createdAt: typeof listed.createdAt },
      { gameVersion: 'steam-26002268', active: true, createdAt: 'number', files: 2, aircraft: 2, tables: 3, rows: 5, matchCapture: false });
    assert.equal((await env.admin('GET', '/api/admin/baselines'))[0].gameVersion, 'steam-26002268', 'newest first');
    const pilot = await env.register('NotAdmin');
    await assert.rejects(pilot.call('GET', '/api/admin/baselines'), (e) => e.status === 401 || e.status === 403, 'admin only');
    await assert.rejects(env.admin('PUT', '/api/admin/baselines', { gameVersion: 'x', manifest: { files: [] },
      aircraft: { format: 'rvng_stats_1', groups: { G: { digest: 'bad', entries: {} } } } }), /not a well-formed rvng_stats_1/);

    const scan = (p, s) => p.call('POST', '/api/integrity/report', env.cleanReport({ gameVersion: 'steam-26002268',
      runtime: { stats: s, aircraft: {}, loadedModules: ['ntdll.dll'] } }));
    const a = await env.register('StatsClean');
    const clean = await scan(a, stats());
    assert.equal(clean.verdict, 'clean');
    assert.match(clean.integrityToken, /^it_/, 'a clean scan gets its token');

    const b = await env.register('StatsPart');
    const part = await scan(b, stats({ part: hex(0xab) }));
    assert.equal(part.verdict, 'rejected');
    assert.ok(part.findings.some((f) => f.code === 'aircraft_stat_modified' && f.table === 'PartsDataMap_' && f.row === '2001802'));
    const me = await b.call('GET', '/api/me');
    assert.equal(me.status, 'flagged', 'a modified table in a pilot\'s own scan puts the account under review');

    const c = await env.register('StatsAdded');
    const added = await scan(c, stats({ extraPart: true }));
    assert.equal(added.verdict, 'rejected');
    assert.equal((await c.call('GET', '/api/me')).status, 'flagged', 'an added row too');

    const d = await env.register('StatsForged');
    const forged = await scan(d, { format: 'rvng_stats_1', groups: { PlaneDataMap_: { digest: 'nope', entries: {} } } });
    assert.equal(forged.verdict, 'rejected');
    assert.ok(forged.findings.some((f) => f.code === 'malformed_report'));
  } finally { await env.close(); }
});

test('stats: the in-match pass end to end: a changed match-time table disputes the match and flags its pilot', async () => {
  const env = await setup();
  try {
    const matchRef = { format: 'rvng_stats_1', groups: {
      DT_NPC_Weapon_ON: { count: 2, digest: hex(0x500), entries: { row_1: hex(0x501), row_2: hex(0x502) }, optional: true },
      DT_NPC_WeaponDurability_ON: { count: 0, digest: hex(0x600), entries: {}, missing: true, optional: true } } };
    await env.admin('PUT', '/api/admin/baselines', { gameVersion: 'steam-1', manifest: { files: BASE_FILES }, aircraft: { ...REF, match: matchRef } });
    await assert.rejects(env.admin('PUT', '/api/admin/baselines', { gameVersion: 'steam-2', manifest: { files: BASE_FILES },
      aircraft: { ...REF, match: { format: 'rvng_stats_1', groups: { G: { digest: 'x', entries: {} } } } } }), /aircraft\.match: not a well-formed/);
    const log = (me, opp, k, d, s, os, st) => {
      const events = [];
      for (let i = 0; i < k; i++) events.push({ t: 30 + i, type: 'kill', actor: 'self' }, { t: 30 + i, type: 'death', actor: 'opponent' });
      for (let i = 0; i < d; i++) events.push({ t: 90 + i, type: 'kill', actor: 'opponent' }, { t: 90 + i, type: 'death', actor: 'self' });
      return { format: 'native_dm', gameVersion: 'steam-1', runtimeVersion: '0.4.4', durationSec: 214, endReason: 'time_limit',
        self: { aircraftId: me, kills: k, deaths: d, score: s }, opponent: { aircraftId: opp, kills: d, deaths: k, score: os }, events,
        ...(st !== undefined ? { stats: st } : {}) };
    };
    const play = async (names, hostStats, guestStats) => {
      const ps = [await env.register(names[0]), await env.register(names[1])];
      for (const p of ps) {
        const s = await p.call('POST', '/api/integrity/report', env.cleanReport({ gameVersion: 'steam-1',
          runtime: { stats: stats(), aircraft: {}, loadedModules: ['ntdll.dll'] } }));
        assert.equal(s.verdict, 'clean');
        await p.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region: 'eu' });
      }
      const st = await ps[0].call('GET', '/api/queue/status');
      const host = st.match.role === 'host' ? ps[0] : ps[1]; const guest = host === ps[0] ? ps[1] : ps[0];
      const id = st.match.id;
      await host.call('POST', `/api/matches/${id}/link`, { steamId: '76561190000000011' });
      await guest.call('POST', `/api/matches/${id}/link`, { steamId: '76561190000000022' });
      await host.call('POST', `/api/matches/${id}/report`, log('21010', '10034010', 2, 1, 3702, 2650.5, hostStats));
      const r = await guest.call('POST', `/api/matches/${id}/report`, log('10034010', '21010', 1, 2, 2650.5, 3702, guestStats));
      return { r, host, guest, id };
    };
    const clean = { format: 'rvng_stats_1', groups: { DT_NPC_Weapon_ON: { ...matchRef.groups.DT_NPC_Weapon_ON },
      DT_NPC_WeaponDurability_ON: { count: 0, digest: hex(0x600), entries: {}, missing: true, optional: true } } };
    const ok = await play(['MatchClean1', 'MatchClean2'], clean, clean);
    assert.equal(ok.r.state, 'verified', 'the clean match-time tables: verified');
    const none = await play(['MatchShort1', 'MatchShort2'], undefined, clean);
    assert.equal(none.r.state, 'verified', 'no in-match pass (a short match): nothing to compare, still verified');

    const bad = { format: 'rvng_stats_1', groups: { DT_NPC_Weapon_ON: { count: 2, digest: hex(0x5ff),
      entries: { row_1: hex(0x5fe), row_2: hex(0x502) }, optional: true } } };
    const cheat = await play(['MatchCheat1', 'MatchCheat2'], clean, bad);
    assert.equal(cheat.r.state, 'disputed');
    const m = await env.admin('GET', `/api/admin/matches/${cheat.id}`);
    const f = m.flags.find((x) => x.code === 'aircraft_stat_modified');
    assert.ok(f && f.table === 'DT_NPC_Weapon_ON' && f.row === 'row_1' && f.when === 'match' && f.player === cheat.guest.id,
      'the changed weapon row named, with its pilot: ' + JSON.stringify(m.flags));
    assert.equal((await cheat.guest.call('GET', '/api/me')).status, 'flagged', 'that pilot under review');
    assert.equal((await cheat.host.call('GET', '/api/me')).status, 'active', 'the other pilot not');
    // a malformed in-match pass is refused at the upload
    const ps = await play(['MatchBad1', 'MatchBad2'], clean, clean);
    assert.equal(ps.r.state, 'verified');
  } finally { await env.close(); }
});

test('stats: a result whose in-match pass is malformed fails the shape check', () => {
  const { validateShape } = require('../src/matchlog');
  const base = { format: 'native_dm', durationSec: 214, endReason: 'time_limit', events: [],
    self: { aircraftId: '1', kills: 0, deaths: 0, score: 0 }, opponent: { aircraftId: '2', kills: 0, deaths: 0, score: 0 } };
  assert.deepEqual(validateShape({ ...base }), []);
  assert.deepEqual(validateShape({ ...base, stats: null }), [], 'no pass (null): fine');
  assert.deepEqual(validateShape({ ...base, stats: stats() }), []);
  assert.deepEqual(validateShape({ ...base, stats: { format: 'rvng_stats_1', groups: { G: { digest: 'zz', entries: {} } } } }), ['stats']);
});
