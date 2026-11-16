'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const { tx } = require('./db');
const { sha256, newCredentials } = require('./auth');
const integrity = require('./integrity');
const matchlog = require('./matchlog');
const { eloUpdate, tierFor } = require('./rating');
const tournaments = require('./tournaments');
const { HttpError } = tournaments;

const now = () => Date.now();
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const clampInt = (v, d, min, max) => { const n = Number(v); return Number.isSafeInteger(n) ? Math.min(Math.max(n, min), max) : d; };
const { isPlainObject } = integrity;

// ---------- players ----------
// 3-24 characters; letters, digits, space, _ or -; no space at either end.
const NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9_\- ]{1,22}[A-Za-z0-9_-]$/;

function registerPlayer(db, { name } = {}) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!NAME_RE.test(n)) {
    throw new HttpError(400, 'name must be 3-24 chars: letters, digits, space, _ or - (no space at either end)');
  }
  // A platform id (SteamID64) is not accepted from the client: it cannot be verified yet, and an unverified
  // unique id would let anyone reserve someone else's. See docs/SECURITY.md.
  const { apiKey, apiSecret } = newCredentials();
  try {
    const r = db.prepare(`INSERT INTO players (name, api_key_hash, api_secret, rating, peak_rating, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(n, sha256(apiKey), apiSecret, config.rating.initial, config.rating.initial, now());
    return { id: Number(r.lastInsertRowid), name: n, apiKey, apiSecret };
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'callsign already registered');
    throw e;
  }
}

const publicPlayer = (p) => p && ({
  id: p.id, name: p.name, rating: Math.round(p.rating), peakRating: Math.round(p.peak_rating),
  tier: tierFor(p.rating), wins: p.wins, losses: p.losses, draws: p.draws || 0, kills: p.kills, deaths: p.deaths,
  kd: p.deaths ? +(p.kills / p.deaths).toFixed(2) : p.kills, status: p.status,
});

function leaderboard(db, { limit = 100, offset = 0 } = {}) {
  const lim = clampInt(limit, 100, 1, 500);
  const off = clampInt(offset, 0, 0, 1e6);
  const rows = db.prepare(`SELECT * FROM players WHERE status = 'active' AND (wins + losses + draws) > 0
    ORDER BY rating DESC, wins DESC, id ASC LIMIT ? OFFSET ?`).all(lim, off);
  return rows.map((p, i) => ({ rank: off + i + 1, ...publicPlayer(p) }));
}

function playerProfile(db, id) {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'player not found');
  const matches = recentMatches(db, { playerId: id, limit: 20 });
  const lastScan = db.prepare(`SELECT verdict, mods, created_at FROM integrity_reports WHERE player_id = ?
    ORDER BY id DESC LIMIT 1`).get(id);
  const mods = lastScan ? json(lastScan.mods, []) : [];
  return {
    ...publicPlayer(p),
    integrity: lastScan ? { verdict: lastScan.verdict, mods: mods.slice(0, 50), modsTotal: mods.length, at: lastScan.created_at } : null,
    matches,
  };
}

// ---------- integrity ----------
function baselineFor(db, version, { activeOnly = true } = {}) {
  const b = db.prepare(`SELECT * FROM baselines WHERE game_version = ? ${activeOnly ? 'AND active = 1' : ''}`).get(String(version || ''));
  return b ? { ...b, manifest: json(b.manifest, { files: [] }), aircraft: json(b.aircraft, {}) } : null;
}

// The first entries of `list` that fit in `n` items and `budget` bytes of JSON.
function capList(list, n, budget) {
  const out = []; let bytes = 2;
  for (const x of list) {
    const b = Buffer.byteLength(JSON.stringify(x)) + 1;
    if (out.length >= n || bytes + b > budget) break;
    out.push(x); bytes += b;
  }
  return out;
}

// Tampered aircraft data or injected code in a player's own report puts the account under review.
const SELF_INCRIMINATING = ['aircraft_stat_modified', 'proxy_dll_injection', 'approved_mod_tampered'];

// The findings that explain a verdict are never the ones cut: first one finding of every code, those that flag
// the account first and then by severity, then the remaining findings in the same order. Past `n` entries or
// `budget` bytes, a per-code count of everything stands in for the rest.
function capFindings(findings, n, budget = Infinity) {
  const rank = (f) => (SELF_INCRIMINATING.includes(f.code) ? 10 : 0) + (integrity.SEVERITY[f.severity] ?? 0);
  const sorted = [...findings].sort((a, b) => rank(b) - rank(a));
  const seen = new Set(); const firsts = []; const rest = [];
  for (const f of sorted) {
    if (seen.has(f.code)) rest.push(f);
    else { seen.add(f.code); firsts.push(f); }
  }
  const kept = capList([...firsts, ...rest], n, budget);
  if (kept.length === sorted.length) return kept;
  const counts = {};
  for (const f of findings) counts[f.code] = (counts[f.code] || 0) + 1;
  return [...kept, { code: 'findings_truncated', severity: 'info', total: findings.length, counts }];
}

function submitIntegrity(db, player, report) {
  const c = config.integrity;
  if (!isPlainObject(report)) throw new HttpError(400, 'report must be an object');
  const rt = isPlainObject(report.runtime) ? report.runtime : {};
  const long = (v, max) => typeof v === 'string' && v.length > max;
  if ((Array.isArray(report.files) && report.files.length > c.maxFiles)
    || (Array.isArray(rt.loadedModules) && rt.loadedModules.length > c.maxLoadedModules)
    || (isPlainObject(rt.aircraft) && Object.keys(rt.aircraft).length > c.maxAircraft)) {
    throw new HttpError(413, 'integrity report too large');
  }
  // Counts alone do not bound storage: a few multi-megabyte strings would be copied into findings and mods.
  if ((Array.isArray(report.files) && report.files.some((f) => isPlainObject(f) && long(f.path, c.maxPathLength)))
    || (Array.isArray(rt.loadedModules) && rt.loadedModules.some((m) => long(m, c.maxModuleName)))
    || (isPlainObject(rt.aircraft) && Object.keys(rt.aircraft).some((k) => k.length > c.maxAircraftId))) {
    throw new HttpError(413, 'integrity report has an oversized path, module or aircraft name');
  }
  const last = db.prepare('SELECT created_at FROM integrity_reports WHERE player_id = ? ORDER BY id DESC LIMIT 1').get(player.id);
  if (last && now() - last.created_at < c.minIntervalMs) {
    throw new HttpError(429, `wait ${Math.ceil((c.minIntervalMs - (now() - last.created_at)) / 1000)}s before scanning again`);
  }

  const gameVersion = typeof report.gameVersion === 'string' ? report.gameVersion.slice(0, 32) : '';
  const baseline = baselineFor(db, gameVersion);
  const approved = db.prepare('SELECT * FROM approved_mods').all();
  const result = integrity.evaluate({ ...report, gameVersion }, baseline, approved);
  const token = result.verdict === 'clean' ? 'it_' + crypto.randomBytes(24).toString('base64url') : null;
  const expires = token ? now() + config.integrityTokenTtlMs : null;
  const findings = capFindings(result.findings, c.storedFindings, c.maxStoredBytes / 2);
  const mods = capList([...result.mods].sort((a, b) => a.approved - b.approved), c.storedFindings, c.maxStoredBytes / 2);

  tx(db, () => {
    db.prepare(`INSERT INTO integrity_reports (player_id, game_version, verdict, findings, mods, manifest_hash, token, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(player.id, gameVersion, result.verdict,
      JSON.stringify(findings), JSON.stringify(mods), result.manifestHash, token, expires, now());

    const severe = result.findings.some((f) => SELF_INCRIMINATING.includes(f.code));
    if (severe && player.status === 'active') db.prepare("UPDATE players SET status = 'flagged' WHERE id = ?").run(player.id);
    // A failed re-scan ends the current queue session.
    if (result.verdict !== 'clean' || severe) db.prepare('DELETE FROM queue WHERE player_id = ?').run(player.id);

    // Retention: keep the latest reports and any report a queue entry still points at.
    db.prepare(`DELETE FROM integrity_reports WHERE player_id = ?
      AND id NOT IN (SELECT id FROM integrity_reports WHERE player_id = ? ORDER BY id DESC LIMIT ?)
      AND id NOT IN (SELECT integrity_id FROM queue)`).run(player.id, player.id, c.keepReports);
  });

  return { verdict: result.verdict, findings, mods, integrityToken: token, expiresAt: expires };
}

