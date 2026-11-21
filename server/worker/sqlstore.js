'use strict';
// The server's database calls (node:sqlite's DatabaseSync: prepare().get/all/run, exec) on a Cloudflare Durable
// Object's own SQLite (ctx.storage.sql). It's synchronous like node:sqlite, so src/ runs unchanged on Cloudflare: one
// Durable Object holds the whole database and handles one request at a time, as the Node server did.
// The Durable Object's SQLite refuses BEGIN/COMMIT and some PRAGMAs: transactions go through
// storage.transactionSync (db.runInTransaction, used by src/db.js tx), and the schema's journal/foreign-key PRAGMAs
// are left out (the store keeps its own journal; foreign keys are always on there).

const SKIPPED_PRAGMAS = /PRAGMA\s+(journal_mode|foreign_keys)\s*=\s*\w+\s*;/gi;

// storage: { sql: { exec(query, ...bindings) -> cursor with toArray() }, transactionSync(fn) }
function makeDb(storage) {
  const sql = storage.sql;
  const rows = (query, args) => sql.exec(query, ...args.map(bindable)).toArray();
  const one = (query) => sql.exec(query).toArray()[0];
  const db = {
    prepare(query) {
      return {
        get: (...args) => rows(query, args)[0],
        all: (...args) => rows(query, args),
        run: (...args) => {
          rows(query, args);
          const r = one('SELECT changes() AS changes, last_insert_rowid() AS id');
          return { changes: r.changes, lastInsertRowid: r.id };
        },
      };
    },
    exec(text) {
      const q = String(text).replace(SKIPPED_PRAGMAS, '');
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(q)) throw new Error('use db.runInTransaction, not ' + q.trim());
      if (q.trim()) sql.exec(q).toArray();
    },
    runInTransaction: (fn) => storage.transactionSync(fn),
  };
  return db;
}

// node:sqlite refuses undefined and booleans; so does this (a value the Node server would have refused must not be
// stored here instead).
function bindable(v) {
  if (v === undefined) throw new TypeError('cannot bind undefined');
  if (typeof v === 'boolean') throw new TypeError('cannot bind a boolean');
  return v;
}

module.exports = { makeDb };
