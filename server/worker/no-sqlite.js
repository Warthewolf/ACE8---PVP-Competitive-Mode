'use strict';
// node:sqlite on Cloudflare (wrangler.toml's alias): never used there, the database is the Durable Object's
// (worker/sqlstore.js). src/db.js's openDb is only for the Node server.
module.exports = { DatabaseSync: function DatabaseSync() { throw new Error('node:sqlite is not available on Cloudflare'); } };