// A clean, unexpired token for a game build that is still active.
function validIntegrity(db, player, token) {
  const fail = () => new HttpError(403, 'valid integrity token required: run the scanner again');
  if (typeof token !== 'string' || !token) throw fail();
  const r = db.prepare(`SELECT r.* FROM integrity_reports r JOIN baselines b ON b.game_version = r.game_version AND b.active = 1
    WHERE r.token = ? AND r.player_id = ? AND r.verdict = 'clean'`).get(token, player.id);
  if (!r || r.expires_at < now()) throw fail();
  return r;
}

// ---------- queue & matchmaking ----------
function joinQueue(db, player, { integrityToken, region } = {}) {
  if (player.status !== 'active') throw new HttpError(403, `account is ${player.status}; competitive queue disabled`);
  const regions = config.matchmaking.regions;
  const reg = region == null || region === '' ? 'global' : region;
  if (typeof reg !== 'string' || !regions.includes(reg)) throw new HttpError(400, `region must be one of: ${regions.join(', ')}`);
  const scan = validIntegrity(db, player, integrityToken);
  if (openMatchFor(db, player.id)) throw new HttpError(409, 'you already have an open match');
  db.prepare(`INSERT OR REPLACE INTO queue (player_id, rating, region, integrity_id, game_version, joined_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(player.id, player.rating, reg, scan.id, scan.game_version, now());
  runMatchmaker(db);
  return queueStatus(db, player);
}

function leaveQueue(db, player) {
  db.prepare('DELETE FROM queue WHERE player_id = ?').run(player.id);
}

function openMatchFor(db, playerId) {
  return db.prepare(`SELECT * FROM matches WHERE (player_a = ? OR player_b = ?)
    AND state IN ('pending', 'live', 'awaiting_reports') ORDER BY created_at DESC LIMIT 1`).get(playerId, playerId);
}

function queueStatus(db, player) {
  const m = openMatchFor(db, player.id);
  if (m) return { state: 'matched', match: matchView(db, m, player.id) };
  const q = db.prepare('SELECT * FROM queue WHERE player_id = ?').get(player.id);
  if (q) return { state: 'queued', waitingSec: Math.round((now() - q.joined_at) / 1000) };
  return { state: 'idle' };
}

function windowFor(entry, t) {
  const c = config.matchmaking;
  return Math.min(c.maxWindow, c.baseWindow + c.windowGrowthPerSec * ((t - entry.joined_at) / 1000));
}

// Pairs queued players. Tournament opponents are paired first, then rating-based ranked matches.
// Runs from the background tick and when someone joins, never on status polls.
function runMatchmaker(db, t = now()) {
  return tx(db, () => {
    const mm = config.matchmaking;
    db.prepare('DELETE FROM queue WHERE joined_at < ?').run(t - mm.queueTimeoutMs);
    // Entries that stopped being eligible while queued: account flagged/banned, scan expired, build retired.
    db.prepare("DELETE FROM queue WHERE player_id IN (SELECT id FROM players WHERE status != 'active')").run();
    db.prepare('DELETE FROM queue WHERE integrity_id IN (SELECT id FROM integrity_reports WHERE expires_at IS NULL OR expires_at < ?)').run(t);
    db.prepare('DELETE FROM queue WHERE game_version NOT IN (SELECT game_version FROM baselines WHERE active = 1)').run();

    const entries = db.prepare('SELECT * FROM queue ORDER BY joined_at ASC, player_id ASC').all();
    const byId = new Map(entries.map((e) => [e.player_id, e]));
    const taken = new Set();
    const seriesBound = new Set(); // owe a series: kept for their tournament opponent, not paired in ranked
    const created = [];
    const openSeries = db.prepare(tournaments.OPEN_SERIES_SQL);
    const rulesOf = db.prepare('SELECT rules FROM tournaments WHERE id = ?');

    // 1. Tournament series: any open series whose opponent is queued on the same build.
    for (const e of entries) {
      const open = openSeries.all(e.player_id, e.player_id);
      if (open.length) seriesBound.add(e.player_id);
      if (taken.has(e.player_id)) continue;
      for (const s of open) {
        const opp = s.player_a === e.player_id ? s.player_b : s.player_a;
        const o = byId.get(opp);
        if (!o || taken.has(opp) || o.game_version !== e.game_version) continue;
        const rules = { ...config.match.defaultRules, ...json(rulesOf.get(s.tournament_id).rules, {}) };
        created.push(createMatch(db, s.player_a, s.player_b, rules, s.id, e.game_version));
        taken.add(e.player_id); taken.add(opp);
        break;
      }
    }

    // 2. Ranked: closest rating inside both players' windows, same build, same region unless both waited long.
    //    Candidates are found by binary search on a rating-sorted pool, so a big queue stays cheap.
    const pool = entries.filter((e) => !taken.has(e.player_id) && !seriesBound.has(e.player_id))
      .sort((x, y) => x.rating - y.rating || x.player_id - y.player_id);
    const firstAtLeast = (r) => {
      let lo = 0; let hi = pool.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid].rating < r) lo = mid + 1; else hi = mid; }
      return lo;
    };
    for (const a of entries) { // oldest first
      if (taken.has(a.player_id) || seriesBound.has(a.player_id)) continue;
      let best = null;
      for (let i = firstAtLeast(a.rating - mm.maxWindow); i < pool.length && pool[i].rating <= a.rating + mm.maxWindow; i++) {
        const b = pool[i];
        if (b.player_id === a.player_id || taken.has(b.player_id) || b.game_version !== a.game_version) continue;
        const gap = Math.abs(a.rating - b.rating);
        const win = Math.max(windowFor(a, t), windowFor(b, t));
        const longWait = t - a.joined_at > mm.longWaitMs && t - b.joined_at > mm.longWaitMs;
        if (gap > win || (a.region !== b.region && !longWait)) continue;
        if (!best || gap < best.gap) best = { b, gap };
      }
      if (best) {
        created.push(createMatch(db, a.player_id, best.b.player_id, config.match.defaultRules, null, a.game_version));
        taken.add(a.player_id); taken.add(best.b.player_id);
      }
    }
    if (taken.size) {
      const del = db.prepare('DELETE FROM queue WHERE player_id = ?');
      for (const id of taken) del.run(id);
    }
    return created;
  });
}

function createMatch(db, a, b, rules, seriesId, gameVersion) {
  const id = 'm_' + crypto.randomBytes(9).toString('base64url');
  // The host creates the private room in-game; alternate who hosts at random.
  const [host, guest] = crypto.randomInt(2) ? [a, b] : [b, a];
  db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, game_version, state, series_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, host, guest, JSON.stringify(rules), gameVersion, seriesId, now());
  return id;
}

function matchView(db, m, viewerId) {
  const pa = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_a);
  const pb = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_b);
  const view = {
    id: m.id, state: m.state, rules: json(m.rules, {}), gameVersion: m.game_version, seriesId: m.series_id,
    host: publicPlayer(pa), guest: publicPlayer(pb),
    score: m.score_a == null ? null : { host: m.score_a, guest: m.score_b },
    winner: m.winner, ratingDelta: m.rating_delta_a == null ? null : { host: m.rating_delta_a, guest: m.rating_delta_b },
    flags: json(m.flags, []), createdAt: m.created_at, verifiedAt: m.verified_at,
  };
  // The room code is only revealed to the two participants.
  if (viewerId === m.player_a || viewerId === m.player_b) {
    view.lobbyCode = m.lobby_code;
    view.role = viewerId === m.player_a ? 'host' : 'guest';
  }
  return view;
}

function getMatch(db, id, viewerId) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(String(id));
  if (!m) throw new HttpError(404, 'match not found');
  return matchView(db, m, viewerId);
}

function setLobby(db, player, matchId, lobbyCode) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!m) throw new HttpError(404, 'match not found');
  if (m.player_a !== player.id) throw new HttpError(403, 'only the host sets the lobby');
  if (m.state !== 'pending') throw new HttpError(409, 'match already started');
  if (typeof lobbyCode !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(lobbyCode)) throw new HttpError(400, 'invalid lobby code');
  db.prepare("UPDATE matches SET lobby_code = ?, state = 'live', live_at = ? WHERE id = ?").run(lobbyCode, now(), matchId);
  return getMatch(db, matchId, player.id);
}

// ---------- match reports ----------
// Closed by the background sweep (swept_at) and not since ruled on: an admin can still settle or void it, and
// logs that arrive within config.match.lateReportMs of the sweep still settle it. Only the sweep sets
// swept_at, so rooms closed by older releases or by an admin never reopen. The sweep never voids event games.
const SWEEP_CODES = ['no_reports', 'missing_opponent_report'];
function closedBySweep(m) {
  if (m.swept_at == null || !['void', 'disputed'].includes(m.state) || (m.state === 'void' && m.series_id)) return false;
  const f = json(m.flags, []);
  return Array.isArray(f) && f.length > 0 && f.every((x) => SWEEP_CODES.includes(x?.code));
}

function submitReport(db, player, matchId, report) {
  return tx(db, () => {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!m) throw new HttpError(404, 'match not found');
    if (m.player_a !== player.id && m.player_b !== player.id) throw new HttpError(403, 'not a participant');
    // One report per pilot, checked first so a retry after a lost response is recognised whatever the match
    // state is now. A resubmission would also restart the report window and stall the sweep.
    if (db.prepare('SELECT 1 FROM match_reports WHERE match_id = ? AND player_id = ?').get(matchId, player.id)) {
      throw new HttpError(409, 'report already submitted');
    }
    const late = closedBySweep(m);
    if (!['live', 'awaiting_reports'].includes(m.state) && !late) throw new HttpError(409, `match is ${m.state}`);
    if (late && now() - m.swept_at > config.match.lateReportMs) throw new HttpError(409, `match is ${m.state}: logs were due long ago`);
    const errs = matchlog.validateShape(report);
    if (errs.length) throw new HttpError(400, 'invalid report: ' + errs.join(', '));

    db.prepare('INSERT INTO match_reports (match_id, player_id, report, received_at) VALUES (?, ?, ?, ?)')
      .run(matchId, player.id, JSON.stringify(report), now());
    const reports = db.prepare('SELECT * FROM match_reports WHERE match_id = ?').all(matchId);
    if (reports.length < 2) {
      // A room the sweep closed does not reopen (nobody is held out of the queue). With one log in it goes to
      // an admin, who can award it, and the other log still settles it if it arrives in time.
      if (late) db.prepare("UPDATE matches SET state = 'disputed', flags = ? WHERE id = ?").run(JSON.stringify([{ code: 'missing_opponent_report' }]), matchId);
      else db.prepare("UPDATE matches SET state = 'awaiting_reports' WHERE id = ?").run(matchId);
      return getMatch(db, matchId, player.id);
    }
    resolveMatch(db, m, reports);
    return getMatch(db, matchId, player.id);
  });
}

function resolveMatch(db, m, reports) {
  const repA = json(reports.find((r) => r.player_id === m.player_a).report);
  const repB = json(reports.find((r) => r.player_id === m.player_b).report);
  // The build comes from both players' clean scans (stored on the match), never from the logs themselves.
  const baseline = baselineFor(db, m.game_version, { activeOnly: false });
  const extra = [];
  if (!baseline) extra.push({ code: 'no_reference_stats', gameVersion: m.game_version });
  for (const [rep, pid] of [[repA, m.player_a], [repB, m.player_b]]) {
    if (rep.gameVersion !== m.game_version) {
      extra.push({ code: 'game_version_mismatch', player: pid, reported: rep.gameVersion ?? null, expected: m.game_version });
    }
  }
  const res = matchlog.reconcile(repA, repB, {
    rules: json(m.rules, {}), aircraftStats: baseline ? baseline.aircraft : {},
    playerA: m.player_a, playerB: m.player_b, minDurationSec: config.match.minDurationSec,
  });
  res.flags.push(...extra);

  if (res.flags.length) {
    db.prepare("UPDATE matches SET state = 'disputed', score_a = ?, score_b = ?, flags = ? WHERE id = ?")
      .run(res.scoreA, res.scoreB, JSON.stringify(res.flags), m.id);
    // Tampered stats in a pilot's OWN log flag that pilot's account. Anything the opponent observed (such as a
    // speed anomaly) only sends the match to admin review: one opponent's number must not lock anyone out.
    for (const f of res.flags.filter((x) => x.code === 'aircraft_stat_modified')) {
      db.prepare("UPDATE players SET status = 'flagged' WHERE id = ? AND status = 'active'").run(f.player);
    }
    return;
  }
  // A late settle of a room the sweep closed drops the sweep's flag.
  db.prepare("UPDATE matches SET flags = '[]' WHERE id = ?").run(m.id);
  applyResult(db, m, res.outcome, res.scoreA, res.scoreB, repA, repB);
}

function applyResult(db, m, outcome, scoreA, scoreB, repA, repB) {
  const pa = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_a);
  const pb = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_b);
  const s = outcome === 'a' ? 1 : outcome === 'b' ? 0 : 0.5;
  const d = eloUpdate(pa, pb, s);
  const ka = repA ? repA.self.kills : scoreA; const da = repA ? repA.self.deaths : scoreB;
  const kb = repB ? repB.self.kills : scoreB; const dbb = repB ? repB.self.deaths : scoreA;
  const upd = db.prepare(`UPDATE players SET rating = rating + ?, peak_rating = MAX(peak_rating, rating + ?),
    wins = wins + ?, losses = losses + ?, draws = draws + ?, kills = kills + ?, deaths = deaths + ? WHERE id = ?`);
  upd.run(d.a, d.a, s === 1 ? 1 : 0, s === 0 ? 1 : 0, s === 0.5 ? 1 : 0, ka, da, pa.id);
  upd.run(d.b, d.b, s === 0 ? 1 : 0, s === 1 ? 1 : 0, s === 0.5 ? 1 : 0, kb, dbb, pb.id);
  const winner = s === 1 ? pa.id : s === 0 ? pb.id : null;
  db.prepare(`UPDATE matches SET state = 'verified', winner = ?, score_a = ?, score_b = ?, rating_delta_a = ?, rating_delta_b = ?,
    kills_a = ?, deaths_a = ?, kills_b = ?, deaths_b = ?, verified_at = ? WHERE id = ?`)
    .run(winner, scoreA, scoreB, d.a, d.b, ka, da, kb, dbb, now(), m.id);
  if (m.series_id && winner) tournaments.recordSeriesResult(db, m.series_id, winner);
}

// Undo a verified result: rating deltas, record, credited K/D and the series game. peak_rating is not
// recomputed (see docs/SECURITY.md).
function revertResult(db, m) {
  const series = m.series_id && m.winner ? tournaments.revertSeriesResult(db, m.series_id, m.winner) : undefined;
  const s = m.winner == null ? 0.5 : m.winner === m.player_a ? 1 : 0;
  const upd = db.prepare(`UPDATE players SET rating = rating - ?, wins = MAX(0, wins - ?), losses = MAX(0, losses - ?),
    draws = MAX(0, draws - ?), kills = MAX(0, kills - ?), deaths = MAX(0, deaths - ?) WHERE id = ?`);
  upd.run(m.rating_delta_a || 0, s === 1 ? 1 : 0, s === 0 ? 1 : 0, s === 0.5 ? 1 : 0, m.kills_a ?? m.score_a ?? 0, m.deaths_a ?? m.score_b ?? 0, m.player_a);
  upd.run(m.rating_delta_b || 0, s === 0 ? 1 : 0, s === 1 ? 1 : 0, s === 0.5 ? 1 : 0, m.kills_b ?? m.score_b ?? 0, m.deaths_b ?? m.score_a ?? 0, m.player_b);
  return series;
}

// Admin: settle a disputed or stuck match, or void any match (a verified one is reverted first). A room the
// sweep voided can be settled or voided for good too.
function resolveDispute(db, matchId, { winner, scoreHost = 0, scoreGuest = 0, void: isVoid } = {}) {
  return tx(db, () => {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(String(matchId));
    if (!m) throw new HttpError(404, 'match not found');
    const open = ['disputed', 'awaiting_reports', 'live', 'pending'].includes(m.state) || closedBySweep(m);
    if (isVoid === true) {
      if (!open && m.state !== 'verified') throw new HttpError(409, `match is ${m.state}`);
      const series = m.state === 'verified' ? revertResult(db, m) : undefined;
      // The match no longer shows a winner, score or rating change; the flag keeps what was undone. The flag
      // also marks the void as an admin decision, so late reports cannot reopen it.
      const old = json(m.flags, []);
      const flags = [...(Array.isArray(old) ? old : []), { code: 'admin_void',
        ...(m.state === 'verified' ? { reverted: { winner: m.winner, score: [m.score_a, m.score_b], ratingDelta: [m.rating_delta_a, m.rating_delta_b] } } : {}),
        ...(series ? { series } : {}) }];
      db.prepare(`UPDATE matches SET state = 'void', winner = NULL, score_a = NULL, score_b = NULL, rating_delta_a = NULL,
        rating_delta_b = NULL, kills_a = NULL, deaths_a = NULL, kills_b = NULL, deaths_b = NULL, flags = ? WHERE id = ?`)
        .run(JSON.stringify(flags), m.id);
    } else {
      if (!open) throw new HttpError(409, `match is ${m.state}`);
      const outcome = winner === 'host' ? 'a' : winner === 'guest' ? 'b' : winner === 'draw' ? 'draw' : null;
      if (!outcome) throw new HttpError(400, 'winner must be host, guest or draw');
      const sh = Number(scoreHost); const sg = Number(scoreGuest);
      if (!Number.isSafeInteger(sh) || !Number.isSafeInteger(sg) || sh < 0 || sg < 0) throw new HttpError(400, 'scores must be non-negative integers');
      applyResult(db, m, outcome, sh, sg, null, null);
    }
    return getMatch(db, m.id);
  });
}

// Background sweep for matches that can no longer finish on their own.
function sweepStaleMatches(db, t = now()) {
  const c = config.match;
  // Only one side reported inside the window: admin review.
  const stale = db.prepare(`SELECT m.id FROM matches m WHERE m.state = 'awaiting_reports'
    AND (SELECT MIN(received_at) FROM match_reports r WHERE r.match_id = m.id) < ?`).all(t - c.reportWindowMs);
  const upd = db.prepare("UPDATE matches SET state = 'disputed', flags = ?, swept_at = ? WHERE id = ?");
  for (const { id } of stale) upd.run(JSON.stringify([{ code: 'missing_opponent_report' }]), t, id);
  // Rooms never created within the window are voided.
  db.prepare("UPDATE matches SET state = 'void' WHERE state = 'pending' AND created_at < ?").run(t - c.reportWindowMs);
  // Rooms that went live but got no report from anyone are closed once the match must be over, so a guest who
  // never joined (or a fake room code) cannot lock both pilots out of the queue. A ranked room is voided. An
  // event game goes to an admin instead: voiding it would hand the series a rematch, and a pilot who is losing
  // could stall the room to get one. Either way, logs that arrive later (config.match.lateReportMs) still settle
  // the match, and an admin can rule on it.
  const live = db.prepare(`SELECT id, rules, created_at, live_at, series_id FROM matches m WHERE state = 'live'
    AND NOT EXISTS (SELECT 1 FROM match_reports r WHERE r.match_id = m.id)`).all();
  const close = db.prepare("UPDATE matches SET state = ?, flags = ?, swept_at = ? WHERE id = ? AND state = 'live'");
  let closed = 0;
  for (const m of live) {
    const tl = Number(json(m.rules, {}).timeLimitSec);
    const limit = tl > 0 ? tl : c.untimedMatchSec; // timeLimitSec 0 means no time limit
    if ((m.live_at ?? m.created_at) + limit * 1000 + c.liveGraceMs < t) {
      close.run(m.series_id ? 'disputed' : 'void', JSON.stringify([{ code: 'no_reports' }]), t, m.id); closed++;
    }
  }
  return stale.length + closed;
}

function recentMatches(db, { playerId, state, limit = 50 } = {}) {
  const where = []; const args = [];
  if (playerId) { where.push('(m.player_a = ? OR m.player_b = ?)'); args.push(playerId, playerId); }
  if (typeof state === 'string' && state) { where.push('m.state = ?'); args.push(state); }
  const rows = db.prepare(`SELECT m.*, pa.name a_name, pb.name b_name FROM matches m
    JOIN players pa ON pa.id = m.player_a JOIN players pb ON pb.id = m.player_b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT ?`).all(...args, clampInt(limit, 50, 1, 200));
  return rows.map((m) => ({
    id: m.id, state: m.state, host: { id: m.player_a, name: m.a_name }, guest: { id: m.player_b, name: m.b_name },
    score: m.score_a == null ? null : { host: m.score_a, guest: m.score_b }, winner: m.winner,
    ratingDelta: m.rating_delta_a == null ? null : { host: m.rating_delta_a, guest: m.rating_delta_b },
    seriesId: m.series_id, flags: json(m.flags, []), createdAt: m.created_at,
  }));
}

// ---------- admin: baselines & mods ----------
function putBaseline(db, { gameVersion, manifest, aircraft, active = true } = {}) {
  if (typeof gameVersion !== 'string' || !gameVersion || gameVersion.length > 32 || !manifest || !Array.isArray(manifest.files)) {
    throw new HttpError(400, 'gameVersion (string) and manifest.files required');
  }
  if (aircraft !== undefined && !isPlainObject(aircraft)) throw new HttpError(400, 'aircraft must be an object of stats per aircraft id');
  const on = active === false || active === 0 ? 0 : 1;
  db.prepare(`INSERT INTO baselines (game_version, manifest, aircraft, active, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_version) DO UPDATE SET manifest = excluded.manifest, aircraft = excluded.aircraft, active = excluded.active`)
    .run(gameVersion, JSON.stringify(manifest), JSON.stringify(aircraft || {}), on, now());
  return { gameVersion, active: !!on, files: manifest.files.length, aircraft: Object.keys(aircraft || {}).length };
}

// Retire (or re-enable) a game build. Retired builds cannot scan clean and their tokens stop working.
function setBaselineActive(db, gameVersion, active) {
  if (typeof active !== 'boolean') throw new HttpError(400, 'active must be true or false');
  const r = db.prepare('UPDATE baselines SET active = ? WHERE game_version = ?').run(active ? 1 : 0, String(gameVersion));
  if (!r.changes) throw new HttpError(404, 'baseline not found');
  return { gameVersion: String(gameVersion), active };
}

const MOD_CATEGORIES = ['required', 'cosmetic', 'retired'];
const { canonPath } = integrity;

function addOneMod(db, m) {
  if (!isPlainObject(m)) throw new HttpError(400, 'each mod must be an object');
  const { name, path, size, sha256: hash, category = 'cosmetic', version = '' } = m;
  if (typeof name !== 'string' || !name || name.length > 128 || typeof path !== 'string' || !path || path.length > 1024
    || !Number.isSafeInteger(size) || size < 0 || typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new HttpError(400, 'name, path, size, sha256 required');
  }
  if (!MOD_CATEGORIES.includes(category)) throw new HttpError(400, 'category must be required, cosmetic or retired');
  if (typeof version !== 'string' || version.length > 64 || version.includes('#')) {
    throw new HttpError(400, 'version must be a string of up to 64 characters without #');
  }
  // Stored the way the scan compares paths (forward slashes, ASCII lower case), so two spellings of one file
  // are one file here too.
  const p = canonPath(path);
  if (!p || p.split('/').some((seg) => seg === '.' || seg === '..')) throw new HttpError(400, 'path must name a file under the game root');
  const sha = hash.toLowerCase();
  // A file belongs to one mod. A loader folder approved with another mod inside it would make the loader's
  // build require that mod's files too, and one of the two could then never be updated.
  const other = db.prepare("SELECT id, name, version FROM approved_mods WHERE path = ? AND name != ? AND category != 'retired' LIMIT 1").get(p, name);
  if (other) {
    throw new HttpError(409, `${p} is already pinned by the mod "${other.name}" version "${other.version}" (id ${other.id}). Approve each mod's files `
      + `separately (rvng approve --exclude); if that build should not contain this file, retire it (POST /api/admin/mods/retire) and upload it again without the file`);
  }
  // Approving a build again with a different file: the earlier pinned file stays known as a retired row, so a
  // pilot who installed it is told to update instead of being flagged for a tampered mod.
  const cur = db.prepare('SELECT * FROM approved_mods WHERE name = ? AND version = ? AND path = ?').get(name, version, p);
  if (cur && (cur.sha256 !== sha || Number(cur.size) !== size)) {
    db.prepare("UPDATE approved_mods SET version = ?, category = 'retired' WHERE id = ?").run(`${version}#${cur.id}`, cur.id);
  }
  // Each build keeps its own row for every file, also for files it shares with another build.
  db.prepare(`INSERT INTO approved_mods (name, path, size, sha256, category, version) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (name, version, path) DO UPDATE SET category = excluded.category`)
    .run(name, p, size, sha, category, version);
}

