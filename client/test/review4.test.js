'use strict';
// Regression tests for the sixth review: retries that back off, a late result posted in the same tick as a new
// match, empty option values, approval files left by earlier releases, and where credentials.json is looked for.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createBridge, writeJson, cmdApprove } = require('../rvng');

const CLI = path.join(__dirname, '..', 'rvng.js');
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-review4-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
const quiet = (fn) => { const [l, w] = [console.log, console.warn]; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };

test('bridge: a resync that keeps failing (banned, stale credentials, long outage) backs off instead of asking every second', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  let now = Date.now(); const realNow = Date.now; Date.now = () => now;
  try {
    let calls = 0;
    const bridge = createBridge({ game, call: async () => { calls++; throw httpError(403, 'player banned'); } });
    await bridge.resync('Companion connected').catch(() => {});
    let errors = 0;
    for (let s = 0; s < 120; s++) { now += 1000; await bridge.tick().catch(() => errors++); }
    assert.ok(calls <= 7 && errors === calls - 1, `${calls} requests and ${errors} errors in two minutes`);
  } finally { Date.now = realNow; fs.rmSync(game, { recursive: true }); }
});

test('bridge: a late result of an earlier match, sent in the tick that matched the pilot again, leaves the new match on screen', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    const m2 = { id: 'm_new', state: 'pending', role: 'host' };
    const call = async (m, p) => {
      if (p === '/api/integrity/report') return { verdict: 'clean', integrityToken: 't' };
      if (p === '/api/queue/join') return { state: 'matched', match: m2 };
      if (p === '/api/queue/status') return { state: 'matched', match: m2 };
      if (p.endsWith('/report')) return { id: 'm_old', state: 'verified' };
      return {};
    };
    const bridge = createBridge({ game, call });
    const state = () => JSON.parse(fs.readFileSync(path.join(bridge.dir, 'state.json'), 'utf8'));
    writeJson(path.join(bridge.dir, 'request.json'), { action: 'queue' });
    writeJson(path.join(bridge.dir, 'result.json'), { matchId: 'm_old', self: { kills: 1, deaths: 0 } });
    await bridge.tick();
    assert.deepEqual([state().state, state().match.id], ['matched', 'm_new']);
    assert.match(state().message, /Result submitted \(verified\) for m_old/);
    assert.ok(!fs.existsSync(path.join(bridge.dir, 'result.json')), 'the late result was sent');
    await bridge.tick();
    assert.deepEqual([state().state, state().match.id], ['matched', 'm_new'], 'the new match is still polled');
    // The result of the match on screen still ends it.
    writeJson(path.join(bridge.dir, 'result.json'), { matchId: 'm_new', self: { kills: 1, deaths: 0 } });
    await bridge.tick();
    assert.equal(state().state, 'reported');
  } finally { fs.rmSync(game, { recursive: true }); }
});

test('rvng approve: --version "" is the version-less build, and an option given without a value is refused', () => {
  const ue = 'ACE8/Binaries/Win64/ue4ss';
  const game = tree({ [`${ue}/UE4SS.dll`]: 'dll' });
  try {
    const run = (...extra) => spawnSync(process.execPath, [CLI, 'approve', '--game', game, '--path', ue, '--name', 'UE4SS', '--category', 'required', ...extra],
      { cwd: game, encoding: 'utf8' });
    const r = run('--version', '', '--out', 'v.json');
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(game, 'v.json'), 'utf8')).mods.map((m) => m.version), ['']);
    const bare = run('--out', 'w.json', '--version');
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /--version needs a value/);
    assert.throws(() => quiet(() => cmdApprove({ game, path: ue, name: true })), /--name required/);
  } finally { fs.rmSync(game, { recursive: true }); }
});

test('rvng approve replaces an approval file written by an earlier release (no roots) when it holds the same paths, and still guards other files', () => {
  const ue = 'ACE8/Binaries/Win64/ue4ss'; const dll = 'ACE8/Binaries/Win64/dwmapi.dll'; const rv = `${ue}/Mods/ProjectRVNG`;
  const game = tree({ [`${ue}/UE4SS.dll`]: 'dll', [`${rv}/Scripts/main.lua`]: 'lua', [dll]: 'proxy', 'ACE8/Content/Paks/~mods/x.pak': 'x' });
  const cwd = process.cwd();
  try {
    process.chdir(game);
    const legacy = (file, paths) => writeJson(file, { mods: paths.map((p) => ({ name: 'x', version: '3.0.1', path: p, size: 1, sha256: 'a'.repeat(64) })) });
    // a8cc166's README: the proxy DLL approve overwrote the loader folder's file, so it holds dwmapi.dll only.
    legacy('mods-UE4SS-3.0.1.json', [dll]);
    legacy('mods-Project_RVNG-1.0.json', [`${rv}/Scripts/main.lua`]);
    const loader = quiet(() => cmdApprove({ game, path: `${ue},${dll}`, exclude: 'Mods/ProjectRVNG', name: 'UE4SS', version: '3.0.1', category: 'required' }));
    assert.deepEqual(JSON.parse(fs.readFileSync(loader.out, 'utf8')).roots, [ue, dll]);
    quiet(() => cmdApprove({ game, path: rv.replace(/\//g, '\\'), name: 'Project RVNG', version: '1.0', category: 'required' }));
    // A file that holds something this approval does not cover is still never overwritten.
    legacy('mods-Pak-1.json', ['ACE8/Content/Paks/~mods/x.pak', dll]);
    assert.throws(() => quiet(() => cmdApprove({ game, path: dll, name: 'Pak', version: '1' })), /already holds an approval of 1 file\(s\) outside ACE8/);
    writeJson('mods-Two-1.json', { roots: [ue, dll], mods: [] });
    assert.throws(() => quiet(() => cmdApprove({ game, path: dll, name: 'Two', version: '1' })), /already holds an approval of .*ue4ss, .*dwmapi/);
  } finally { process.chdir(cwd); fs.rmSync(game, { recursive: true }); }
});

test('credentials.json is found next to rvng.js when the command runs from another folder, and a missing one says where to put it', () => {
  const app = tree({});
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  const elsewhere = tree({});
  try {
    fs.cpSync(path.join(__dirname, '..', 'rvng.js'), path.join(app, 'client', 'rvng.js'));
    fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(app, 'client', 'lib'), { recursive: true });
    const run = () => spawnSync(process.execPath, [path.join(app, 'client', 'rvng.js'), 'scan', '--game', game], { cwd: elsewhere, encoding: 'utf8' });
    const none = run();
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /credentials\.json not found in .* or .*client: .*--credentials/);
    // Saved next to the companion app, as the website says; the server is not running, so the scan fails later.
    writeJson(path.join(app, 'client', 'credentials.json'), { server: 'http://127.0.0.1:9', apiKey: 'k', apiSecret: 's', playerId: 1 }, 0o600);
    const found = run();
    assert.doesNotMatch(found.stderr, /credentials\.json|ENOENT/);
    assert.match(found.stderr, /fetch failed/);
  } finally { for (const d of [app, game, elsewhere]) fs.rmSync(d, { recursive: true, force: true }); }
});
