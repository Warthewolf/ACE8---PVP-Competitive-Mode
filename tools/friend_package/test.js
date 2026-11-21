'use strict';
// The friend package end to end on fake game folders (no real game, no Steam, no network):
//   node --test tools/friend_package/test.js
// make.js builds it from an "admin" install checked against the approvals; install.ps1 puts it into a "friend" install
// that has another mod, a tool's leftover and an anti-cheat folder; uninstall.ps1 takes it out again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { make, safeRel } = require('./make');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const put = (root, rel, data) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const has = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

const CLEAN = { 'Game/Binaries/Win64/AceCombat8.exe': 'exe', 'Game/Binaries/Win64/steam_appid.txt': '2288340\n', 'Game/Content/Paks/game.pak': 'pak' };
const UE4SS = { 'Game/Binaries/Win64/dwmapi.dll': 'proxy', 'Game/Binaries/Win64/ue4ss/UE4SS.dll': 'loader', 'Game/Binaries/Win64/ue4ss/UE4SS-settings.ini': '[General]\n' };
const RVNG = { 'Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG/Scripts/main.lua': '-- rvng', 'Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG/enabled.txt': '' };

function library(root, files, build = '26002268') {
  const game = path.join(root, 'steamapps', 'common', 'ACE COMBAT 8');
  for (const [rel, d] of Object.entries(files)) put(game, rel, d);
  put(root, 'steamapps/appmanifest_2288340.acf', `"AppState"\n{\n\t"appid"\t\t"2288340"\n\t"installdir"\t\t"ACE COMBAT 8"\n\t"buildid"\t\t"${build}"\n}\n`);
  return game;
}
const approval = (files) => ({ roots: [], mods: Object.entries(files).map(([p, d]) => ({ path: p, size: Buffer.byteLength(d), sha256: sha(d), category: 'required' })) });

function ps(script, env) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: 120000, env: { ...process.env, RVNG_ASSUME: '1', RVNG_TEST_NOGAME: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { throw new Error(`${path.basename(script)} failed:\n${e.stdout}\n${e.stderr}`); }
}

test('friend package: approval paths are checked before use', () => {
  assert.equal(safeRel('Game/Binaries/Win64/dwmapi.dll'), 'Game/Binaries/Win64/dwmapi.dll');
  for (const bad of ['../x', 'Game/../../x', '/etc/x', 'C:/x', 'Game\\x', 'Game//x', '']) assert.throws(() => safeRel(bad), /unsafe path/);
});

