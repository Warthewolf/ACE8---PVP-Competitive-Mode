'use strict';
// Regression tests for the security audit: scanner and bridge daemon.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scan } = require('../lib/scan');
const { createBridge, writeJson } = require('../rvng');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-audit-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test('excludes are anchored: mods hidden in folders named Saved, Crashes, ShaderCache or bridge are still scanned', () => {
  const hidden = [
    'ACE8/Content/Paks/~mods/Saved/cheat_P.pak', 'ACE8/Content/Paks/Saved/zzz_fastjets_P.pak',
    'ACE8/Binaries/Win64/Mods/Saved/Scripts/main.lua', 'ACE8/Binaries/Win64/Mods/Crashes/dlls/main.dll',
    'ACE8/Binaries/Win64/ShaderCache/x.dll', 'ACE8/Content/Paks/ProjectRVNG/bridge/x_P.pak',
    'ProjectRVNG/bridge/sneaky_P.pak', 'ACE8/Saved/Paks/inside_saved_P.pak',
  ];
  const ignored = ['ACE8/Saved/Logs/ACE8.log', 'ACE8/Saved/Config/Windows/GameUserSettings.ini', 'ProjectRVNG/bridge/state.json', 'ACE8/Binaries/Win64/crash.dmp'];
  const root = tree(Object.fromEntries([...hidden, ...ignored].map((p) => [p, 'x'])));
  try {
    const got = scan(root, { useCache: false }).map((f) => f.path);
    for (const p of hidden) assert.ok(got.includes(p), p);
    for (const p of ignored) assert.ok(!got.includes(p), p);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('the hash cache can be bypassed, and restoring a patched file\'s mtime does not reuse the old hash', () => {
  const root = tree({ 'ACE8/Content/Paks/a.pak': 'clean!' });
  const f = path.join(root, 'ACE8/Content/Paks/a.pak');
  try {
    assert.equal(scan(root)[0].sha256, sha('clean!')); // fills the cache
    const { atime, mtime } = fs.statSync(f);
    fs.writeFileSync(f, 'cheat!'); // same size
    fs.utimesSync(f, atime, mtime);
    const stats = {};
    assert.equal(scan(root, { stats })[0].sha256, sha('cheat!'));
    assert.equal(stats.hashed, 1);
    // A forged cache entry is ignored with useCache: false (rvng --no-cache), and the cache is not rewritten.
    const cacheFile = path.join(root, '.rvng-cache.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache['ACE8/Content/Paks/a.pak'].sha256 = sha('clean!');
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
    assert.equal(scan(root)[0].sha256, sha('clean!')); // trusted when the cache is used
    assert.equal(scan(root, { useCache: false })[0].sha256, sha('cheat!'));
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))['ACE8/Content/Paks/a.pak'].sha256, sha('clean!'));
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('symlinked mod folders are reported as links, not followed or skipped', { skip: process.platform === 'win32' }, () => {
  const root = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  const elsewhere = tree({ 'fast_P.pak': 'cheat' });
  try {
    fs.symlinkSync(elsewhere, path.join(root, 'ACE8/Content/Paks/~mods'));
    const link = scan(root, { useCache: false }).find((f) => f.path === 'ACE8/Content/Paks/~mods');
    assert.deepEqual(link, { path: 'ACE8/Content/Paks/~mods', size: -1, sha256: 'symlink' });
  } finally { fs.rmSync(root, { recursive: true }); fs.rmSync(elsewhere, { recursive: true }); }
});

test('credentials are written owner-only, even over an existing world-readable file', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-cred-'));
  const f = path.join(dir, 'credentials.json');
  try {
    fs.writeFileSync(f + '.tmp', '{}', { mode: 0o644 });
    writeJson(f, { apiSecret: 's' }, 0o600);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

// A scripted server: each handler gets (method, path, body) and returns or throws.
function fakeServer(routes) {
  const calls = [];
  const call = async (m, p, b) => {
    calls.push(`${m} ${p}`);
    for (const [k, fn] of Object.entries(routes)) if (`${m} ${p}`.startsWith(k)) return fn(b);
    throw Object.assign(new Error('no route'), { status: 404 });
  };
  return { call, calls };
}
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
const MATCH = { id: 'm_1', state: 'live', role: 'guest', lobbyCode: 'ROOM' };

test('bridge keeps result.json and lobby.json until the server accepts them', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    let reportStatus = 503;
    const srv = fakeServer({
      'POST /api/matches/m_1/report': () => {
        if (reportStatus) throw httpError(reportStatus, reportStatus === 409 ? 'report already submitted' : undefined);
        return { state: 'verified' };
      },
      'POST /api/matches/m_1/lobby': () => { throw httpError(409, 'match already started'); },
    });
    const bridge = createBridge({ game, call: srv.call });
    const f = (n) => path.join(bridge.dir, n);
    writeJson(f('result.json'), { matchId: 'm_1', durationSec: 1 });
    await assert.rejects(bridge.tick(), /503/);
    assert.ok(fs.existsSync(f('result.json')), 'kept after a 5xx');
    assert.ok(fs.existsSync(path.join(bridge.dir, 'archive', 'm_1.json')), 'archived before sending');
    reportStatus = 0;
    await bridge.tick();
    assert.ok(!fs.existsSync(f('result.json')));
    assert.equal(bridge.current().state, 'reported');

    reportStatus = 400; // the server will never take this log
    writeJson(f('result.json'), { matchId: 'm_1' });
    await bridge.tick().catch(() => {});
    assert.ok(!fs.existsSync(f('result.json')));
    assert.ok(fs.existsSync(f('result.json.failed')), 'a 4xx is a permanent rejection, kept for inspection');

    reportStatus = 409; // sent before, but the response was lost
    writeJson(f('result.json'), { matchId: 'm_1' });
    await bridge.tick();
    assert.ok(!fs.existsSync(f('result.json')));
    assert.match(JSON.parse(fs.readFileSync(f('state.json'), 'utf8')).message, /already submitted/);

    writeJson(f('lobby.json'), { matchId: 'm_1', lobbyCode: 'ROOM' });
    await bridge.tick();
    assert.ok(!fs.existsSync(f('lobby.json')), 'a 409 on the lobby means it was already posted');
  } finally { fs.rmSync(game, { recursive: true }); }
});

test('bridge resyncs with the server: cancel after a match was found, and a refused join', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    const srv = fakeServer({
      'POST /api/queue/leave': () => ({ state: 'matched', match: MATCH }),
      'GET /api/queue/status': () => ({ state: 'matched', match: MATCH }),
      'POST /api/integrity/report': () => ({ verdict: 'clean', integrityToken: 'it_x', findings: [] }),
      'POST /api/queue/join': () => { throw httpError(409, 'you already have an open match'); },
    });
    const bridge = createBridge({ game, call: srv.call });
    const state = () => JSON.parse(fs.readFileSync(path.join(bridge.dir, 'state.json'), 'utf8'));
    writeJson(path.join(bridge.dir, 'request.json'), { action: 'cancel' });
    await bridge.tick();
    assert.equal(state().state, 'matched');
    assert.equal(state().match.id, 'm_1');

    writeJson(path.join(bridge.dir, 'request.json'), { action: 'queue' });
    await bridge.tick();
    assert.equal(state().state, 'matched');
    assert.ok(srv.calls.includes('GET /api/queue/status'));
  } finally { fs.rmSync(game, { recursive: true }); }
});
