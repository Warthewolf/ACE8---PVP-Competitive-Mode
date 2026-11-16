'use strict';
/**
 * Integrity evaluation.
 *
 * The client scanner (client/scan.js) and the in-game mod produce a report:
 * {
 *   gameVersion: "1.0.2",
 *   scannerVersion: "0.1.0",
 *   files:   [{ path: "ACE8/Content/Paks/pakchunk0-Windows.pak", size: 123, sha256: "..." }, ...],
 *   runtime: {
 *     loadedModules: ["d3d11.dll", ...],            // optional: DLLs loaded in the game process
 *     aircraft: { "<aircraftId>": { maxSpeed: 2400, ... } }  // stats read live from the game
 *   }
 * }
 *
 * The server compares it with the clean baseline for that game version and the approved-mod list.
 * Paths are normalised to forward slashes, relative to the game install root.
 */
const crypto = require('node:crypto');

const SEVERITY = { info: 0, low: 1, high: 2, critical: 3 };

// Unknown files in these locations are treated as mods.
const PAK_EXT = /\.(pak|ucas|utoc|sig)$/i;
const CODE_EXT = /\.(dll|asi|exe)$/i;
const SCRIPT_EXT = /\.(lua|py|js)$/i;
// Mod folders: matched as the folder itself (a link/junction entry) or anything below it.
const MOD_DIR = /(^|\/)(~mods|logicmods)(\/|$)/;
// The script loader's own tree, and its config files wherever they are (they can relocate the mods folder).
// override.txt next to the proxy DLL points UE4SS at a whole loader (settings and Mods) outside the install.
const LOADER_DIR = /(^|\/)(ue4ss|ue5ss)(\/|$)/;
const LOADER_CONFIG = /(^|\/)(ue4ss-settings\.ini|mods\.txt|mods\.json|enabled\.txt|override\.txt)$/;
const CONFIG_EXT = /\.ini$/i;
// DLL names commonly used as proxy loaders for injection.
const PROXY_DLLS = new Set([
  'dxgi.dll', 'd3d9.dll', 'd3d11.dll', 'd3d12.dll', 'dinput8.dll', 'version.dll', 'winmm.dll', 'dwmapi.dll',
  'xinput1_3.dll', 'xinput1_4.dll', 'xinput9_1_0.dll', 'dsound.dll', 'winhttp.dll', 'opengl32.dll',
]);
// System modules that are always legitimately loaded; anything else outside the baseline is reported.
const SYSTEM_MODULE_ALLOW = /^(ntdll|kernel32|kernelbase|user32|gdi32|advapi32|ws2_32|d3d1[12]|dxgi|xinput1_4|steam_api64|steamclient64|gameoverlayrenderer64|nvwgf2umx|amdxx64|amdxc64|vulkan-1)\.dll$/i;

// Relative tolerance before a runtime aircraft stat counts as modified.
const STAT_TOLERANCE = 0.005;

// Forward slashes, no leading "./", ASCII-only lowercase. Full Unicode lowercasing would fold look-alikes
// such as the Kelvin sign (U+212A) into "k", letting a second, unloaded copy of a file share its key.
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/[A-Z]/g, (c) => c.toLowerCase());

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFileRecord = (f) => Number.isSafeInteger(f.size) && f.size >= 0 && /^[0-9a-f]{64}$/.test(f.sha256);

function classifyUnknown(path) {
  const base = path.split('/').pop();
  if (PAK_EXT.test(path) || MOD_DIR.test(path)) {
    return { code: 'unapproved_pak_mod', severity: 'critical' };
  }
  if (CODE_EXT.test(path)) {
    if (PROXY_DLLS.has(base)) return { code: 'proxy_dll_injection', severity: 'critical' };
    return { code: 'unapproved_binary', severity: 'critical' };
  }
  // A script is a mod wherever it sits: the loader's mods folder can be moved with one config line.
  if (SCRIPT_EXT.test(path)) return { code: 'unapproved_script_mod', severity: 'critical' };
  if (LOADER_DIR.test(path) || LOADER_CONFIG.test(path)) return { code: 'unapproved_loader_file', severity: 'critical' };
  if (CONFIG_EXT.test(path)) return { code: 'unapproved_config', severity: 'high' };
  return { code: 'unknown_file', severity: 'low' };
}

