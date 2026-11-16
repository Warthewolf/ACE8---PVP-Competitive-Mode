'use strict';
// Regression tests for the second review of the audit fixes: scanner, approve helper and bridge daemon.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../lib/scan');
const { createBridge, writeJson, cmdApprove } = require('../rvng');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-review-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
function fakeServer(routes) {
  const calls = [];
  const call = async (m, p, b) => {
    calls.push({ route: `${m} ${p}`, body: b });
    for (const [k, fn] of Object.entries(routes)) if (`${m} ${p}`.startsWith(k)) return fn(b);
    throw httpError(404, 'no route');
  };
  return { call, calls };
}

test('links are reported whatever their name or place, including names the excludes match', { skip: process.platform === 'win32' }, () => {
  const root = tree({ 'ACE8/Content/Paks/a.pak': 'x', 'ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG/Scripts/main.lua': 'x', 'Saved/Logs/game.log': 'log' });
  const cheats = tree({ 'fast_P.pak': 'cheat', 'enabled.txt': '', 'Scripts/main.lua': 'x' });
  const links = ['ACE8/Content/Paks/zz.log', 'ACE8/Content/Paks/~mods.DMP', 'ACE8/Binaries/Win64/ue4ss/Mods/GodMode.log', 'ACE8/Saved', 'Saved/Paks'];
  try {
    for (const l of links) fs.symlinkSync(cheats, path.join(root, l));
    const files = scan(root, { useCache: false });
    for (const l of links) assert.deepEqual(files.find((f) => f.path === l), { path: l, size: -1, sha256: 'symlink' }, l);
    assert.ok(!files.some((f) => f.path === 'Saved/Logs/game.log'), 'ordinary logs are still skipped');
  } finally { fs.rmSync(root, { recursive: true }); fs.rmSync(cheats, { recursive: true }); }
});

test('rvng approve never pins files the scanner does not report (UE4SS.log, crash dumps)', () => {
  const ue = 'ACE8/Binaries/Win64/ue4ss';
  const game = tree({ [`${ue}/UE4SS.dll`]: 'dll', [`${ue}/UE4SS.log`]: 'changes every run', [`${ue}/crash_1.dmp`]: 'dump',
    [`${ue}/UE4SS-settings.ini`]: 'ini', [`${ue}/Mods/mods.txt`]: 'ProjectRVNG : 1' });
  const out = path.join(game, 'mods.json');
  const warn = console.warn; const log = console.log;
  console.warn = () => {}; console.log = () => {};
  try {
    const { mods, skipped } = cmdApprove({ game, path: ue, name: 'UE4SS', version: '3.0.1', category: 'required', out });
    const pinned = mods.map((m) => m.path).sort();
    const reported = scan(game, { useCache: false }).map((f) => f.path).filter((p) => p.startsWith(ue + '/')).sort();
    assert.deepEqual(pinned, reported, 'exactly the files a player scan reports');
    assert.deepEqual(skipped.sort(), [`${ue}/UE4SS.log`, `${ue}/crash_1.dmp`]);
    assert.ok(mods.every((m) => m.version === '3.0.1' && m.category === 'required'));
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).mods, mods);
  } finally { console.warn = warn; console.log = log; fs.rmSync(game, { recursive: true }); }
});

test('bridge: a 401 (skewed clock) on the result upload is retried, not set aside', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    let status = 401;
    const srv = fakeServer({ 'POST /api/matches/m_1/report': () => { if (status) throw httpError(status, 'stale or invalid timestamp'); return { state: 'verified' }; } });
    const bridge = createBridge({ game, call: srv.call });
    const f = path.join(bridge.dir, 'result.json');
    writeJson(f, { matchId: 'm_1' });
    await assert.rejects(bridge.tick(), /stale/);
    assert.ok(fs.existsSync(f) && !fs.existsSync(f + '.failed'));
    status = 0;
    await bridge.tick();
    assert.ok(!fs.existsSync(f));
    assert.equal(bridge.current().state, 'reported');
  } finally { fs.rmSync(game, { recursive: true }); }
});

test('bridge: a spaced-out scan (429) is repeated by itself; a failed join never leaves "scanning" behind', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    let scans = 0; let joinError = null;
    const srv = fakeServer({
      'POST /api/integrity/report': () => { if (++scans === 1) throw httpError(429, 'wait 1s before scanning again'); return { verdict: 'clean', integrityToken: 'it_x', findings: [] }; },
      'POST /api/queue/join': () => { if (joinError) throw joinError; return { state: 'queued', waitingSec: 0 }; },
      'GET /api/queue/status': () => ({ state: 'queued', waitingSec: 1 }),
    });
    const bridge = createBridge({ game, call: srv.call, region: 'EU' });
    const state = () => JSON.parse(fs.readFileSync(path.join(bridge.dir, 'state.json'), 'utf8'));
    writeJson(path.join(bridge.dir, 'request.json'), { action: 'queue' });
    await bridge.tick();
    assert.equal(state().state, 'waiting');
    await bridge.tick();
    assert.equal(scans, 1, 'not repeated before the server allows it');
    await new Promise((r) => setTimeout(r, 1100));
    await bridge.tick();
    assert.equal(state().state, 'queued');
    assert.equal(srv.calls.find((c) => c.route === 'POST /api/queue/join').body.region, 'eu', 'regions are sent in lower case');

    joinError = httpError(400, 'region must be one of: ...');
    writeJson(path.join(bridge.dir, 'request.json'), { action: 'queue', region: 'mars' });
    await assert.rejects(bridge.tick(), /region/);
    assert.equal(state().state, 'queued', 'back to the state the server has, not "scanning"');
    assert.match(state().error, /region/);
  } finally { fs.rmSync(game, { recursive: true }); }
});
