'use strict';
// Regression tests for the security audit: integrity evaluation (pure functions).
const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../src/integrity');
const { BASE_FILES, MOD_FILE, AIRCRAFT, H } = require('./helpers');

const baseline = { manifest: { files: BASE_FILES }, aircraft: AIRCRAFT };
const approved = [{ name: 'Project RVNG', ...MOD_FILE, category: 'required' }];
const rt = { aircraft: AIRCRAFT };
const PAK = BASE_FILES[1];
const codes = (r) => r.findings.map((f) => f.code);
const run = (extra, over = {}) => evaluate({ files: [...BASE_FILES, MOD_FILE, ...extra], runtime: rt, ...over }, baseline, approved);

test('a clean twin of a modified pak cannot hide it (case twin and Kelvin-sign twin)', () => {
  const modified = { ...PAK, size: 6000, sha256: H('e') };
  for (const twinPath of ['ACE8/Content/paks/pakchunk0-Windows.pak', 'ACE8/Content/PaKs/pakchunk0-Windows.pak']) {
    const files = [BASE_FILES[0], modified, { ...PAK, path: twinPath }, MOD_FILE];
    const r = evaluate({ files, runtime: rt }, baseline, approved);
    assert.equal(r.verdict, 'rejected', twinPath);
  }
  const dup = evaluate({ files: [BASE_FILES[0], PAK, { ...PAK, path: 'ACE8\\Content\\Paks\\pakchunk0-Windows.pak' }, MOD_FILE], runtime: rt }, baseline, approved);
  assert.ok(codes(dup).includes('duplicate_path'));
});

test('links (junctioned ~mods, LogicMods, UE4SS mod folders) are rejected', () => {
  for (const path of ['ACE8/Content/Paks/~mods', 'ACE8/Content/Paks/LogicMods', 'ACE8/Binaries/Win64/ue4ss/Mods/GodMode', 'ACE8/Content/Movies']) {
    const r = run([{ path, size: -1, sha256: 'symlink' }]);
    assert.equal(r.verdict, 'rejected', path);
    assert.ok(codes(r).includes('link_in_install'), path);
  }
});

test('scripts outside ue4ss/mods and unpinned loader config are critical', () => {
  const moved = run([
    { path: 'ACE8/Binaries/Win64/ue4ss/UE4SS-settings.ini', size: 10, sha256: H('1') },
    { path: 'ACE8/Binaries/Win64/Plugins/GodMode/Scripts/main.lua', size: 10, sha256: H('2') },
    { path: 'ACE8/Binaries/Win64/Plugins/GodMode/enabled.txt', size: 0, sha256: H('3') },
  ]);
  assert.equal(moved.verdict, 'rejected');
  assert.deepEqual(codes(moved).sort(), ['unapproved_loader_file', 'unapproved_loader_file', 'unapproved_script_mod']);
  const ini = run([{ path: 'ACE8/Config/DefaultEngine.ini', size: 10, sha256: H('4') }]);
  assert.equal(ini.verdict, 'rejected');
  // Harmless extras stay low.
  assert.equal(run([{ path: 'ACE8/Manuals/readme.pdf', size: 10, sha256: H('5') }]).verdict, 'clean');
});

test('aircraft stats: empty, list-shaped or null maps never pass, and prototype keys do not crash', () => {
  for (const aircraft of [{}, [], null]) {
    const r = run([], { runtime: { aircraft } });
    assert.equal(r.verdict, 'rejected');
    assert.ok(codes(r).includes('runtime_stats_missing'));
  }
  const nulls = run([], { runtime: { aircraft: { f22a: null } } });
  assert.ok(codes(nulls).includes('aircraft_stat_missing'));
  // As parsed from a JSON request body, where both keys are own properties.
  const proto = run([], { runtime: { aircraft: JSON.parse('{"constructor":{"maxSpeed":1},"__proto__":{"x":1}}') } });
  assert.equal(proto.verdict, 'rejected');
  assert.ok(codes(proto).includes('unknown_aircraft'));
});

test('an older approved build of a required mod does not satisfy the required version', () => {
  const v1 = { ...MOD_FILE, size: 40, sha256: H('7') };
  const both = [{ name: 'Project RVNG v1', ...v1, category: 'cosmetic' }, ...approved];
  const r = evaluate({ files: [...BASE_FILES, v1], runtime: rt }, baseline, both);
  assert.equal(r.verdict, 'rejected');
  assert.ok(codes(r).includes('missing_required_mod'));
});
