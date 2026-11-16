#!/usr/bin/env node
'use strict';
/**
 * Project RVNG companion.
 *
 *   rvng register   --server URL --name NAME              create an account, writes credentials.json (owner-only)
 *   rvng scan       --game DIR [--no-cache]                integrity scan, prints the server verdict
 *   rvng join-event --id N                                 sign up for an open knockout event
 *   rvng run        --game DIR [--region eu] [--no-cache]  bridge daemon used by the in-game mod
 *   rvng baseline   --game DIR --version V [--aircraft stats.json]             (admins) build a clean-install baseline
 *   rvng approve    --game DIR --path REL[,REL...] --name NAME [--version V] [--category required|cosmetic|retired]
 *                   [--exclude SUB[,SUB...]] [--out FILE]  (admins) pin the files and folders of one build of a
 *                                                          mod, leaving out folders that belong to another mod
 *
 * --no-cache hashes every file instead of reusing hashes from .rvng-cache.json. Use it for event matches.
 *
 * The in-game mod (UE4SS Lua) cannot speak signed HTTPS, so it exchanges small JSON files with this
 * daemon in <game>/ProjectRVNG/bridge/ :
 *   mod -> daemon : request.json  { action: "queue" | "cancel", region? }
 *                   runtime.json  { gameVersion, aircraft: {...}, loadedModules: [...] }
 *                   lobby.json    { matchId, lobbyCode }        (host only, after creating the room)
 *                   result.json   match log (see server/src/matchlog.js)
 *   daemon -> mod : state.json    { state, message, match, error? }
 *                   state: idle | scanning | waiting | queued | matched | rejected | reported
 * lobby.json and result.json are deleted only once the server has accepted them; a rejection of the content
 * (400/403/404/409/413) renames them to *.failed, anything else is retried. Every result is copied to
 * bridge/archive/ before it is sent.
 */
const fs = require('node:fs');
const path = require('node:path');
const { api } = require('./lib/sign');
const { scan, hashFile, excluded, DEFAULT_EXCLUDES } = require('./lib/scan');

const VERSION = '0.2.0';

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      // An empty value ("") is a value: `--version ""` is the version-less build, not the flag alone.
      const v = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

