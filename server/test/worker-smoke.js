'use strict';
// The Cloudflare build in Cloudflare's own runtime (workerd, through `wrangler dev`; no Cloudflare account needed):
//   npx wrangler dev --port 8787      (with .dev.vars holding ADMIN_TOKEN=local-admin-token)
//   node test/worker-smoke.js [http://127.0.0.1:8787]
// The whole native deathmatch path, signed as the companion signs: sign-ups, the admin's build and mod list, two clean
// scans, the queue (paired on join), the link, two result.json logs -> verified, the rating and the leaderboard; then
// the website's headers and bad requests. Run it on a fresh local
// state (delete .wrangler/state) or it still passes with the pilots it made before.
const assert = require('node:assert');
const { api } = require('../../client/lib/sign');

const URL0 = process.argv[2] || 'http://127.0.0.1:8787';
const ADMIN = process.env.ADMIN_TOKEN || 'local-admin-token';
const H = (n) => n.repeat(64).slice(0, 64);
const FILES = [
  { path: 'ACE8/Binaries/Win64/ACE8-Win64-Shipping.exe', size: 1000, sha256: H('a') },
  { path: 'ACE8/Content/Paks/pakchunk0-Windows.pak', size: 5000, sha256: H('b') },
];
const MOD = { path: 'ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG/Scripts/main.lua', size: 42, sha256: H('c') };
const AIRCRAFT = { f22a: { maxSpeed: 2400, turnRate: 30, hp: 100 } };
let passed = 0;
const ok = (cond, what) => { assert.ok(cond, what); passed++; console.log('PASS ' + what); };

async function admin(method, path, body) {
  const r = await fetch(URL0 + path, { method, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${d.error}`);
  return d;
}
function nativeLog(me, opp, k, d, s, os) {
  const events = [];
  for (let i = 0; i < k; i++) events.push({ t: 30 + i, type: 'kill', actor: 'self' }, { t: 30 + i, type: 'death', actor: 'opponent' });
  for (let i = 0; i < d; i++) events.push({ t: 90 + i, type: 'kill', actor: 'opponent' }, { t: 90 + i, type: 'death', actor: 'self' });
  return { format: 'native_dm', gameVersion: '1.0.0', runtimeVersion: '0.4.4', durationSec: 214, endReason: 'time_limit',
    self: { aircraftId: me, kills: k, deaths: d, score: s }, opponent: { aircraftId: opp, kills: d, deaths: k, score: os }, events };
}

(async () => {
  ok((await (await fetch(URL0 + '/api/health')).json()).ok === true, 'health answers from the Durable Object');
  await admin('PUT', '/api/admin/baselines', { gameVersion: '1.0.0', manifest: { files: FILES }, aircraft: AIRCRAFT });
  await admin('POST', '/api/admin/mods', { name: 'Project RVNG', ...MOD, category: 'required' });
  ok(true, 'admin: the build and the mod list uploaded (bearer token from the secret)');

  const tag = Date.now().toString(36).slice(-5);
  const reg = async (name) => { const r = await api(URL0, null, 'POST', '/api/players/register', { name }); return { ...r, call: (m, p, b) => api(URL0, r, m, p, b) }; };
  const a = await reg('Smoke' + tag + 'a'); const b = await reg('Smoke' + tag + 'b');
  ok(a.apiKey && b.apiSecret, 'two sign-ups with credentials');

  for (const p of [a, b]) {
    const s = await p.call('POST', '/api/integrity/report', { gameVersion: '1.0.0', files: [...FILES, MOD], runtime: { aircraft: AIRCRAFT, loadedModules: ['ntdll.dll'] } });
    assert.equal(s.verdict, 'clean');
    await p.call('POST', '/api/queue/join', { integrityToken: s.integrityToken, region: 'eu', mode: 'ranked' });
  }
  ok(true, 'two clean scans (signed requests, HMAC and nonces in the Durable Object) and two queue joins');
  let st = await a.call('GET', '/api/queue/status');
  for (let i = 0; i < 10 && st.state !== 'matched'; i++) { await new Promise((r) => setTimeout(r, 1000)); st = await a.call('GET', '/api/queue/status'); }
  ok(st.state === 'matched', 'paired (on join, or by the alarm)');
  const id = st.match.id;
  const host = st.match.role === 'host' ? a : b; const guest = host === a ? b : a;
  await host.call('POST', `/api/matches/${id}/link`, { steamId: '76561190000000011' });
  const g = await guest.call('POST', `/api/matches/${id}/link`, { steamId: '76561190000000022' });
  ok(g.state === 'live', 'the link posted by both: the match is live');
  const r1 = await host.call('POST', `/api/matches/${id}/report`, nativeLog('21010', '10034010', 2, 1, 3702.0, 2650.5));
  ok(r1.state === 'awaiting_reports', "the host's result.json in");
  const r2 = await guest.call('POST', `/api/matches/${id}/report`, nativeLog('10034010', '21010', 1, 2, 2650.5, 3702.0));
  ok(r2.state === 'verified' && r2.score.host === 3702 && r2.ratingDelta.host > 0, "the guest's in: verified, decided by score, ratings moved");
  const lb = await (await fetch(URL0 + '/api/leaderboard')).json();
  const me = lb.find((p) => p.id === host.id);
  ok(me && me.wins === 1 && me.kills === 2, 'on the leaderboard: the win and the kills');

  const page = await fetch(URL0 + '/');
  ok(page.status === 200 && (await page.text()).includes('<html'), 'the website from the static assets');
  ok(String(page.headers.get('content-security-policy')).includes("frame-ancestors 'none'"), "the website's security headers (public/_headers)");
  const bad = await fetch(URL0 + '/api/players/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  ok(bad.status === 400 && (await bad.json()).error === 'invalid JSON', 'bad JSON is a 400');
  ok((await fetch(URL0 + '/api/nothing')).status === 404, 'an unknown API path is a 404');
  ok((await fetch(URL0 + '/api/admin/players')).status === 403, 'admin routes refuse without the token');
  console.log(`RESULT ${passed}/${passed}`);
})().catch((e) => { console.error('FAIL', e.message); console.log(`RESULT ${passed}/${passed + 1}`); process.exit(1); });