function compareAircraft(reported, baseline) {
  const findings = [];
  for (const [id, stats] of Object.entries(reported || {})) {
    const ref = Object.hasOwn(baseline, id) ? baseline[id] : null;
    if (!isPlainObject(ref)) {
      findings.push({ code: 'unknown_aircraft', severity: 'high', aircraft: id });
      continue;
    }
    if (!isPlainObject(stats)) {
      findings.push({ code: 'aircraft_stat_missing', severity: 'high', aircraft: id });
      continue;
    }
    for (const [stat, refVal] of Object.entries(ref)) {
      if (typeof refVal !== 'number') continue;
      const got = stats[stat];
      if (typeof got !== 'number' || !Number.isFinite(got)) {
        findings.push({ code: 'aircraft_stat_missing', severity: 'high', aircraft: id, stat });
        continue;
      }
      const diff = refVal === 0 ? Math.abs(got) : Math.abs(got - refVal) / Math.abs(refVal);
      if (diff > STAT_TOLERANCE) {
        findings.push({
          code: 'aircraft_stat_modified', severity: 'critical', aircraft: id, stat,
          expected: refVal, actual: got,
        });
      }
    }
  }
  return findings;
}

/**
 * @param report    client report (see top of file)
 * @param baseline  { manifest: {files:[...]}, aircraft: {...} } or null
 * @param approved  rows from approved_mods
 * @returns { verdict, findings, mods, manifestHash }
 */
