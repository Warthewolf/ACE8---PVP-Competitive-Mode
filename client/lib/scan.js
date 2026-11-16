'use strict';
/**
 * Walks the game install and records path, size and sha256 for every tracked file.
 * Hashes can be cached by (size, mtime, ctime, inode) so re-scans of a 100 GB install take seconds.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Never part of the integrity manifest: user data, logs, crash dumps, and our own bridge folder.
// Every pattern is anchored to where that folder really is under the game root, so a folder that merely
// shares the name (for example Content/Paks/~mods/Saved/) is still scanned.
const DEFAULT_EXCLUDES = [
  /^([^/]+\/)?saved(\/|$)/i, // <root>/Saved or <root>/<Project>/Saved (logs, crashes, config, shader cache)
  /^projectrvng\/bridge(\/|$)/i, // the bridge folder at <root>/ProjectRVNG/bridge/
  /^\.rvng-cache\.json$/i, // the scan cache
  /\.(log|dmp)$/i,
];
// File types the game or a loader can load are always reported, whatever folder they are in.
const NEVER_EXCLUDE = /\.(pak|ucas|utoc|sig|dll|asi|exe|lua|py|js)$/i;

function walk(root, rel = '', out = []) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    // Symlinks and junctions are reported as such (the server rejects them): following them could pull in
    // a mods folder that lives anywhere on the disk.
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

// Whether the scanner leaves a regular file out of the report (see DEFAULT_EXCLUDES).
const excluded = (rel, excludes = DEFAULT_EXCLUDES) => !NEVER_EXCLUDE.test(rel) && excludes.some((rx) => rx.test(rel));

/**
 * @param root  game install root
 * @param opts.useCache  false = hash every file (no cache read or write)
 * @param opts.stats     object that receives { hashed, cached } counts
 */
function scan(root, { excludes = DEFAULT_EXCLUDES, cacheFile, useCache = true, onProgress, stats = {} } = {}) {
  const cachePath = cacheFile || path.join(root, '.rvng-cache.json');
  let cache = {};
  if (useCache) {
    try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
  }
  const next = {};
  const files = [];
  stats.hashed = 0; stats.cached = 0;
  // Links are always reported, whatever their name or place: a link is never a log or user data, and the
  // excludes match names only (a junction called "x.log", or Saved itself as a link, must not hide a mods folder).
  const entries = walk(root).filter((e) => e.symlink || !excluded(e.rel, excludes));
  entries.forEach((e, i) => {
    if (e.symlink) { files.push({ path: e.rel, size: -1, sha256: 'symlink' }); return; }
    const full = path.join(root, e.rel);
    const st = fs.statSync(full);
    // ctime and inode are part of the key: restoring a patched file's mtime is not enough to reuse a hash.
    const key = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    let sha;
    if (useCache && cache[e.rel]?.key === key) { sha = cache[e.rel].sha256; stats.cached++; } else { sha = hashFile(full); stats.hashed++; }
    next[e.rel] = { key, sha256: sha };
    files.push({ path: e.rel, size: st.size, sha256: sha });
    if (onProgress) onProgress(i + 1, entries.length, e.rel);
  });
  if (useCache) {
    try { fs.writeFileSync(cachePath, JSON.stringify(next)); } catch { /* read-only install */ }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

module.exports = { scan, hashFile, excluded, DEFAULT_EXCLUDES, NEVER_EXCLUDE };
