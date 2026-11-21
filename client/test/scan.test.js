'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scan } = require('../lib/scan');

test('scan reports size and sha256, skips excluded folders, and refreshes cache on change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvngscan-'));
  fs.mkdirSync(path.join(root, 'ACE8/Content/Paks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ACE8/Saved/Logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ProjectRVNG/bridge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ACE8/Content/Paks/a.pak'), 'hello');
  fs.writeFileSync(path.join(root, 'ACE8/Saved/Logs/x.log'), 'ignored');
  fs.writeFileSync(path.join(root, 'ProjectRVNG/bridge/state.json'), '{}');
  const files = scan(root);
  assert.deepEqual(files, [{ path: 'ACE8/Content/Paks/a.pak', size: 5, sha256: crypto.createHash('sha256').update('hello').digest('hex') }]);
  fs.writeFileSync(path.join(root, 'ACE8/Content/Paks/a.pak'), 'hellO!');
  assert.equal(scan(root)[0].size, 6);
  fs.rmSync(root, { recursive: true });
});

test('scan: the anti-cheat folder and the protected launcher are never read, not even listed', () => {
  const { scan: scanDir } = require('../lib/scan');
  const root = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'rvng-eac-'));
  const fsx = require('node:fs'); const px = require('node:path');
  try {
    fsx.mkdirSync(px.join(root, 'EasyAntiCheat', 'Certificates'), { recursive: true });
    fsx.writeFileSync(px.join(root, 'EasyAntiCheat', 'EasyAntiCheat_EOS_Setup.exe'), 'x');
    fsx.writeFileSync(px.join(root, 'EasyAntiCheat', 'Certificates', 'base.bin'), 'x');
    fsx.writeFileSync(px.join(root, 'start_protected_game.exe'), 'x');
    fsx.mkdirSync(px.join(root, 'Game', 'EasyAntiCheat'), { recursive: true });       // (deeper: an ordinary folder)
    fsx.writeFileSync(px.join(root, 'Game', 'EasyAntiCheat', 'mod.dll'), 'x');
    fsx.writeFileSync(px.join(root, 'game.exe'), 'x');
    const opened = [];
    const realOpen = fsx.openSync;
    fsx.openSync = (f, ...r) => { opened.push(String(f)); return realOpen(f, ...r); };
    let files;
    try { files = scanDir(root, { useCache: false }).map((f) => f.path); } finally { fsx.openSync = realOpen; }
    assert.deepEqual(files, ['Game/EasyAntiCheat/mod.dll', 'game.exe']);
    assert.ok(!opened.some((f) => /start_protected_game|[\/]EasyAntiCheat[\/](EasyAntiCheat_EOS|Certificates)/i.test(f)), 'never opened');
  } finally { fsx.rmSync(root, { recursive: true, force: true }); }
});