// credentials.json: --credentials, else the folder the command runs from, else next to this script (the website
// says to save it in one of those two).
const credPath = (a) => a.credentials || path.join(process.cwd(), 'credentials.json');
function findCreds(a) {
  if (a.credentials) return a.credentials;
  const here = [path.join(process.cwd(), 'credentials.json'), path.join(__dirname, 'credentials.json')];
  const p = here.find((f) => fs.existsSync(f));
  if (!p) throw new Error(`credentials.json not found in ${[...new Set(here.map(path.dirname))].join(' or ')}: sign up on the website `
    + 'or run rvng register, then save it there or pass --credentials <file>');
  return p;
}
function loadCreds(a) {
  const p = findCreds(a);
  if (process.platform !== 'win32') {
    try {
      if ((fs.statSync(p).mode & 0o077) !== 0) console.warn(`warning: ${p} is readable by other users; run: chmod 600 "${p}"`);
    } catch { /* reported by the read below */ }
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const bridgeDir = (game) => path.join(game, 'ProjectRVNG', 'bridge');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, data, mode) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  if (mode) fs.chmodSync(tmp, mode); // the mode option only applies when the file is created
  fs.renameSync(tmp, f);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildReport(game, opts = {}) {
  const stats = {};
  const files = scan(game, { useCache: !opts.noCache, stats });
  const runtime = readJson(path.join(bridgeDir(game), 'runtime.json')) || {};
  return {
    scannerVersion: VERSION,
    gameVersion: opts.gameVersion || runtime.gameVersion,
    files,
    scanStats: stats,
    runtime: { aircraft: runtime.aircraft, loadedModules: runtime.loadedModules },
  };
}

async function cmdRegister(a) {
  if (!a.server || !a.name) throw new Error('--server and --name required');
  const res = await api(a.server, null, 'POST', '/api/players/register', { name: a.name });
  writeJson(credPath(a), { server: a.server, apiKey: res.apiKey, apiSecret: res.apiSecret, playerId: res.id, name: res.name }, 0o600);
  console.log(`Registered ${res.name} (#${res.id}). Credentials saved to ${credPath(a)} - keep this file private.`);
}

async function cmdScan(a) {
  const creds = loadCreds(a);
  const report = buildReport(a.game, { noCache: a['no-cache'], gameVersion: a.version });
  const res = await api(creds.server, creds, 'POST', '/api/integrity/report', report);
  console.log(`Verdict: ${res.verdict.toUpperCase()}  (${report.files.length} files scanned, ${report.scanStats.hashed} hashed)`);
  for (const m of res.mods) console.log(`  mod ${m.approved ? 'APPROVED  ' : 'UNAPPROVED'} ${m.path} (${m.size} bytes)`);
  for (const f of res.findings) console.log(`  [${f.severity}] ${f.code} ${f.path || f.aircraft || f.module || ''}${f.stat ? '.' + f.stat : ''}`);
  return res;
}

async function cmdJoinEvent(a) {
  if (!a.id) throw new Error('--id <event number> required');
  const creds = loadCreds(a);
  const t = await api(creds.server, creds, 'POST', `/api/tournaments/${encodeURIComponent(a.id)}/register`);
  console.log(`Registered for ${t.name} (${t.entrants.length}/${t.size} pilots). The bracket is seeded when the event starts.`);
}

function cmdBaseline(a) {
  if (!a.version) throw new Error('--version required');
  const files = scan(a.game, { useCache: false })
    // Mods are registered separately as approved mods, never baked into the baseline.
    .filter((f) => !/(^|\/)(~mods|logicmods|ue4ss|projectrvng)\//i.test(f.path));
  const links = files.filter((f) => f.size < 0);
  if (links.length) throw new Error(`the install contains links, which cannot be part of a baseline: ${links.map((f) => f.path).join(', ')}`);
  const aircraft = a.aircraft ? JSON.parse(fs.readFileSync(a.aircraft, 'utf8')) : {};
  const out = a.out || `baseline-${a.version}.json`;
  writeJson(out, { gameVersion: a.version, manifest: { files }, aircraft });
  console.log(`Wrote ${out}: ${files.length} files, ${Object.keys(aircraft).length} aircraft. Upload with PUT /api/admin/baselines.`);
  if (!Object.keys(aircraft).length) console.warn('warning: no aircraft stats given (--aircraft); every match on this build will be disputed.');
}

// Admin helper: pins one file, or every file of a folder (a mod, or the UE4SS loader and its settings), as approved.
// Several --path values (comma-separated) make one build: the loader is its folder plus the proxy DLL next to
// the game exe. The upload names those roots, and the server retires files of the build under them that the
// upload no longer lists.
function cmdApprove(a) {
  const rel = a.path || a.dir;
  if (!rel || rel === true || !a.name || a.name === true) throw new Error('--path <file or folder under the game root> and --name required');
  for (const k of ['version', 'category', 'out']) if (a[k] === true) throw new Error(`--${k} needs a value (use --version "" for a version-less build)`);
  // As the server stores it: forward slashes, no leading "./" or "/", no doubled or trailing slashes.
  const canon = (x) => String(x).replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.?\/)+/, '').replace(/\/+$/, '');
  const subs = [...new Set(String(rel).split(',').map((x) => canon(x.trim())).filter(Boolean))];
  if (!subs.length || subs.some((x) => x === '.' || x.split('/').includes('..'))) throw new Error('--path must name files or folders under the game root');
  const category = a.category || 'cosmetic';
  if (!['required', 'cosmetic', 'retired'].includes(category)) throw new Error('--category must be required, cosmetic or retired');
  const version = a.version === undefined ? '' : String(a.version);
  // Folders inside these that belong to another mod (Project RVNG inside the loader's Mods folder), given
  // relative to a --path or to the game root. Each mod's files are approved separately.
  if (a.exclude === true) throw new Error('--exclude needs a folder, for example --exclude Mods/ProjectRVNG');
  const excludes = [].concat(a.exclude ?? []).flatMap((x) => String(x).split(',')).map((x) => canon(x.trim())).filter(Boolean)
    .map((x) => [x, ...subs.map((sub) => `${sub}/${x}`)].map((y) => y.toLowerCase()));
  const listed = [];
  for (const sub of subs) {
    const full = path.join(a.game, sub);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) throw new Error(`links cannot be approved: ${sub}`);
    const all = st.isFile()
      ? [{ path: '', size: st.size, sha256: hashFile(full) }]
      : scan(full, { useCache: false, excludes: [] });
    const links = all.filter((f) => f.size < 0);
    if (links.length) throw new Error(`links cannot be approved: ${links.map((f) => `${sub}/${f.path}`).join(', ')}`);
    listed.push(...all.map((f) => ({ ...f, path: f.path ? `${sub}/${f.path}` : sub })));
  }
  const inside = (f, x) => f.path.toLowerCase() === x || f.path.toLowerCase().startsWith(x + '/');
  const hit = (f, forms) => forms.some((x) => inside(f, x));
  // An exclude that matches nothing is a typo: the other mod's files would be pinned into this one.
  const unused = excludes.filter((forms) => !listed.some((f) => hit(f, forms)));
  if (unused.length) throw new Error(`--exclude matched no files: ${unused.map((forms) => forms[0]).join(', ')}`);
  const files = listed.filter((f) => !excludes.some((forms) => hit(f, forms)));
  // Files the players' scanner never reports (logs, crash dumps) cannot be pinned: a pinned file that is never
  // reported would reject everyone, and UE4SS rewrites its log on every launch anyway.
  const skipped = files.filter((f) => excluded(f.path, DEFAULT_EXCLUDES));
  const mods = files.filter((f) => !excluded(f.path, DEFAULT_EXCLUDES))
    .map((f) => ({ name: a.name, version, path: f.path, size: f.size, sha256: f.sha256, category }));
  if (skipped.length) console.warn(`skipped ${skipped.length} file(s) the scanner never reports: ${skipped.map((f) => f.path).join(', ')}`);
  if (!mods.length) throw new Error(`nothing to approve under ${subs.join(', ')}`);
  const out = a.out || `mods-${String(a.name).replace(/[^A-Za-z0-9_-]/g, '_')}${version ? '-' + version.replace(/[^A-Za-z0-9_.-]/g, '_') : ''}.json`;
  // Two approvals of one build under different paths would write the same default file, and uploading only the
  // last one would leave the first part out. Upload each before the next, or approve all paths at once. A file
  // whose paths all lie under this approval's paths (the same approval again, or one written by an earlier
  // release, which has no roots) is replaced: nothing it held is lost.
  if (!a.out && fs.existsSync(out)) {
    const prev = (() => { try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return null; } })();
    const held = Array.isArray(prev?.roots) ? prev.roots : Array.isArray(prev?.mods) ? prev.mods.map((m) => m?.path) : [prev?.path];
    const outside = held.filter((x) => typeof x !== 'string' || !subs.some((r) => {
      const [h, rr] = [canon(x).toLowerCase(), r.toLowerCase()];
      return h === rr || h.startsWith(rr + '/');
    }));
    if (!held.length || outside.length) {
      const what = Array.isArray(prev?.roots) ? prev.roots.join(', ') : `${outside.length || 'unreadable'} file(s) outside ${subs.join(', ')}`;
      throw new Error(`${out} already holds an approval of ${what}: upload it and delete it first, `
        + 'approve all paths of the build in one --path list, or pass --out');
    }
  }
  writeJson(out, { roots: subs, mods });
  console.log(`Wrote ${out}: ${mods.length} files (${category}${version ? ', version ' + version : ''}). Upload with POST /api/admin/mods.`);
  return { out, mods, roots: subs, skipped: skipped.map((f) => f.path) };
}

