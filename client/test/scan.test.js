'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scan } = require('../lib/scan');

test('scan reports size and sha256, skips excluded folders, and refreshes cache on change', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace8scan-'));
  fs.mkdirSync(path.join(root, 'ACE8/Content/Paks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ACE8/Saved/Logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ACE8Competitive/bridge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ACE8/Content/Paks/a.pak'), 'hello');
  fs.writeFileSync(path.join(root, 'ACE8/Saved/Logs/x.log'), 'ignored');
  fs.writeFileSync(path.join(root, 'ACE8Competitive/bridge/state.json'), '{}');
  const files = scan(root);
  assert.deepEqual(files, [{ path: 'ACE8/Content/Paks/a.pak', size: 5, sha256: crypto.createHash('sha256').update('hello').digest('hex') }]);
  fs.writeFileSync(path.join(root, 'ACE8/Content/Paks/a.pak'), 'hellO!');
  assert.equal(scan(root)[0].size, 6);
  fs.rmSync(root, { recursive: true });
});
