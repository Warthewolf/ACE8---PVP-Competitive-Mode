'use strict';
// RVNG_TEST_WORKER=1 runs the server tests through the Cloudflare build on Node:
// - require('express') gives worker/express.js (as the Worker bundle's alias does), so every route goes through the
//   Fetch API stand-in for Express;
// - the database is worker/sqlstore.js on a stand-in for the Durable Object's SQLite (node:sqlite underneath, with
//   the Durable Object's refusals: no BEGIN/COMMIT, no journal or foreign-key PRAGMAs, only transactionSync);
// - a Node HTTP server hands each request to worker/express.js's handle() as a Fetch Request, and serves public/
//   for what it doesn't answer (the Worker's static assets).
// The real runtime (workerd) is checked by test/worker-smoke.js.
const Module = require('node:module');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SHIM = path.join(__dirname, '..', 'worker', 'express.js');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'express') return SHIM;
  return resolve.call(this, request, ...rest);
};
const { handle } = require(SHIM);
const { makeDb } = require('../worker/sqlstore');
const { initDb } = require('../src/db');

// A stand-in for ctx.storage: sql.exec(query, ...bindings).toArray(), transactionSync(fn)
function fakeStorage() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  let inTx = false;
  const sql = {
    exec(query, ...bindings) {
      const q = String(query);
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(q)) throw new Error('not allowed on a Durable Object: ' + q.trim().slice(0, 20));
      if (/PRAGMA\s+journal_mode\s*=/i.test(q)) throw new Error('not allowed on a Durable Object: ' + q.trim().slice(0, 30));
      for (const v of bindings) {
        if (v !== null && !['string', 'number'].includes(typeof v) && !(v instanceof ArrayBuffer)) throw new TypeError('unsupported binding ' + typeof v);
      }
      const noComments = q.replace(/--[^\n]*/g, '');
      if (!bindings.length && /;\s*\S/.test(noComments)) { raw.exec(q); return { toArray: () => [] }; }
      const out = raw.prepare(q).all(...bindings).map((r) => ({ ...r }));
      return { toArray: () => out };
    },
  };
  return {
    sql,
    transactionSync(fn) {
      if (inTx) throw new Error('nested transactionSync');
      inTx = true;
      raw.exec('BEGIN');
      try { const out = fn(); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; } finally { inTx = false; }
    },
  };
}

function workerDb() { return initDb(makeDb(fakeStorage())); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const PUBLIC = path.join(__dirname, '..', 'public');
// public/_headers: the headers Cloudflare adds to every static asset ("/*" block)
function assetHeaders() {
  const out = {};
  for (const line of fs.readFileSync(path.join(PUBLIC, '_headers'), 'utf8').split(/\r?\n/)) {
    const m = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}
function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || rel.startsWith('_')) file = null;
  if (file && !fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', ...assetHeaders() });
  res.end(fs.readFileSync(file));
}

function listen(app) {
  const server = http.createServer(async (nreq, nres) => {
    try {
      const chunks = [];
      for await (const c of nreq) chunks.push(c);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(nreq.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const request = new Request('http://127.0.0.1' + nreq.url, {
        method: nreq.method, headers, body: ['GET', 'HEAD'].includes(nreq.method) ? undefined : body,
      });
      // Cloudflare gives the client's address in CF-Connecting-IP. The tests that set config.trustProxy send theirs
      // as X-Forwarded-For (the Node server's proxy setting): its last entry stands in for it here.
      const config = require('../src/config');
      const xff = String(nreq.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
      const ip = config.trustProxy && xff.length ? xff[xff.length - 1] : nreq.socket.remoteAddress;
      const response = await handle(app, request, { ip, remoteAddress: nreq.socket.remoteAddress });
      if (!response) return serveStatic(new URL(request.url).pathname, nres);
      nres.writeHead(response.status, Object.fromEntries(response.headers));
      nres.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      nres.writeHead(500); nres.end();
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

module.exports = { workerDb, listen, fakeStorage, assetHeaders };