function evaluate(report, baseline, approved) {
  const findings = [];
  const mods = [];

  if (!report || !Array.isArray(report.files)) {
    return { verdict: 'rejected', findings: [{ code: 'malformed_report', severity: 'critical' }], mods, manifestHash: '' };
  }
  if (!baseline) {
    const gameVersion = typeof report.gameVersion === 'string' ? report.gameVersion.slice(0, 32) : null;
    return { verdict: 'rejected', findings: [{ code: 'unsupported_game_version', severity: 'critical', gameVersion }], mods, manifestHash: '' };
  }

  // Values come from the player: only real numbers and strings are used (an object with a bogus toString
  // must not throw). Anything else fails isFileRecord or the hash comparison below.
  const reported = new Map();
  for (const f of report.files) {
    if (!isPlainObject(f) || typeof f.path !== 'string') continue;
    const k = norm(f.path);
    // Two entries for one path: a clean twin could otherwise overwrite the file the game really loads.
    if (reported.has(k)) { findings.push({ code: 'duplicate_path', severity: 'critical', path: k }); continue; }
    reported.set(k, { size: typeof f.size === 'number' ? f.size : NaN, sha256: typeof f.sha256 === 'string' ? f.sha256.toLowerCase() : '' });
  }

  // 1. Every baseline file must exist with identical size and hash.
  const baseFiles = new Map(baseline.manifest.files.map((f) => [norm(f.path), f]));
  for (const [path, ref] of baseFiles) {
    const got = reported.get(path);
    if (!got) {
      findings.push({ code: 'missing_file', severity: 'high', path });
    } else if (got.size !== Number(ref.size)) {
      findings.push({ code: 'size_mismatch', severity: 'critical', path, expected: Number(ref.size), actual: got.size });
    } else if (got.sha256 !== String(ref.sha256).toLowerCase()) {
      findings.push({ code: 'hash_mismatch', severity: 'critical', path });
    }
  }

  // 2. Every extra file must be an approved mod, otherwise it is classified.
  const approvedByPath = new Map();
  for (const m of approved) {
    const k = norm(m.path);
    if (!approvedByPath.has(k)) approvedByPath.set(k, []);
    approvedByPath.get(k).push(m);
  }
  for (const [path, got] of reported) {
    if (baseFiles.has(path)) continue;
    // Symlinks/junctions (size -1) and other malformed records can point a mod folder anywhere.
    if (!isFileRecord(got)) {
      findings.push({ code: 'link_in_install', severity: 'critical', path, size: got.size });
      mods.push({ name: path.split('/').pop(), path, size: got.size, approved: false });
      continue;
    }
    const candidates = approvedByPath.get(path) || [];
    const match = candidates.find((m) => m.sha256.toLowerCase() === got.sha256 && Number(m.size) === got.size);
    if (match && match.category === 'retired') {
      // A build that used to be approved: out of date, not tampered, so it never flags the account.
      findings.push({ code: 'outdated_mod', severity: 'high', name: match.name, version: match.version || '', path });
      mods.push({ name: match.name, path, size: got.size, approved: false, outdated: true });
      continue;
    }
    if (match) {
      mods.push({ name: match.name, path, size: got.size, approved: true, category: match.category });
      continue;
    }
    const cls = classifyUnknown(path);
    if (candidates.length) {
      // Known mod path but the file differs from the approved build -> tampered mod.
      findings.push({ code: 'approved_mod_tampered', severity: 'critical', path, size: got.size });
      mods.push({ name: candidates[0].name, path, size: got.size, approved: false });
    } else {
      findings.push({ ...cls, path, size: got.size });
      if (cls.code !== 'unknown_file') mods.push({ name: path.split('/').pop(), path, size: got.size, approved: false });
    }
  }

  // 3. Required mods (the competitive mod, the loader and its settings): one complete required build of each
  //    must be installed exactly. Several builds of a mod (same name, different version) can be required at
  //    once while players update; cosmetic or retired copies at the same paths never count.
  const builds = new Map(); // name -> version -> rows
  for (const m of approved) {
    if (m.category !== 'required') continue;
    if (!builds.has(m.name)) builds.set(m.name, new Map());
    const byVersion = builds.get(m.name);
    const v = m.version || '';
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(m);
  }
  const installed = (m) => {
    const got = reported.get(norm(m.path));
    return !!got && got.sha256 === String(m.sha256).toLowerCase() && got.size === Number(m.size);
  };
  for (const [name, byVersion] of builds) {
    let closest = null; // report against the build nearest to what is installed
    for (const [version, rows] of byVersion) {
      const missing = rows.filter((m) => !installed(m));
      if (!closest || missing.length < closest.missing.length) closest = { version, missing };
    }
    for (const m of closest.missing) {
      findings.push({ code: 'missing_required_mod', severity: 'critical', name, version: closest.version, path: norm(m.path) });
    }
  }

  // 4. Runtime checks from inside the game process.
  const rt = isPlainObject(report.runtime) ? report.runtime : {};
  if (Array.isArray(rt.loadedModules)) {
    const allowedBinaries = new Set(
      [...baseFiles.keys(), ...mods.filter((m) => m.approved).map((m) => m.path)]
        .filter((p) => CODE_EXT.test(p)).map((p) => p.split('/').pop()),
    );
    if (rt.loadedModules.some((x) => typeof x !== 'string')) findings.push({ code: 'malformed_report', severity: 'critical', field: 'runtime.loadedModules' });
    for (const mod of new Set(rt.loadedModules.filter((x) => typeof x === 'string').map(norm))) {
      const name = mod.split('/').pop();
      if (allowedBinaries.has(name) || SYSTEM_MODULE_ALLOW.test(name)) continue;
      findings.push({ code: 'unexpected_loaded_module', severity: 'high', module: name });
    }
  }
  if (isPlainObject(rt.aircraft) && Object.keys(rt.aircraft).length) {
    findings.push(...compareAircraft(rt.aircraft, baseline.aircraft || {}));
  } else findings.push({ code: 'runtime_stats_missing', severity: 'high' });

  const worst = findings.reduce((m, f) => Math.max(m, SEVERITY[f.severity] ?? 0), 0);
  const verdict = worst >= SEVERITY.high ? 'rejected' : 'clean';

  const manifestHash = crypto.createHash('sha256')
    .update([...reported.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, f]) => `${p}:${f.size}:${f.sha256}`).join('\n'))
    .digest('hex');

  return { verdict, findings, mods, manifestHash };
}

module.exports = { evaluate, compareAircraft, classifyUnknown, norm, isPlainObject, STAT_TOLERANCE, SEVERITY };
