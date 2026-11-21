'use strict';
// The stats check's companion half: the game version from Steam's build id, runtime.json's stats in the report, and
// `rvng baseline` taking a clean install's stats from its runtime.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReport, steamBuild, cmdBaseline } = require('../rvng');

const stats = (over = {}) => ({
  format: 'rvng_stats_1', leaves: 369197,
  groups: {
    PlaneDataMap_: { count: 2, digest: '98638eedc02b6218', entries: { 1010: '0123456789abcdef', 2010: 'fedcba9876543210' } },
    PartsDataMap_: { count: 1, digest: 'beb5c4aa9257fe12', entries: { 2001802: '00000000000000aa' } },
    WeaponDataMap_: { count: 0, digest: 'cbf29ce484222325', entries: {}, missing: true },
  },
  planes: { 1010: { speedMax: 1890, speedStall: 140, maxHealth: 107, levels: 31, digest: '0123456789abcdef' } },
  ...over,
});

// steamapps/common/ACE COMBAT 8 with Game/Binaries/Win64/steam_appid.txt, and steamapps/appmanifest_<id>.acf
function library({ appid = '1234560', buildid = '26002268', manifest = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-steam-'));
  const game = path.join(root, 'steamapps', 'common', 'ACE COMBAT 8');
  const win64 = path.join(game, 'Game', 'Binaries', 'Win64');
  fs.mkdirSync(win64, { recursive: true });
  fs.writeFileSync(path.join(win64, 'steam_appid.txt'), appid + '\n');
  fs.writeFileSync(path.join(win64, 'AceCombat8.exe'), 'exe');
  if (manifest) {
    fs.writeFileSync(path.join(root, 'steamapps', `appmanifest_${appid}.acf`),
      `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"name"\t\t"ACE COMBAT 8"\n\t"buildid"\t\t"${buildid}"\n}\n`);
  }
  return { root, game };
}
const bridge = (game) => path.join(game, 'ProjectRVNG', 'bridge');
function writeRuntime(game, data) {
  fs.mkdirSync(bridge(game), { recursive: true });
  fs.writeFileSync(path.join(bridge(game), 'runtime.json'), JSON.stringify(data));
}

test('stats: the game version is Steam\'s build id of the install', () => {
  const { root, game } = library();
  try {
    assert.equal(steamBuild(game), 'steam-26002268');
    assert.equal(steamBuild(path.join(root, 'nowhere')), null, 'not a Steam install: null');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  const none = library({ manifest: false });
  try { assert.equal(steamBuild(none.game), null, 'no appmanifest: null'); } finally { fs.rmSync(none.root, { recursive: true, force: true }); }
  const odd = library({ appid: '../../x' });
  try { assert.equal(steamBuild(odd.game), null, 'an appid that is not a number is not followed'); } finally { fs.rmSync(odd.root, { recursive: true, force: true }); }
});

test('stats: the report carries runtime.json\'s stats and the Steam version', () => {
  const { root, game } = library();
  try {
    writeRuntime(game, { stats: stats(), aircraft: {}, at: 1 });
    const r = buildReport(game, { noCache: true });
    assert.equal(r.gameVersion, 'steam-26002268');
    assert.deepEqual(r.runtime.stats, stats());
    assert.equal(buildReport(game, { noCache: true, gameVersion: '1.0.2' }).gameVersion, '1.0.2', '--version still wins');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stats: rvng baseline takes the clean install\'s stats from its runtime.json', () => {
  const { root, game } = library();
  const out = path.join(root, 'baseline.json');
  const logs = []; const warns = [];
  const log = console.log; const warn = console.warn;
  console.log = (m) => logs.push(m); console.warn = (m) => warns.push(m);
  try {
    assert.ok(!fs.existsSync(bridge(game)));
    assert.throws(() => cmdBaseline({ game, out }), /no stats at .*runtime\.json: start the game with the RVNG mod and wait at the main menu/);
    assert.ok(fs.existsSync(bridge(game)), 'the bridge folder made, so the mod can write runtime.json into it');
    writeRuntime(game, { stats: stats({ groups: { PlaneDataMap_: { count: 0, digest: 'cbf29ce484222325', entries: {} } } }) });
    assert.throws(() => cmdBaseline({ game, out }), /incomplete/, 'no planes read: refused');

    writeRuntime(game, { stats: stats() });
    cmdBaseline({ game, out });
    const b = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(b.gameVersion, 'steam-26002268', 'the version from Steam');
    assert.deepEqual(b.aircraft, stats(), 'the stats as the baseline\'s reference');
    assert.ok(b.manifest.files.some((f) => /AceCombat8\.exe$/.test(f.path)), 'the files too');
    assert.ok(!b.manifest.files.some((f) => /ProjectRVNG/i.test(f.path)), 'the mod\'s own folder (the bridge) is not part of it');
    assert.match(logs.join('\n'), /game version steam-26002268.*2 planes, 1 parts, 3 rows in 3 tables/);
    assert.match(warns.join('\n'), /not loaded at the main menu .*: WeaponDataMap_/, 'a table the menu lacks is noted');

    assert.equal(b.aircraft.match, undefined, 'no match capture yet');
    assert.match(warns.join('\n'), /no match capture/);
    // the match capture: runtime_match.json next to runtime.json goes in as aircraft.match
    const matchStats = { format: 'rvng_stats_1', groups: { DT_NPC_Weapon_ON: { count: 1, digest: '0000000000000001', entries: { row_1: '0000000000000002' }, optional: true } } };
    fs.writeFileSync(path.join(bridge(game), 'runtime_match.json'), JSON.stringify({ stats: matchStats }));
    cmdBaseline({ game, out });
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).aircraft.match, matchStats, 'the match capture in the baseline');
    assert.match(logs.join('\n'), /match capture from .*runtime_match\.json: DT_NPC_Weapon_ON/);
    assert.throws(() => cmdBaseline({ game, out, match: path.join(root, 'nope.json') }), /no match capture at/);
    fs.rmSync(path.join(bridge(game), 'runtime_match.json'));

    // --aircraft: a runtime.json taken elsewhere
    const other = path.join(root, 'other-runtime.json');
    fs.writeFileSync(other, JSON.stringify({ stats: stats({ leaves: 1 }) }));
    cmdBaseline({ game, out, aircraft: other, version: '1.0.2' });
    const b2 = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(b2.gameVersion, '1.0.2');
    assert.equal(b2.aircraft.leaves, 1);
  } finally {
    console.log = log; console.warn = warn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
