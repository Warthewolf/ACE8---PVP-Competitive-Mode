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

// How approved mod paths are stored: like norm(), and also without leading "/" or "./", doubled or trailing
// slashes, so every way an admin can type a path names the same file.
const canonPath = (p) => norm(String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.?\/)+/, '').replace(/\/+$/, ''));

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

// The stats check (rvng_stats_1, mod/ProjectRVNG/Scripts/rvng_stats.lua, docs/re/STATS.md): the game's combat tables
// (planes with their flight model at every level, parts, weapons, damage rates, abilities, level-ups, stealth) as one
// fingerprint per row and per table, compared with the clean install's. Any changed, added or missing row is named.
const STATS_FORMAT = 'rvng_stats_1';
const DIGEST = /^[0-9a-f]{16}$/;
const STATS_LIMITS = { groups: 64, rows: 20000, key: 64 };
const MAX_STAT_FINDINGS = 50;

// Is it a well-formed stats object? (the size bounds keep a hostile report from costing the server much)
function validStats(s) {
  if (!isPlainObject(s) || s.format !== STATS_FORMAT || !isPlainObject(s.groups)) return false;
  const names = Object.keys(s.groups);
  if (names.length > STATS_LIMITS.groups) return false;
  let rows = 0;
  for (const n of names) {
    const g = s.groups[n];
    if (n.length > STATS_LIMITS.key || !isPlainObject(g) || !DIGEST.test(g.digest) || !isPlainObject(g.entries)) return false;
    for (const [k, d] of Object.entries(g.entries)) {
      if (++rows > STATS_LIMITS.rows || k.length > STATS_LIMITS.key || typeof d !== 'string' || !DIGEST.test(d)) return false;
    }
  }
  return true;
}

function compareStats(reported, baseline) {
  if (!validStats(reported)) {
    return [reported === undefined || reported === null
      ? { code: 'runtime_stats_missing', severity: 'high' }
      : { code: 'malformed_report', severity: 'critical', field: 'runtime.stats' }];
  }
  const findings = [];
  const planes = isPlainObject(reported.planes) ? reported.planes : {};
  const refPlanes = isPlainObject(baseline.planes) ? baseline.planes : {};
  const headline = (table, key) => {
    if (table !== 'PlaneDataMap_') return {};
    const a = isPlainObject(planes[key]) ? planes[key] : {}; const e = isPlainObject(refPlanes[key]) ? refPlanes[key] : {};
    const pick = (o) => ({ speedMax: o.speedMax, speedStall: o.speedStall, maxHealth: o.maxHealth });
    return { expected: pick(e), actual: pick(a) };
  };
  for (const [table, ref] of Object.entries(baseline.groups)) {
    if (ref.missing) continue;                               // (the clean install didn't have it: nothing to compare)
    const got = Object.hasOwn(reported.groups, table) ? reported.groups[table] : null;
    if (!got || got.missing) {
      // an optional table (a DataTable some modes load) is compared when both have it; a required one (the information
      // manager's) must be there
      findings.push(ref.optional ? { code: 'stat_table_unchecked', severity: 'info', table }
        : { code: 'stat_table_missing', severity: 'high', table });
      continue;
    }
    if (got.digest === ref.digest) continue;
    let named = 0;
    for (const [key, digest] of Object.entries(ref.entries)) {
      if (!Object.hasOwn(got.entries, key)) {
        findings.push({ code: 'stat_row_missing', severity: 'high', table, row: key }); named++;
      } else if (got.entries[key] !== digest) {
        findings.push({ code: 'aircraft_stat_modified', severity: 'critical', table, row: key, ...headline(table, key) }); named++;
      }
    }
    for (const key of Object.keys(got.entries)) {
      if (!Object.hasOwn(ref.entries, key)) { findings.push({ code: 'stat_row_added', severity: 'critical', table, row: key }); named++; }
    }
    // (rows all equal but the table's own fingerprint not: the report doesn't add up)
    if (!named) findings.push({ code: 'aircraft_stat_modified', severity: 'critical', table });
  }
  // (a report that changes thousands of rows is named by its first rows and a count: findings are stored)
  if (findings.length > MAX_STAT_FINDINGS) {
    const more = findings.length - MAX_STAT_FINDINGS;
    findings.length = MAX_STAT_FINDINGS;
    findings.push({ code: 'aircraft_stat_modified', severity: 'critical', more });
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
  const buildRows = new Map(); // rows per (name, version): a "<version>#<id>" pseudo-build is a single row
  for (const m of approved) {
    const b = JSON.stringify([m.name, String(m.version ?? '')]);
    buildRows.set(b, (buildRows.get(b) || 0) + 1);
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
    // The same file can be listed by several builds (a file two releases share). Any build that is still
    // approved makes it approved; it is out of date only when every build that lists it is retired.
    const matching = candidates.filter((m) => String(m.sha256).toLowerCase() === got.sha256 && Number(m.size) === got.size);
    const current = matching.filter((m) => m.category !== 'retired');
    const match = current.find((m) => m.category === 'required') || current[0];
    if (!match && matching.length) {
      // A build that used to be approved: out of date, not tampered, so it never flags the account. Name the mod
      // that still has a current build at this path, then the build approved most recently ("1.0#12" is a kept
      // earlier file of build 1.0).
      const live = new Set(candidates.filter((m) => m.category !== 'retired').map((m) => m.name));
      const old = [...matching].sort((a, b) => (live.has(b.name) - live.has(a.name)) || ((b.id ?? 0) - (a.id ?? 0)))[0];
      const v = String(old.version || ''); const own = `#${old.id}`;
      const pseudo = old.id != null && v.endsWith(own) && buildRows.get(JSON.stringify([old.name, String(old.version ?? '')])) === 1;
      findings.push({ code: 'outdated_mod', severity: 'high', name: old.name, version: pseudo ? v.slice(0, -own.length) : v, path });
      mods.push({ name: old.name, path, size: got.size, approved: false, outdated: true });
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
  const ref = isPlainObject(baseline.aircraft) ? baseline.aircraft : {};
  if (ref.format === STATS_FORMAT) {
    findings.push(...compareStats(rt.stats, ref));
  } else if (rt.stats !== undefined && !Object.keys(ref).length) {
    // (a mod that sends the stats, a baseline uploaded without them: nothing to check against, so nobody passes)
    findings.push({ code: 'no_reference_stats', severity: 'high' });
  } else if (isPlainObject(rt.aircraft) && Object.keys(rt.aircraft).length) {
    findings.push(...compareAircraft(rt.aircraft, ref));
  } else findings.push({ code: 'runtime_stats_missing', severity: 'high' });

  const worst = findings.reduce((m, f) => Math.max(m, SEVERITY[f.severity] ?? 0), 0);
  const verdict = worst >= SEVERITY.high ? 'rejected' : 'clean';

  const manifestHash = crypto.createHash('sha256')
    .update([...reported.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, f]) => `${p}:${f.size}:${f.sha256}`).join('\n'))
    .digest('hex');

  return { verdict, findings, mods, manifestHash };
}

module.exports = { evaluate, compareAircraft, compareStats, validStats, STATS_FORMAT, classifyUnknown, norm, canonPath, isPlainObject, STAT_TOLERANCE, SEVERITY };