// Body is one mod file, or { mods: [...] } for a whole folder (see `rvng approve`).
function addApprovedMods(db, body = {}) {
  const list = Array.isArray(body.mods) ? body.mods : [body];
  if (!list.length || list.length > 5000) throw new HttpError(400, 'mods must hold 1-5000 entries');
  tx(db, () => { for (const m of list) addOneMod(db, m); });
  return listApprovedMods(db);
}

const listApprovedMods = (db) => db.prepare('SELECT * FROM approved_mods ORDER BY name, version, path').all();

// Withdrawing a mod retires it: the old build stays known, so pilots who still have it are told it is out of
// date instead of being flagged for a tampered mod. `purge` deletes the row (for one added by mistake). Only
// that row changes: a build that shares the file keeps its own row.
function removeApprovedMod(db, id, { purge = false } = {}) {
  const r = purge
    ? db.prepare('DELETE FROM approved_mods WHERE id = ?').run(id)
    : db.prepare("UPDATE approved_mods SET category = 'retired' WHERE id = ?").run(id);
  if (!r.changes) throw new HttpError(404, 'approved mod not found');
  return listApprovedMods(db);
}

// Retire every file of one build of a mod (for example the previous release of Project RVNG or UE4SS). Files
// the build shares with another build stay approved through that build's rows.
function retireMods(db, { name, version = '' } = {}) {
  if (typeof name !== 'string' || !name || typeof version !== 'string') throw new HttpError(400, 'name (and optional version) required');
  const r = db.prepare("UPDATE approved_mods SET category = 'retired' WHERE name = ? AND version = ?").run(name, version);
  if (!r.changes) throw new HttpError(404, 'no approved files for that name and version');
  return listApprovedMods(db);
}

