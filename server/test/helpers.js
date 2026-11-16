'use strict';
process.env.ADMIN_TOKEN = 'test-admin';
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { api } = require('../../client/lib/sign');

const H = (n) => n.repeat(64).slice(0, 64);
const BASE_FILES = [
  { path: 'ACE8/Binaries/Win64/ACE8-Win64-Shipping.exe', size: 1000, sha256: H('a') },
  { path: 'ACE8/Content/Paks/pakchunk0-Windows.pak', size: 5000, sha256: H('b') },
];
const MOD_FILE = { path: 'ACE8/Binaries/Win64/ue4ss/Mods/ProjectRVNG/Scripts/main.lua', size: 42, sha256: H('c') };
const AIRCRAFT = { f22a: { maxSpeed: 2400, turnRate: 30, hp: 100 }, su57: { maxSpeed: 2450, turnRate: 32, hp: 100 } };

async function setup() {
  const db = openDb(':memory:');
  const app = createApp({ db });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const admin = async (method, path, body) => {
    const res = await fetch(url + path, { method, headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const d = await res.json(); if (!res.ok) throw Object.assign(new Error(d.error), { status: res.status }); return d;
  };
  await admin('PUT', '/api/admin/baselines', { gameVersion: '1.0.0', manifest: { files: BASE_FILES }, aircraft: AIRCRAFT });
  await admin('POST', '/api/admin/mods', { name: 'Project RVNG', ...MOD_FILE, category: 'required' });

  const register = async (name) => {
    const r = await api(url, null, 'POST', '/api/players/register', { name });
    return { ...r, call: (m, p, b) => api(url, r, m, p, b) };
  };
  const cleanReport = (over = {}) => ({
    gameVersion: '1.0.0', files: [...BASE_FILES, MOD_FILE], runtime: { aircraft: AIRCRAFT, loadedModules: ['ntdll.dll'] }, ...over,
  });
  const close = () => new Promise((r) => server.close(r));
  return { db, url, admin, register, cleanReport, close };
}

function log({ selfAc = 'f22a', oppAc = 'su57', k = 5, d = 2, dur = 300, oppSpeed = 2300, end = 'kill_target' } = {}) {
  const events = [];
  for (let i = 0; i < k; i++) events.push({ t: i * 10, type: 'kill', actor: 'self' });
  for (let i = 0; i < d; i++) events.push({ t: i * 10 + 5, type: 'kill', actor: 'opponent' });
  return { gameVersion: '1.0.0', durationSec: dur, endReason: end, self: { aircraftId: selfAc, kills: k, deaths: d },
    opponent: { aircraftId: oppAc, kills: d, deaths: k }, events, telemetry: { opponentMaxSpeed: oppSpeed } };
}

// Mirror of `log` from the other pilot's point of view.
const mirror = (o = {}) => log({ selfAc: o.oppAc || 'su57', oppAc: o.selfAc || 'f22a', k: o.d ?? 2, d: o.k ?? 5, dur: o.dur ?? 300, oppSpeed: o.mirrorOppSpeed ?? 2300 });

module.exports = { setup, log, mirror, BASE_FILES, MOD_FILE, AIRCRAFT, H };
