'use strict';
const config = require('./config');
const { createApp } = require('./app');
const svc = require('./service');

const app = createApp();
const db = app.get('db');

// Background jobs: matchmaking tick and stale-match sweep.
setInterval(() => { try { svc.runMatchmaker(db); svc.sweepStaleMatches(db); } catch (e) { console.error(e); } }, 3000).unref();

app.listen(config.port, () => {
  console.log(`ACE8 PvP server listening on :${config.port}`);
  if (!config.adminToken) console.warn('ADMIN_TOKEN is not set: admin endpoints are disabled.');
});
