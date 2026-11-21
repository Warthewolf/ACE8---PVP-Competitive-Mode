#!/usr/bin/env node
'use strict';
/**
 * Builds the friend install package: a zip a pilot unpacks anywhere and runs "Install RVNG.cmd" from.
 *
 *   node tools/friend_package/make.js --game "<ACE COMBAT 8 folder>" [--site https://playrvngpvp.org] [--out DIR]
 *                                     [--baseline DIR]   (default build/baseline)
 *
 * The mod files come from the admin's own install, and every one must match the approved builds in build/baseline
 * (mods-*.json) byte for byte: what friends install is exactly what the server lets through. The clean game's file
 * list (baseline-*.json, paths only) goes in too, so the installer can name files the scan would flag before the
 * first scan. The companion app is copied from client/. Output: build/friend/RVNG-<mod version>-<game version>.zip
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(__dirname, 'template');

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  }
  return a;
}
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// "mods-Project_RVNG-0.4.4.json" -> { name: "Project_RVNG", version: "0.4.4" }
const nameOf = (f) => { const m = /^mods-(.+)-([^-]+)\.json$/.exec(path.basename(f)); return m ? { name: m[1], version: m[2] } : null; };

// A path from an approval file, checked before it is joined to anything: relative, forward slashes, no "..".
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '' || s === '.')) {
    throw new Error(`unsafe path in an approval file: ${JSON.stringify(p)}`);
  }
  return p;
}

function copyDir(src, dst, filter = () => true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name); const d = path.join(dst, e.name);
    if (!filter(e.name)) continue;
    if (e.isDirectory()) copyDir(s, d, filter); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function make(a) {
  if (!a.game || a.game === true) throw new Error('--game <ACE COMBAT 8 folder> required');
  const game = path.resolve(a.game);
  const site = (a.site && a.site !== true ? a.site : 'https://playrvngpvp.org').replace(/\/$/, '');
  const baseDir = path.resolve(a.baseline && a.baseline !== true ? a.baseline : path.join(ROOT, 'build', 'baseline'));
  const baselines = fs.readdirSync(baseDir).filter((f) => /^baseline-.+\.json$/.test(f));
  if (baselines.length !== 1) throw new Error(`expected one baseline-*.json in ${baseDir}, found ${baselines.length}`);
  const baseline = readJson(path.join(baseDir, baselines[0]));
  const modFiles = fs.readdirSync(baseDir).filter((f) => nameOf(f));
  if (!modFiles.length) throw new Error(`no mods-*.json in ${baseDir}`);

  // Every required file of every approved build, checked against the admin's install.
  const install = []; const builds = [];
  for (const f of modFiles) {
    const { name, version } = nameOf(f);
    const j = readJson(path.join(baseDir, f));
    const files = (j.mods || []).filter((m) => m.category === 'required');
    if (!files.length) continue;
    builds.push({ name, version, files: files.length });
    for (const m of files) {
      const rel = safeRel(m.path);
      const src = path.join(game, ...rel.split('/'));
      if (!fs.existsSync(src)) throw new Error(`${rel} (${name} ${version}) is not in ${game}`);
      const size = fs.statSync(src).size; const sha = sha256(src);
      if (size !== m.size || sha !== m.sha256) throw new Error(`${rel} in your install is not the approved ${name} ${version} file: approve and upload again, or put the approved one back`);
      install.push({ path: rel, size, sha256: sha, src, mod: `${name} ${version}` });
    }
  }
  const rvng = builds.find((b) => /rvng/i.test(b.name));
  if (!rvng) throw new Error('no approved Project RVNG build in build/baseline');

  const steamBuild = /^steam-(\d+)$/.exec(baseline.gameVersion);
  const appId = fs.readFileSync(path.join(game, 'Game', 'Binaries', 'Win64', 'steam_appid.txt'), 'utf8').trim();
  if (!/^\d+$/.test(appId)) throw new Error('steam_appid.txt does not hold an app id');

  const outDir = path.resolve(a.out && a.out !== true ? a.out : path.join(ROOT, 'build', 'friend'));
  const label = `RVNG-${rvng.version}-${baseline.gameVersion}`;
  const stage = path.join(outDir, label);
  // A copy someone installed from holds their backup, game path and account: never wiped by a rebuild.
  const used = ['RVNG/backup', 'RVNG/game-path.txt', 'RVNG/companion/credentials.json'].filter((f) => fs.existsSync(path.join(stage, ...f.split('/'))));
  if (used.length) {
    throw new Error(`${stage} has been installed from (${used.join(', ')}): move that folder somewhere else first, or pass --out <another folder>`);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  const top = path.join(stage, 'RVNG');

  copyDir(TEMPLATE, top);
  for (const f of install) {
    const d = path.join(top, 'files', ...f.path.split('/'));
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(f.src, d);
  }
  // The companion: rvng.js, lib/ and package.json; never a credentials.json or a scan cache from this PC.
  const comp = path.join(top, 'companion');
  fs.mkdirSync(path.join(comp, 'lib'), { recursive: true });
  for (const f of ['rvng.js', 'package.json']) fs.copyFileSync(path.join(ROOT, 'client', f), path.join(comp, f));
  for (const f of fs.readdirSync(path.join(ROOT, 'client', 'lib')).filter((x) => x.endsWith('.js'))) {
    fs.copyFileSync(path.join(ROOT, 'client', 'lib', f), path.join(comp, 'lib', f));
  }

  const info = {
    format: 'rvng_friend_package_1',
    rvngVersion: rvng.version,
    gameVersion: baseline.gameVersion,
    steamBuild: steamBuild ? steamBuild[1] : null,
    appId,
    site,
    builds,
    install: install.map(({ path: p, size, sha256: s, mod }) => ({ path: p, size, sha256: s, mod })),
    clean: baseline.manifest.files.map((f) => f.path).sort(),
  };
  fs.writeFileSync(path.join(top, 'scripts', 'package.json'), JSON.stringify(info, null, 2) + '\n');
  const readme = path.join(top, 'READ ME FIRST.txt');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8')
    .replaceAll('{{SITE}}', site).replaceAll('{{RVNG}}', rvng.version).replaceAll('{{GAME}}', baseline.gameVersion).replace(/\r?\n/g, '\r\n'));

  // Windows' own tar writes the zip (git's GNU tar can't).
  const zip = path.join(outDir, `${label}.zip`);
  fs.rmSync(zip, { force: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', stage, 'RVNG'], { stdio: 'inherit' });
  return { zip, stage, info };
}

if (require.main === module) {
  try {
    const { zip, info } = make(args(process.argv.slice(2)));
    console.log(`${zip}\n  RVNG ${info.rvngVersion} for game ${info.gameVersion}: ${info.install.length} files (${info.builds.map((b) => `${b.name} ${b.version}`).join(', ')}), site ${info.site}`);
  } catch (e) { console.error(`make: ${e.message}`); process.exit(1); }
}
module.exports = { make, safeRel };
