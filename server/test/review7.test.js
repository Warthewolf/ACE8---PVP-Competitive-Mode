'use strict';
// Regression tests for the final review: a real "#" build one of whose rows has the id its version ends in, and
// a build swept into another mod's build file by file, resolved with one refusal and one retire call.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup, BASE_FILES, AIRCRAFT, H } = require('./helpers');
const { openDb } = require('../src/db');
const integrity = require('../src/integrity');
const svc = require('../src/service');

const scan = (p, env, over) => p.call('POST', '/api/integrity/report', env.cleanReport(over));
const rejectsWith = (code, re) => (e) => e.status === code && (!re || re.test(e.message));
const RVNG = 'ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG';
const UE = 'ACE8/Binaries/Win64/ue4ss';
const f = (p, size, h) => ({ path: p, size, sha256: H(h) });
const baseline = { manifest: { files: BASE_FILES }, aircraft: AIRCRAFT };
const verdict = (approved, files) => integrity.evaluate({ files: [...BASE_FILES, ...files], runtime: { aircraft: AIRCRAFT } }, baseline, approved);

test('a real "#" build keeps every row, also the row whose id its version ends in; a one-row pseudo-build is still retired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvng-r7-'));
  try {
    const file = path.join(dir, 'db.sqlite');
    let db = openDb(file);
    const ins = db.prepare('INSERT INTO approved_mods (id, name, path, size, sha256, category, version) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const files = [f(`${RVNG}/scripts/json.lua`, 41, '2'), f(`${RVNG}/scripts/main.lua`, 42, '4'), f(`${RVNG}/enabled.txt`, 0, '3')]
      .map((x) => ({ ...x, path: x.path.toLowerCase() }));
    files.forEach((x, i) => ins.run(4 + i, 'Project RVNG', x.path, x.size, x.sha256, 'required', '1.0#5')); // main.lua is row 5
    ins.run(9, 'UE4SS', `${UE}/ue4ss.dll`.toLowerCase(), 10, H('1'), 'required', '3.0#9'); // a pseudo-build: one row, its own id
    db.close();
    db = openDb(file);
    const rows = svc.listApprovedMods(db);
    assert.deepEqual(rows.map((r) => [r.id, r.category]).sort((x, y) => x[0] - y[0]), [[4, 'required'], [5, 'required'], [6, 'required'], [9, 'retired']]);
    assert.equal(verdict(rows, files).verdict, 'clean');
    const stripped = verdict(rows, files.filter((x) => !x.path.endsWith('main.lua')));
    assert.ok(stripped.findings.some((x) => x.code === 'missing_required_mod' && x.path.endsWith('main.lua')), 'an install without main.lua is rejected');
    // Retired later, every file is reported under the build's real version.
    const old = rows.map((r) => ({ ...r, category: 'retired' }));
    assert.deepEqual(verdict(old, files).findings.filter((x) => x.code === 'outdated_mod').map((x) => x.version), ['1.0#5', '1.0#5', '1.0#5']);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an upload that hits files another mod pins is refused once, naming every file; one retire call by ids and one upload resolve it', async () => {
  const env = await setup();
  try {
    svc.retireMods(env.db, { name: 'Project RVNG' });
    const loader = f(`${UE}/UE4SS.dll`, 10, '1');
    const mod = [f(`${RVNG}/Scripts/main.lua`, 42, '4'), f(`${RVNG}/Scripts/json.lua`, 41, '2'), f(`${RVNG}/enabled.txt`, 0, '3')];
    // An older release swept all three files into the version-less loader build and into 3.0.1.
    const ins = env.db.prepare("INSERT INTO approved_mods (name, path, size, sha256, category, version) VALUES ('UE4SS', ?, ?, ?, 'required', ?)");
    for (const v of ['', '3.0.1']) for (const x of [loader, ...mod]) ins.run(integrity.canonPath(x.path), x.size, x.sha256, v);
    const swept = env.db.prepare("SELECT id FROM approved_mods WHERE name = 'UE4SS' AND path LIKE '%/projectrvng/%' ORDER BY id").all().map((r) => r.id);
    assert.equal(swept.length, 6);
    const upload = { roots: [RVNG], mods: mod.map((x) => ({ name: 'Project RVNG', version: '1.0', category: 'required', ...x })) };
    const err = await env.admin('POST', '/api/admin/mods', upload).catch((e) => e);
    assert.equal(err.status, 409);
    assert.match(err.message, /^6 files are already pinned by another mod: /);
    for (const x of mod) assert.ok(err.message.includes(integrity.canonPath(x.path)), x.path);
    assert.ok(err.message.includes(`POST /api/admin/mods/retire {"ids":[${swept.join(',')}]}`), err.message);

    // Retiring by ids is all or none.
    await assert.rejects(env.admin('POST', '/api/admin/mods/retire', { ids: [] }), rejectsWith(400));
    await assert.rejects(env.admin('POST', '/api/admin/mods/retire', { ids: [swept[0], 99999] }), rejectsWith(404, /99999/));
    assert.equal(env.db.prepare('SELECT category FROM approved_mods WHERE id = ?').get(swept[0]).category, 'required');

    await env.admin('POST', '/api/admin/mods/retire', { ids: swept });
    await env.admin('POST', '/api/admin/mods', upload);
    const pilot = await env.register('Swept002');
    assert.equal((await scan(pilot, env, { files: [...BASE_FILES, loader, ...mod] })).verdict, 'clean');
    const noMain = await scan(pilot, env, { files: [...BASE_FILES, loader, ...mod.slice(1)] });
    assert.equal(noMain.verdict, 'rejected', 'the competitive mod is still required in full');
  } finally { await env.close(); }
});