test('friend package: build, install, uninstall', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-friend-'));
  try {
    // the admin's install and the approvals
    const admin = library(path.join(tmp, 'admin'), { ...CLEAN, ...UE4SS, ...RVNG });
    const base = path.join(tmp, 'baseline');
    put(base, 'baseline-steam-26002268.json', JSON.stringify({ gameVersion: 'steam-26002268',
      manifest: { files: Object.entries(CLEAN).map(([p, d]) => ({ path: p, size: d.length, sha256: sha(d) })) }, aircraft: {} }));
    put(base, 'mods-UE4SS-3.0.1.json', JSON.stringify(approval(UE4SS)));
    put(base, 'mods-Project_RVNG-0.4.4.json', JSON.stringify(approval(RVNG)));

    // a file that differs from its approval stops the build
    put(admin, 'Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG/Scripts/main.lua', '-- edited');
    assert.throws(() => make({ game: admin, baseline: base, out: path.join(tmp, 'out') }), /not the approved Project_RVNG 0\.4\.4 file/);
    put(admin, 'Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG/Scripts/main.lua', RVNG['Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG/Scripts/main.lua']);
    put(admin, 'credentials.json', '{"secret":1}');
    const { zip, stage, info } = make({ game: admin, baseline: base, out: path.join(tmp, 'out'), site: 'https://example.test' });
    assert.ok(fs.statSync(zip).size > 0);
    assert.equal(info.install.length, 5);
    assert.equal(info.steamBuild, '26002268');
    const pkg = path.join(stage, 'RVNG');
    assert.ok(!has(pkg, 'companion/credentials.json'), "the admin's credentials never go in");
    assert.match(read(pkg, 'READ ME FIRST.txt'), /https:\/\/example\.test/);

    // a friend's install with another UE4SS mod, an older UE4SS, a tool's leftover, a pak mod and an EAC folder
    const friend = library(path.join(tmp, 'friend'), { ...CLEAN,
      'Game/Binaries/Win64/ue4ss/UE4SS.dll': 'older loader',
      'Game/Binaries/Win64/ue4ss/Mods/OtherMod/Scripts/main.lua': '-- other',
      'Game/Binaries/Win64/ue4ss/Mods/mods.txt': 'OtherMod : 1\n',
      'Game/Binaries/Win64/ue4ss/UE4SS.log': 'log',
      'Game/Binaries/Win64/IGCS_ImGuiSettings.ini': '[x]',
      'Game/Content/Paks/~mods/skin_P.pak': 'mod pak',
      'Game/Saved/Config/Game.ini': 'user settings',
      'EasyAntiCheat/Settings.json': '{}' });
    const eacBefore = fs.statSync(path.join(friend, 'EasyAntiCheat', 'Settings.json')).mtimeMs;
    const home = path.join(tmp, 'home');
    put(home, 'Downloads/credentials.json', JSON.stringify({ server: 'https://example.test', apiKey: 'k', apiSecret: 's', playerId: 1, name: 'Wingman' }));
    const env = { RVNG_GAME: friend, USERPROFILE: home };

    const out = ps(path.join(pkg, 'scripts', 'install.ps1'), env);
    assert.match(out, /Game build 26002268/);
    for (const [rel, d] of Object.entries({ ...UE4SS, ...RVNG })) assert.equal(read(friend, rel), d, `${rel} installed`);
    for (const rel of ['Game/Binaries/Win64/ue4ss/Mods/OtherMod/Scripts/main.lua', 'Game/Binaries/Win64/ue4ss/Mods/mods.txt',
      'Game/Binaries/Win64/IGCS_ImGuiSettings.ini', 'Game/Content/Paks/~mods/skin_P.pak']) assert.ok(!has(friend, rel), `${rel} moved aside`);
    assert.ok(has(friend, 'Game/Saved/Config/Game.ini'), 'the player\'s settings stay');
    assert.ok(has(friend, 'Game/Binaries/Win64/ue4ss/UE4SS.log'), 'a log is not a mod');
    assert.equal(fs.statSync(path.join(friend, 'EasyAntiCheat', 'Settings.json')).mtimeMs, eacBefore, 'the anti-cheat folder untouched');
    assert.doesNotMatch(out, /EasyAntiCheat/i, 'and never listed');
    const backups = fs.readdirSync(path.join(pkg, 'backup'));
    assert.equal(backups.length, 1);
    const moved = JSON.parse(fs.readFileSync(path.join(pkg, 'backup', backups[0], 'backup.json'), 'utf8').replace(/^\uFEFF/, '')).moved;
    assert.ok(moved.includes('Game/Binaries/Win64/ue4ss/UE4SS.dll'), 'the older loader is backed up, not overwritten');
    assert.equal(JSON.parse(read(pkg, 'companion/credentials.json')).name, 'Wingman', 'credentials.json taken from Downloads');
    assert.ok(!has(home, 'Downloads/credentials.json'));
    assert.equal(read(pkg, 'game-path.txt').trim(), friend);

    // installing again changes nothing and backs up nothing
    ps(path.join(pkg, 'scripts', 'install.ps1'), env);
    assert.equal(fs.readdirSync(path.join(pkg, 'backup')).length, 1, 'a second install has nothing to back up');

    // the wrong game build is refused (the default answer to "install anyway" is no)
    const patched = library(path.join(tmp, 'patched'), CLEAN, '27000000');
    assert.throws(() => ps(path.join(pkg, 'scripts', 'install.ps1'), { ...env, RVNG_GAME: patched }), /build 27000000[\s\S]*Nothing was changed/);
    assert.ok(!has(patched, 'Game/Binaries/Win64/dwmapi.dll'));

    ps(path.join(pkg, 'scripts', 'uninstall.ps1'), env);
    assert.ok(!has(friend, 'Game/Binaries/Win64/dwmapi.dll'));
    assert.ok(!has(friend, 'Game/Binaries/Win64/ue4ss/Mods/ProjectRVNG'));
    assert.equal(read(friend, 'Game/Binaries/Win64/ue4ss/UE4SS.dll'), 'older loader', 'the old loader is back');
    assert.equal(read(friend, 'Game/Binaries/Win64/ue4ss/Mods/OtherMod/Scripts/main.lua'), '-- other');
    assert.equal(read(friend, 'Game/Content/Paks/~mods/skin_P.pak'), 'mod pak');
    assert.equal(read(friend, 'Game/Binaries/Win64/IGCS_ImGuiSettings.ini'), '[x]');
    assert.ok(!has(pkg, 'game-path.txt'));
    assert.ok(has(pkg, 'companion/credentials.json'), 'the account stays');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
