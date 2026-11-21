'use strict';
// Runs the in-game mod's Lua logic (mod/test/harness.lua) when a Lua 5.4 interpreter is installed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lua = ['lua5.4', 'lua'].find((bin) => spawnSync(bin, ['-v']).status === 0);

test('mod: per-match join/retry, kill attribution, stat sampling, JSON arrays', { skip: !lua && 'no Lua 5.4 interpreter' }, () => {
  const bridge = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-mod-'));
  try {
    const r = spawnSync(lua, [path.join(__dirname, '../../mod/test/harness.lua'), bridge], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /all mod checks passed/);
  } finally { fs.rmSync(bridge, { recursive: true }); }
});

test('mod: the native test logger\'s Lua side (rvng_probe.lua)', { skip: !lua && 'no Lua 5.4 interpreter' }, () => {
  const r = spawnSync(lua, [path.join(__dirname, '../../mod/test/probe_test.lua')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all probe checks passed/);
});

test('mod: the autotest self-test suites against a fake game (rvng_selftest.lua)', { skip: !lua && 'no Lua 5.4 interpreter' }, () => {
  const r = spawnSync(lua, [path.join(__dirname, '../../mod/test/selftest_test.lua')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all self-test checks passed/);
});

test('mod: the main menu rows RVNG takes off (rvng_menu.lua)', { skip: !lua && 'no Lua 5.4 interpreter' }, () => {
  const r = spawnSync(lua, [path.join(__dirname, '../../mod/test/menu_test.lua')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all menu checks passed/);
});

test('mod: the native runtime’s always-on tick (rvng_native.lua)', { skip: !lua && 'no Lua 5.4 interpreter' }, () => {
  const r = spawnSync(lua, [path.join(__dirname, '../../mod/test/native_test.lua')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all native tick checks passed/);
});

test('mod: the ready-up screen (rvng_ready.lua)', { skip: !lua && 'no Lua 5.4 interpreter' }, () => {
  const r = spawnSync(lua, [path.join(__dirname, '../../mod/test/ready_test.lua')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all ready-up checks passed/);
});

test("mod: RVNG's menu pages (rvng_pages.lua)", { skip: !lua && 'no Lua 5.4 interpreter' }, () => {
  const r = spawnSync(lua, [path.join(__dirname, '../../mod/test/pages_test.lua')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all page checks passed/);
});

test('mod: the stats check\'s reader (rvng_stats.lua)', { skip: !lua && 'no Lua 5.4 interpreter' }, () => {
  const r = spawnSync(lua, [path.join(__dirname, '../../mod/test/stats_test.lua')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all stats checks passed/);
});