/**
 * The bridge between the in-game mod and the server. tick() runs once a second.
 * @param call  (method, path, body) => Promise; defaults to signed requests with `creds`.
 */
function createBridge({ creds, game, region, noCache = false, call = (m, p, b) => api(creds.server, creds, m, p, b) }) {
  const dir = bridgeDir(game);
  fs.mkdirSync(dir, { recursive: true });
  const file = (n) => path.join(dir, n);
  let current = { state: 'idle' }; // where the server says this pilot stands
  let last = { state: 'idle' }; // what state.json shows (can be transient, e.g. 'scanning')
  let retryQueue = null; // a queue request the server asked us to repeat later: { req, at }
  const setState = (state, extra = {}) => { last = { ...extra, state, at: Date.now() }; writeJson(file('state.json'), last); };

  const show = (q, message) => {
    current = q;
    if (q.state === 'matched') setState('matched', { match: q.match, message: message || `Match ${q.match.id} (${q.match.state})` });
    else if (q.state === 'queued') setState('queued', { message: message || `Searching... ${q.waitingSec}s` });
    else setState(q.state, { message: message || 'Ready' });
  };
  // Ask the server where this pilot stands: after a restart, a cancel, or a refused join. If that fails, later
  // ticks ask again until it succeeds, so an open match is never hidden behind a stale 'idle'. The retries back
  // off (2 s, doubling, at most a minute): a long outage, a banned account or stale credentials must not mean a
  // request and an error line every second.
  let unsynced = null; // { at, delay } while the last attempt failed
  const resync = async (message) => {
    try { show(await call('GET', '/api/queue/status'), message); unsynced = null; } catch (e) {
      const delay = unsynced ? Math.min(unsynced.delay * 2, 60_000) : 2000;
      unsynced = { at: Date.now() + delay, delay };
      throw e;
    }
  };
  // After a failed tick: keep what the mod shows, with the error. A transient state ('scanning', or 'waiting'
  // with no repeat still pending) goes back to where the server has this pilot.
  const fail = (e) => {
    const transient = last.state === 'scanning' || (last.state === 'waiting' && !retryQueue);
    if (transient) show(current); // with that state's own message, not the stale "Scanning again in ..."
    setState(last.state, { ...last, error: e.message });
  };

  // Rejections of the content itself. Everything else (network errors, 401 from a skewed clock, 408, 429,
  // 5xx) keeps the file for the next tick.
  const PERMANENT = new Set([400, 403, 404, 409, 410, 413, 422]);
  const permanent = (e) => PERMANENT.has(e.status);
  const finish = (f, ok) => { try { if (ok) fs.rmSync(f, { force: true }); else fs.renameSync(f, f + '.failed'); } catch { /* gone */ } };
  async function submit(name, send, alreadyDone) {
    const f = file(name);
    const data = readJson(f);
    if (!data) return null;
    try {
      const res = await send(data);
      finish(f, true);
      return { data, res };
    } catch (e) {
      if (alreadyDone(e)) { finish(f, true); return { data, res: null }; }
      if (permanent(e)) finish(f, false);
      throw e;
    }
  }

  async function queueUp(req) {
    setState('scanning', { message: 'Verifying game files...' });
    try {
      const scanRes = await call('POST', '/api/integrity/report', buildReport(game, { noCache }));
      if (scanRes.verdict !== 'clean') {
        current = { state: 'rejected' };
        setState('rejected', { message: 'Integrity check failed', findings: scanRes.findings.slice(0, 20) });
        return;
      }
      try {
        const reg = String(req.region || region || 'global').toLowerCase();
        const q = await call('POST', '/api/queue/join', { integrityToken: scanRes.integrityToken, region: reg });
        show(q, q.state === 'queued' ? 'Searching for opponent' : 'Opponent found');
      } catch (e) {
        if (e.status === 409) await resync('You already have an open match');
        else throw e;
      }
    } catch (e) {
      if (e.status === 429) { // scans are spaced out: keep the request and repeat it when the server allows
        const wait = Math.min(Number((/(\d+)s/.exec(e.message) || [])[1]) || 5, 60);
        retryQueue = { req, at: Date.now() + wait * 1000 };
        setState('waiting', { message: `Scanning again in ${wait}s`, error: e.message });
        return;
      }
      // Never leave the transient 'scanning' state behind: back to where the server has this pilot.
      setState(current.state, { ...(current.match ? { match: current.match } : {}), message: 'Could not join the queue', error: e.message });
      throw e;
    }
  }

  async function tick() {
    if (unsynced && Date.now() >= unsynced.at) await resync('Reconnected');
    const reqF = file('request.json');
    let req = readJson(reqF);
    if (req) { fs.rmSync(reqF, { force: true }); retryQueue = null; } // one-shot UI actions; a new one replaces a pending retry
    else if (retryQueue && Date.now() >= retryQueue.at) { req = retryQueue.req; retryQueue = null; }
    if (req && req.action === 'cancel') {
      await call('POST', '/api/queue/leave').catch(() => {});
      await resync('Left queue');
      if (current.state === 'matched') setState('matched', { match: current.match, message: 'An opponent was already found: the match stays open' });
    }
    if (req && req.action === 'queue') await queueUp(req);

    if (['queued', 'matched'].includes(current.state)) {
      const q = await call('GET', '/api/queue/status');
      if (q.state === 'idle') show(q, current.state === 'queued' ? 'Queue timed out' : 'Match closed');
      else show(q);
    }

    // A 409 on the lobby means the room was already posted (the earlier response was lost).
    await submit('lobby.json', (l) => call('POST', `/api/matches/${encodeURIComponent(l.matchId)}/lobby`, { lobbyCode: l.lobbyCode }),
      (e) => e.status === 409);

    const result = readJson(file('result.json'));
    if (result) {
      const safeId = String(result.matchId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
      writeJson(path.join(dir, 'archive', `${safeId}.json`), result); // keep a copy before sending
      const r = await submit('result.json', (d) => call('POST', `/api/matches/${encodeURIComponent(d.matchId)}/report`, d),
        (e) => e.status === 409 && /already submitted/.test(e.message));
      if (r) {
        const sent = r.res ? `Result submitted (${r.res.state})` : 'Result already submitted';
        // A late log of an earlier match, sent in the same tick that queued or matched the pilot again: the new
        // match stays on screen (the mod acts only on 'matched'), so its room is still created or joined.
        if (['queued', 'matched'].includes(current.state) && current.match?.id !== String(r.data.matchId)) {
          const now = current.state === 'matched' ? `Match ${current.match.id} (${current.match.state})` : 'Searching for opponent';
          setState(current.state, { ...(current.match ? { match: current.match } : {}), message: `${sent} for ${String(r.data.matchId)}; ${now}` });
        } else {
          current = { state: 'reported' };
          setState('reported', { match: r.res, message: sent });
        }
      }
    }
  }

  return { dir, tick, resync, fail, setState, current: () => current, last: () => last };
}

async function cmdRun(a) {
  const creds = loadCreds(a);
  const bridge = createBridge({ creds, game: a.game, region: a.region, noCache: !!a['no-cache'] });
  await bridge.resync('Companion connected').catch((e) => bridge.setState('idle', { message: 'Companion connected (server unreachable)', error: e.message }));
  console.log(`Bridge running in ${bridge.dir}`);
  for (;;) {
    try { await bridge.tick(); } catch (e) {
      console.error('bridge:', e.message);
      try { bridge.fail(e); } catch { /* disk error */ }
    }
    await sleep(1000);
  }
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const needGame = ['scan', 'baseline', 'run', 'approve'];
  if (needGame.includes(cmd) && !a.game) throw new Error('--game <install dir> required');
  if (cmd === 'register') return cmdRegister(a);
  if (cmd === 'scan') return cmdScan(a);
  if (cmd === 'join-event') return cmdJoinEvent(a);
  if (cmd === 'baseline') return cmdBaseline(a);
  if (cmd === 'approve') return cmdApprove(a);
  if (cmd === 'run') return cmdRun(a);
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '').replace(/^ \* ?/gm, ''));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { buildReport, createBridge, writeJson, cmdApprove, DEFAULT_EXCLUDES };
