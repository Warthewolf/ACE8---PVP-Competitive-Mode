'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { evaluate } = require('../src/integrity');
const { BASE_FILES, MOD_FILE, AIRCRAFT, H } = require('./helpers');

const baseline = { manifest: { files: BASE_FILES }, aircraft: AIRCRAFT };
const approved = [{ name: 'ACE8 Competitive', ...MOD_FILE, category: 'required' },
  { name: 'HUD colors', path: 'ACE8/Content/Paks/~mods/hud_P.pak', size: 77, sha256: H('d'), category: 'cosmetic' }];
const rt = { aircraft: AIRCRAFT };
const codes = (r) => r.findings.map((f) => f.code);

test('clean install with required mod passes', () => {
  const r = evaluate({ gameVersion: '1.0.0', files: [...BASE_FILES, MOD_FILE], runtime: rt }, baseline, approved);
  assert.equal(r.verdict, 'clean');
  assert.deepEqual(r.mods.map((m) => m.name), ['ACE8 Competitive']);
});

test('approved cosmetic mod is listed and allowed', () => {
  const r = evaluate({ files: [...BASE_FILES, MOD_FILE, { path: 'ACE8\\Content\\Paks\\~mods\\hud_P.pak', size: 77, sha256: H('d') }], runtime: rt }, baseline, approved);
  assert.equal(r.verdict, 'clean');
  assert.equal(r.mods.length, 2);
});

test('modified pak detected by size and by hash', () => {
  const bigger = evaluate({ files: [BASE_FILES[0], { ...BASE_FILES[1], size: 5001 }, MOD_FILE], runtime: rt }, baseline, approved);
  assert.equal(bigger.verdict, 'rejected');
  assert.ok(codes(bigger).includes('size_mismatch'));
  const sameSize = evaluate({ files: [BASE_FILES[0], { ...BASE_FILES[1], sha256: H('e') }, MOD_FILE], runtime: rt }, baseline, approved);
  assert.ok(codes(sameSize).includes('hash_mismatch'));
});

test('unapproved pak mod, proxy dll and script mods are flagged with names and sizes', () => {
  const r = evaluate({ files: [...BASE_FILES, MOD_FILE,
    { path: 'ACE8/Content/Paks/~mods/fastjets_P.pak', size: 9000, sha256: H('f') },
    { path: 'ACE8/Binaries/Win64/dxgi.dll', size: 300, sha256: H('1') },
    { path: 'ACE8/Binaries/Win64/ue4ss/Mods/GodMode/Scripts/main.lua', size: 10, sha256: H('2') }], runtime: rt }, baseline, approved);
  assert.equal(r.verdict, 'rejected');
  assert.deepEqual(codes(r).sort(), ['proxy_dll_injection', 'unapproved_pak_mod', 'unapproved_script_mod']);
  assert.ok(r.mods.some((m) => m.name === 'fastjets_p.pak' && m.size === 9000 && !m.approved));
});

test('tampered approved mod and missing required mod are rejected', () => {
  const r = evaluate({ files: [...BASE_FILES, { ...MOD_FILE, sha256: H('9') }], runtime: rt }, baseline, approved);
  assert.ok(codes(r).includes('approved_mod_tampered'));
  assert.ok(codes(r).includes('missing_required_mod'));
});

test('altered live aircraft stats are detected', () => {
  const r = evaluate({ files: [...BASE_FILES, MOD_FILE], runtime: { aircraft: { ...AIRCRAFT, f22a: { ...AIRCRAFT.f22a, maxSpeed: 2600 } } } }, baseline, approved);
  assert.equal(r.verdict, 'rejected');
  const f = r.findings.find((x) => x.code === 'aircraft_stat_modified');
  assert.deepEqual([f.aircraft, f.stat, f.expected, f.actual], ['f22a', 'maxSpeed', 2400, 2600]);
});

test('unknown game version and missing runtime stats are rejected', () => {
  assert.equal(evaluate({ files: [] }, null, approved).verdict, 'rejected');
  assert.ok(codes(evaluate({ files: [...BASE_FILES, MOD_FILE] }, baseline, approved)).includes('runtime_stats_missing'));
});
