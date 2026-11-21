'use strict';
// npm run test:worker: the server tests through the Cloudflare build (RVNG_TEST_WORKER=1, test/worker-env.js)
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).map((f) => path.join(__dirname, f));
const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', ...files],
  { stdio: 'inherit', env: { ...process.env, RVNG_TEST_WORKER: '1' } });
process.exit(r.status ?? 1);
