'use strict';
// The companion's side of casual mode, player reports and the hidden-rating setting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createBridge, writeJson, cmdReport, cmdSettings } = require('../rvng');

const CLI = path.join(__dirname, '..', 'rvng.js');
function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-community-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
function fakeServer(reply = (body) => ({ state: 'queued', mode: body.mode || 'ranked', waitingSec: 0 })) {
  const joins = [];
  const call = async (m, p, b) => {
    if (p === '/api/integrity/report') return { verdict: 'clean', integrityToken: 'it_x', findings: [] };
    if (p === '/api/queue/join') { joins.push(b); return reply(b); }
    if (p === '/api/queue/status') return { state: 'queued', mode: joins.at(-1)?.mode || 'ranked', waitingSec: 1 };
    return {};
  };
  return { call, joins };
}

test('bridge: the mode in request.json reaches the queue join; without one the request is as before', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    const srv = fakeServer();
    const bridge = createBridge({ game, call: srv.call });
    const state = () => JSON.parse(fs.readFileSync(path.join(bridge.dir, 'state.json'), 'utf8'));
    writeJson(path.join(bridge.dir, 'request.json'), { action: 'queue', region: 'eu' });
    await bridge.tick();
    assert.deepEqual(Object.keys(srv.joins[0]).sort(), ['integrityToken', 'region'], 'an older mod\'s request is sent unchanged');
    writeJson(path.join(bridge.dir, 'request.json'), { action: 'queue', region: 'eu', mode: 'Casual' });
    await bridge.tick();
    assert.equal(srv.joins[1].mode, 'casual', 'sent in lower case');
    assert.deepEqual([state().state, state().mode], ['queued', 'casual'], 'the mod can show which queue it is in');

    // --mode is the default for requests that name none; the mod's own choice wins.
    const srv2 = fakeServer();
    const b2 = createBridge({ game, call: srv2.call, mode: 'casual' });
    writeJson(path.join(b2.dir, 'request.json'), { action: 'queue' });
    await b2.tick();
    writeJson(path.join(b2.dir, 'request.json'), { action: 'queue', mode: 'ranked' });
    await b2.tick();
    assert.deepEqual(srv2.joins.map((j) => j.mode), ['casual', 'ranked']);
  } finally { fs.rmSync(game, { recursive: true }); }
});

test('bridge: a refused ranked join (ranked off, lapse cooldown) shows the server\'s reason and leaves the pilot where they were', async () => {
  const game = tree({ 'ACE8/Content/Paks/a.pak': 'x' });
  try {
    const refused = Object.assign(new Error('the ranked queue is turned off on this server: queue casual instead (mode "casual")'), { status: 403 });
    const call = async (m, p) => {
      if (p === '/api/integrity/report') return { verdict: 'clean', integrityToken: 'it_x' };
      if (p === '/api/queue/join') throw refused;
      return { state: 'idle' };
    };
    const bridge = createBridge({ game, call });
    writeJson(path.join(bridge.dir, 'request.json'), { action: 'queue', mode: 'ranked' });
    await assert.rejects(bridge.tick(), /ranked queue is turned off/);
    const st = JSON.parse(fs.readFileSync(path.join(bridge.dir, 'state.json'), 'utf8'));
    assert.deepEqual([st.state, st.message], ['idle', 'Could not join the queue']);
    assert.match(st.error, /queue casual instead/);
  } finally { fs.rmSync(game, { recursive: true }); }
});

test('rvng report and rvng settings send the signed requests the server expects, and check their options first', async () => {
  const sent = [];
  const call = async (m, p, b) => { sent.push({ route: `${m} ${p}`, body: b }); return p === '/api/reports' ? { id: 7, reason: b.reason } : { tier: 'Pilot', rating: 1500 }; };
  const r = await quiet(() => cmdReport({ player: '12', reason: 'Cheating', match: 'm_abc', details: 'boosted past 3000 km/h' }, call));
  assert.equal(r.id, 7);
  assert.deepEqual(sent[0], { route: 'POST /api/reports', body: { playerId: 12, reason: 'cheating', matchId: 'm_abc', details: 'boosted past 3000 km/h' } });
  await quiet(() => cmdReport({ player: '3', reason: 'abuse' }, call));
  assert.deepEqual(sent[1].body, { playerId: 3, reason: 'abuse' }, 'no match, no details');
  for (const [a, re] of [[{ reason: 'abuse' }, /--player/], [{ player: 'x', reason: 'abuse' }, /--player/], [{ player: '0', reason: 'abuse' }, /--player/],
    [{ player: '3' }, /--reason required/], [{ player: '3', reason: 'abuse', match: true }, /--match needs a value/]]) {
    await assert.rejects(cmdReport(a, call), re, JSON.stringify(a));
  }
  await quiet(() => cmdSettings({ 'hide-rating': 'on' }, call));
  await quiet(() => cmdSettings({ 'hide-rating': 'OFF' }, call));
  assert.deepEqual(sent.slice(2).map((s) => [s.route, s.body]), [['POST /api/me/settings', { hideRating: true }], ['POST /api/me/settings', { hideRating: false }]]);
  for (const a of [{}, { 'hide-rating': true }, { 'hide-rating': 'maybe' }]) await assert.rejects(cmdSettings(a, call), /--hide-rating on\|off required/);
  assert.equal(sent.length, 4, 'nothing is sent for refused options');
});

test('rvng report is a command of the CLI: options are checked before the credentials are looked for', () => {
  const dir = tree({});
  try {
    const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--credentials', path.join(dir, 'missing.json')], { cwd: dir, encoding: 'utf8' });
    const noPlayer = run('report', '--reason', 'cheating');
    assert.notEqual(noPlayer.status, 0);
    assert.match(noPlayer.stderr, /--player <player id> required/);
    const noCreds = run('report', '--player', '2', '--reason', 'cheating');
    assert.notEqual(noCreds.status, 0);
    assert.match(noCreds.stderr, /ENOENT|missing\.json/);
    assert.match(run('settings').stderr, /--hide-rating on\|off required/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
