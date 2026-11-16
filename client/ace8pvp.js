#!/usr/bin/env node
'use strict';
/**
 * ACE8 PvP companion.
 *
 *   ace8pvp register --server URL --name NAME            create an account, writes credentials.json
 *   ace8pvp scan     --game DIR [--no-cache]             integrity scan, prints the server verdict
 *   ace8pvp baseline --game DIR --version V [--aircraft stats.json]   (admins) build a clean-install baseline
 *   ace8pvp run      --game DIR [--region eu]            bridge daemon used by the in-game mod
 *
 * The in-game mod (UE4SS Lua) cannot speak signed HTTPS, so it exchanges small JSON files with this
 * daemon in <game>/ACE8Competitive/bridge/ :
 *   mod -> daemon : request.json  { action: "queue" | "cancel", region? }
 *                   runtime.json  { gameVersion, aircraft: {...}, loadedModules: [...] }
 *                   lobby.json    { matchId, lobbyCode }        (host only, after creating the room)
 *                   result.json   match log (see server/src/matchlog.js)
 *   daemon -> mod : state.json    { state, message, match }
 */
const fs = require('node:fs');
const path = require('node:path');
const { api } = require('./lib/sign');
const { scan, DEFAULT_EXCLUDES } = require('./lib/scan');

const VERSION = '0.1.0';

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

const credPath = (a) => a.credentials || path.join(process.cwd(), 'credentials.json');
const loadCreds = (a) => JSON.parse(fs.readFileSync(credPath(a), 'utf8'));
const bridgeDir = (game) => path.join(game, 'ACE8Competitive', 'bridge');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(f + '.tmp', f);
}
const take = (f) => { const d = readJson(f); if (d) fs.rmSync(f, { force: true }); return d; };

async function buildReport(game, opts = {}) {
  const files = scan(game, { cacheFile: opts.noCache ? path.join(require('node:os').tmpdir(), `ace8pvp-${process.pid}.json`) : undefined });
  const runtime = readJson(path.join(bridgeDir(game), 'runtime.json')) || {};
  return {
    scannerVersion: VERSION,
    gameVersion: opts.gameVersion || runtime.gameVersion,
    files,
    runtime: { aircraft: runtime.aircraft, loadedModules: runtime.loadedModules },
  };
}

async function cmdRegister(a) {
  const res = await api(a.server, null, 'POST', '/api/players/register', { name: a.name, platformId: a.platform });
  writeJson(credPath(a), { server: a.server, apiKey: res.apiKey, apiSecret: res.apiSecret, playerId: res.id, name: res.name });
  console.log(`Registered ${res.name} (#${res.id}). Credentials saved to ${credPath(a)} - keep this file private.`);
}

async function cmdScan(a) {
  const creds = loadCreds(a);
  const report = await buildReport(a.game, { noCache: a['no-cache'], gameVersion: a.version });
  const res = await api(creds.server, creds, 'POST', '/api/integrity/report', report);
  console.log(`Verdict: ${res.verdict.toUpperCase()}  (${report.files.length} files scanned)`);
  for (const m of res.mods) console.log(`  mod ${m.approved ? 'APPROVED  ' : 'UNAPPROVED'} ${m.path} (${m.size} bytes)`);
  for (const f of res.findings) console.log(`  [${f.severity}] ${f.code} ${f.path || f.aircraft || f.module || ''}${f.stat ? '.' + f.stat : ''}`);
  return res;
}

function cmdBaseline(a) {
  if (!a.version) throw new Error('--version required');
  const files = scan(a.game, { cacheFile: path.join(require('node:os').tmpdir(), 'ace8pvp-baseline.json') })
    // Mods are registered separately as approved mods, never baked into the baseline.
    .filter((f) => !/(^|\/)(~mods|logicmods|ue4ss|ace8competitive)\//i.test(f.path));
  const aircraft = a.aircraft ? JSON.parse(fs.readFileSync(a.aircraft, 'utf8')) : {};
  const out = a.out || `baseline-${a.version}.json`;
  writeJson(out, { gameVersion: a.version, manifest: { files }, aircraft });
  console.log(`Wrote ${out}: ${files.length} files, ${Object.keys(aircraft).length} aircraft. Upload with PUT /api/admin/baselines.`);
}

async function cmdRun(a) {
  const creds = loadCreds(a);
  const dir = bridgeDir(a.game);
  fs.mkdirSync(dir, { recursive: true });
  const setState = (state, extra = {}) => writeJson(path.join(dir, 'state.json'), { state, at: Date.now(), ...extra });
  let current = { state: 'idle' };
  setState('idle', { message: 'Companion connected' });
  console.log(`Bridge running in ${dir}`);

  const tick = async () => {
    const req = take(path.join(dir, 'request.json'));
    if (req && req.action === 'cancel') {
      await api(creds.server, creds, 'POST', '/api/queue/leave').catch(() => {});
      current = { state: 'idle' }; setState('idle', { message: 'Left queue' });
    }
    if (req && req.action === 'queue') {
      setState('scanning', { message: 'Verifying game files...' });
      const report = await buildReport(a.game);
      const scanRes = await api(creds.server, creds, 'POST', '/api/integrity/report', report);
      if (scanRes.verdict !== 'clean') {
        current = { state: 'rejected' };
        setState('rejected', { message: 'Integrity check failed', findings: scanRes.findings.slice(0, 20) });
        return;
      }
      const q = await api(creds.server, creds, 'POST', '/api/queue/join', { integrityToken: scanRes.integrityToken, region: req.region || a.region || 'global' });
      current = q; setState(q.state, { match: q.match, message: q.state === 'queued' ? 'Searching for opponent' : 'Opponent found' });
    }

    if (['queued', 'matched'].includes(current.state)) {
      const q = await api(creds.server, creds, 'GET', '/api/queue/status');
      current = q;
      if (q.state === 'idle') setState('idle', { message: 'Queue timed out' });
      else setState(q.state, { match: q.match, message: q.state === 'matched' ? `Match ${q.match.id} (${q.match.state})` : `Searching... ${q.waitingSec}s` });
    }

    const lobby = take(path.join(dir, 'lobby.json'));
    if (lobby) await api(creds.server, creds, 'POST', `/api/matches/${lobby.matchId}/lobby`, { lobbyCode: lobby.lobbyCode });

    const result = take(path.join(dir, 'result.json'));
    if (result) {
      const m = await api(creds.server, creds, 'POST', `/api/matches/${result.matchId}/report`, result);
      current = { state: 'reported' };
      setState('reported', { match: m, message: `Result submitted (${m.state})` });
      writeJson(path.join(dir, 'archive', `${result.matchId}.json`), result);
    }
  };

  for (;;) {
    try { await tick(); } catch (e) { console.error('bridge:', e.message); setState(current.state || 'idle', { error: e.message }); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const needGame = ['scan', 'baseline', 'run'];
  if (needGame.includes(cmd) && !a.game) throw new Error('--game <install dir> required');
  if (cmd === 'register') return cmdRegister(a);
  if (cmd === 'scan') return cmdScan(a);
  if (cmd === 'baseline') return cmdBaseline(a);
  if (cmd === 'run') return cmdRun(a);
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, ''));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { buildReport, DEFAULT_EXCLUDES };
