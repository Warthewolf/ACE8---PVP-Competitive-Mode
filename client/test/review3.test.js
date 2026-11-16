'use strict';
// Regression tests for the third review: the bridge's shown state after a failed tick, and approve --exclude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBridge, writeJson, cmdApprove } = require('../rvng');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-review3-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

test('bridge: cancelling during a scan back-off while the server is down does not leave "waiting" on screen', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    let down = false;
    const call = async (m, p) => {
      if (down) throw httpError(503, 'server unavailable');
      if (p === '/api/integrity/report') throw httpError(429, 'wait 9s before scanning again');
      if (p === '/api/queue/status') return { state: 'idle' };
      return {};
    };
    const bridge = createBridge({ game, call });
    const state = () => JSON.parse(fs.readFileSync(path.join(bridge.dir, 'state.json'), 'utf8'));
    writeJson(path.join(bridge.dir, 'request.json'), { action: 'queue' });
    await bridge.tick();
    assert.equal(state().state, 'waiting');
    // A failed tick while the repeat is still pending keeps 'waiting'.
    down = true;
    await bridge.tick().catch((e) => bridge.fail(e));
    assert.equal(state().state, 'waiting');

    writeJson(path.join(bridge.dir, 'request.json'), { action: 'cancel' });
    await assert.rejects(bridge.tick(), /unavailable/);
    bridge.fail(httpError(503, 'server unavailable'));
    assert.equal(state().state, 'idle', 'nothing is pending any more');
    assert.equal(state().message, 'Ready', 'no stale "Scanning again in ..."');
    assert.match(state().error, /unavailable/);
  } finally { fs.rmSync(game, { recursive: true }); }
});

test('rvng approve --exclude leaves another mod\'s folder out of a loader approval', () => {
  const ue = 'ACE8/Binaries/Win64/ue4ss';
  const game = tree({ [`${ue}/UE4SS.dll`]: 'dll', [`${ue}/UE4SS-settings.ini`]: 'ini', [`${ue}/Mods/mods.txt`]: 'ProjectRVNG : 1',
    [`${ue}/Mods/ProjectRVNG/Scripts/main.lua`]: 'lua', [`${ue}/Mods/ProjectRVNG/enabled.txt`]: '', [`${ue}/Mods/ProjectRVNGExtra/x.lua`]: 'x' });
  const out = path.join(game, 'mods.json');
  const log = console.log; console.log = () => {};
  try {
    const { mods } = cmdApprove({ game, path: ue, name: 'UE4SS', version: '3.0.1', category: 'required', exclude: 'Mods/ProjectRVNG', out });
    assert.deepEqual(mods.map((m) => m.path).sort(), [`${ue}/Mods/ProjectRVNGExtra/x.lua`, `${ue}/Mods/mods.txt`, `${ue}/UE4SS-settings.ini`, `${ue}/UE4SS.dll`]);
    const full = cmdApprove({ game, path: ue, name: 'UE4SS', exclude: `${ue}/mods/projectrvng,Mods/ProjectRVNGExtra`, out }).mods;
    assert.deepEqual(full.map((m) => m.path).sort(), [`${ue}/Mods/mods.txt`, `${ue}/UE4SS-settings.ini`, `${ue}/UE4SS.dll`], 'game-root paths and lists work too');
    assert.throws(() => cmdApprove({ game, path: ue, name: 'UE4SS', exclude: true, out }), /--exclude needs a folder/);
    // PowerShell tab completion gives .\ACE8\...\ue4ss\ ; an exclude given from the game root still applies.
    const tab = cmdApprove({ game, path: `.\\${ue.replace(/\//g, '\\')}\\`, name: 'UE4SS', exclude: `${ue}/Mods/ProjectRVNG,Mods/ProjectRVNGExtra`, out }).mods;
    assert.deepEqual(tab.map((m) => m.path).sort(), [`${ue}/Mods/mods.txt`, `${ue}/UE4SS-settings.ini`, `${ue}/UE4SS.dll`]);
    assert.throws(() => cmdApprove({ game, path: ue, name: 'UE4SS', exclude: 'Mods/ProjectRVGN', out }), /--exclude matched no files: .*projectrvgn/);
  } finally { console.log = log; fs.rmSync(game, { recursive: true }); }
});

// Fifth review.
test('bridge: if the server was unreachable at start, later ticks keep asking until an open match is shown', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    let down = true;
    const match = { id: 'm_9', state: 'pending', role: 'host' };
    const call = async (m, p) => {
      if (down) throw httpError(503, 'server unavailable');
      if (p === '/api/queue/status') return { state: 'matched', match };
      return {};
    };
    const bridge = createBridge({ game, call });
    const state = () => JSON.parse(fs.readFileSync(path.join(bridge.dir, 'state.json'), 'utf8'));
    await bridge.resync('Companion connected').catch(() => bridge.setState('idle', { message: 'Companion connected (server unreachable)' }));
    await assert.rejects(bridge.tick(), /unavailable/);
    down = false;
    await bridge.tick();
    assert.deepEqual([state().state, state().match.id], ['matched', 'm_9']);
  } finally { fs.rmSync(game, { recursive: true }); }
});

test('rvng approve: one build from several paths, with its roots; a second approval never silently overwrites the first', () => {
  const ue = 'ACE8/Binaries/Win64/ue4ss';
  const game = tree({ [`${ue}/UE4SS.dll`]: 'dll', [`${ue}/Mods/mods.txt`]: 'ProjectRVNG : 1', [`${ue}/Mods/ProjectRVNG/Scripts/main.lua`]: 'lua',
    'ACE8/Binaries/Win64/dwmapi.dll': 'proxy' });
  const cwd = process.cwd(); const log = console.log; console.log = () => {};
  try {
    process.chdir(game);
    const r = cmdApprove({ game, path: `${ue},ACE8/Binaries/Win64/dwmapi.dll`, exclude: 'Mods/ProjectRVNG', name: 'UE4SS', version: '3.0.2', category: 'required' });
    assert.deepEqual(r.roots, [ue, 'ACE8/Binaries/Win64/dwmapi.dll']);
    assert.deepEqual(r.mods.map((m) => m.path).sort(), ['ACE8/Binaries/Win64/dwmapi.dll', `${ue}/Mods/mods.txt`, `${ue}/UE4SS.dll`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.out, 'utf8')).roots, r.roots);
    // The same approval again is fine; another part of the same build into the same default file is not.
    cmdApprove({ game, path: `${ue},ACE8/Binaries/Win64/dwmapi.dll`, exclude: 'Mods/ProjectRVNG', name: 'UE4SS', version: '3.0.2', category: 'required' });
    assert.throws(() => cmdApprove({ game, path: 'ACE8/Binaries/Win64/dwmapi.dll', name: 'UE4SS', version: '3.0.2', category: 'required' }),
      /already holds an approval of .*ue4ss/);
  } finally { process.chdir(cwd); console.log = log; fs.rmSync(game, { recursive: true }); }
});
