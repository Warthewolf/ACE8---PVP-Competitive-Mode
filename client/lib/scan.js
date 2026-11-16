'use strict';
/**
 * Walks the game install and records path, size and sha256 for every tracked file.
 * Hashes are cached by (size, mtime) so re-scans of a 100 GB install take seconds.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Never part of the integrity manifest: user data, logs, caches, and our own bridge folder.
const DEFAULT_EXCLUDES = [
  /(^|\/)saved\//i, /\.log$/i, /(^|\/)crashes?\//i, /\.dmp$/i, /(^|\/)shadercache\//i,
  /(^|\/)ace8competitive\/bridge\//i, /(^|\/)\.ace8pvp-cache\.json$/i,
];

function walk(root, rel = '', out = []) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isSymbolicLink()) { out.push({ rel: r, symlink: true }); continue; }
    if (ent.isDirectory()) walk(root, r, out);
    else if (ent.isFile()) out.push({ rel: r });
  }
  return out;
}

function hashFile(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function scan(root, { excludes = DEFAULT_EXCLUDES, cacheFile, onProgress } = {}) {
  const cachePath = cacheFile || path.join(root, '.ace8pvp-cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
  const next = {};
  const files = [];
  const entries = walk(root).filter((e) => !excludes.some((rx) => rx.test(e.rel)));
  entries.forEach((e, i) => {
    if (e.symlink) { files.push({ path: e.rel, size: -1, sha256: 'symlink' }); return; }
    const full = path.join(root, e.rel);
    const st = fs.statSync(full);
    const key = `${st.size}:${st.mtimeMs}`;
    const sha = cache[e.rel]?.key === key ? cache[e.rel].sha256 : hashFile(full);
    next[e.rel] = { key, sha256: sha };
    files.push({ path: e.rel, size: st.size, sha256: sha });
    if (onProgress) onProgress(i + 1, entries.length, e.rel);
  });
  try { fs.writeFileSync(cachePath, JSON.stringify(next)); } catch { /* read-only install */ }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

module.exports = { scan, hashFile, DEFAULT_EXCLUDES };
