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