function setPlayerStatus(db, id, status) {
  if (!['active', 'flagged', 'banned'].includes(status)) throw new HttpError(400, 'bad status');
  db.prepare('UPDATE players SET status = ? WHERE id = ?').run(status, id);
  if (status !== 'active') db.prepare('DELETE FROM queue WHERE player_id = ?').run(id);
}

function integrityLog(db, { limit = 50, verdict } = {}) {
  const v = typeof verdict === 'string' && verdict ? verdict : null;
  return db.prepare(`SELECT r.id, r.player_id, p.name, r.game_version, r.verdict, r.findings, r.mods, r.created_at
    FROM integrity_reports r JOIN players p ON p.id = r.player_id ${v ? 'WHERE r.verdict = ?' : ''}
    ORDER BY r.id DESC LIMIT ?`).all(...(v ? [v] : []), clampInt(limit, 50, 1, 200))
    .map((r) => ({ ...r, findings: json(r.findings, []), mods: json(r.mods, []) }));
}

function stats(db) {
  return {
    players: db.prepare("SELECT COUNT(*) c FROM players WHERE status = 'active'").get().c,
    matches: db.prepare("SELECT COUNT(*) c FROM matches WHERE state = 'verified'").get().c,
    inQueue: db.prepare('SELECT COUNT(*) c FROM queue').get().c,
    live: db.prepare("SELECT COUNT(*) c FROM matches WHERE state IN ('pending','live','awaiting_reports')").get().c,
  };
}

module.exports = {
  registerPlayer, leaderboard, playerProfile, publicPlayer,
  submitIntegrity, joinQueue, leaveQueue, queueStatus, runMatchmaker,
  getMatch, setLobby, submitReport, resolveDispute, sweepStaleMatches, recentMatches,
  putBaseline, setBaselineActive, addApprovedMods, listApprovedMods, removeApprovedMod, retireMods, capFindings,
  setPlayerStatus, integrityLog, stats,
};
