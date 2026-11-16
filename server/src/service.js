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

// ---------- players ----------
function registerPlayer(db, { name, platformId }) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_\- ]{3,24}$/.test(name)) {
    throw new HttpError(400, 'name must be 3-24 chars: letters, digits, space, _ or -');
  }
  const { apiKey, apiSecret } = newCredentials();
  try {
    const r = db.prepare(`INSERT INTO players (name, platform_id, api_key_hash, api_secret, rating, peak_rating, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(name.trim(), platformId || null, sha256(apiKey), apiSecret,
      config.rating.initial, config.rating.initial, now());
    return { id: Number(r.lastInsertRowid), name: name.trim(), apiKey, apiSecret };
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'name or platform id already registered');
    throw e;
  }
}

const publicPlayer = (p) => p && ({
  id: p.id, name: p.name, rating: Math.round(p.rating), peakRating: Math.round(p.peak_rating),
  tier: tierFor(p.rating), wins: p.wins, losses: p.losses, kills: p.kills, deaths: p.deaths,
  kd: p.deaths ? +(p.kills / p.deaths).toFixed(2) : p.kills, status: p.status,
});

function leaderboard(db, { limit = 100, offset = 0 } = {}) {
  const rows = db.prepare(`SELECT * FROM players WHERE status = 'active' AND (wins + losses) > 0
    ORDER BY rating DESC, wins DESC LIMIT ? OFFSET ?`).all(Math.min(limit, 500), offset);
  return rows.map((p, i) => ({ rank: offset + i + 1, ...publicPlayer(p) }));
}

function playerProfile(db, id) {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'player not found');
  const matches = recentMatches(db, { playerId: id, limit: 20 });
  const lastScan = db.prepare(`SELECT verdict, mods, created_at FROM integrity_reports WHERE player_id = ?
    ORDER BY id DESC LIMIT 1`).get(id);
  return {
    ...publicPlayer(p),
    integrity: lastScan ? { verdict: lastScan.verdict, mods: json(lastScan.mods, []), at: lastScan.created_at } : null,
    matches,
  };
}

// ---------- integrity ----------
function activeBaseline(db, version) {
  const b = db.prepare('SELECT * FROM baselines WHERE game_version = ? AND active = 1').get(String(version || ''));
  return b ? { ...b, manifest: json(b.manifest, { files: [] }), aircraft: json(b.aircraft, {}) } : null;
}

function submitIntegrity(db, player, report) {
  const baseline = activeBaseline(db, report && report.gameVersion);
  const approved = db.prepare('SELECT * FROM approved_mods').all();
  const result = integrity.evaluate(report, baseline, approved);
  const token = result.verdict === 'clean' ? 'it_' + crypto.randomBytes(24).toString('base64url') : null;
  const expires = token ? now() + config.integrityTokenTtlMs : null;
  db.prepare(`INSERT INTO integrity_reports (player_id, game_version, verdict, findings, mods, manifest_hash, token, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(player.id, String(report?.gameVersion || ''), result.verdict,
    JSON.stringify(result.findings), JSON.stringify(result.mods), result.manifestHash, token, expires, now());

  // Tampered aircraft data or injected code puts the account under review.
  const severe = result.findings.some((f) => ['aircraft_stat_modified', 'proxy_dll_injection', 'approved_mod_tampered'].includes(f.code));
  if (severe && player.status === 'active') db.prepare("UPDATE players SET status = 'flagged' WHERE id = ?").run(player.id);

  return { verdict: result.verdict, findings: result.findings, mods: result.mods, integrityToken: token, expiresAt: expires };
}

function validIntegrity(db, player, token) {
  const r = db.prepare(`SELECT * FROM integrity_reports WHERE token = ? AND player_id = ? AND verdict = 'clean'`).get(String(token || ''), player.id);
  if (!r || r.expires_at < now()) throw new HttpError(403, 'valid integrity token required: run the scanner again');
  return r;
}

// ---------- queue & matchmaking ----------
function joinQueue(db, player, { integrityToken, region = 'global' }) {
  if (player.status !== 'active') throw new HttpError(403, `account is ${player.status}; competitive queue disabled`);
  const scan = validIntegrity(db, player, integrityToken);
  if (openMatchFor(db, player.id)) throw new HttpError(409, 'you already have an open match');
  db.prepare(`INSERT OR REPLACE INTO queue (player_id, rating, region, integrity_id, joined_at) VALUES (?, ?, ?, ?, ?)`)
    .run(player.id, player.rating, String(region).slice(0, 16), scan.id, now());
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
function runMatchmaker(db, t = now()) {
  return tx(db, () => {
    db.prepare('DELETE FROM queue WHERE joined_at < ?').run(t - config.matchmaking.queueTimeoutMs);
    const entries = db.prepare('SELECT * FROM queue ORDER BY joined_at ASC').all();
    const taken = new Set();
    const created = [];

    for (const e of entries) {
      if (taken.has(e.player_id)) continue;
      const s = tournaments.pendingSeriesFor(db, e.player_id);
      if (!s) continue;
      const opp = s.player_a === e.player_id ? s.player_b : s.player_a;
      if (!taken.has(opp) && entries.some((x) => x.player_id === opp)) {
        const t2 = db.prepare('SELECT rules FROM tournaments WHERE id = ?').get(s.tournament_id);
        created.push(createMatch(db, s.player_a, s.player_b, { ...config.match.defaultRules, ...json(t2.rules, {}) }, s.id));
        taken.add(e.player_id); taken.add(opp);
      }
    }

    for (const a of entries) {
      if (taken.has(a.player_id)) continue;
      let best = null;
      for (const b of entries) {
        if (b.player_id === a.player_id || taken.has(b.player_id)) continue;
        const gap = Math.abs(a.rating - b.rating);
        const win = Math.max(windowFor(a, t), windowFor(b, t));
        const longWait = t - a.joined_at > 120000 && t - b.joined_at > 120000;
        if (gap > win || (a.region !== b.region && !longWait)) continue;
        if (!best || gap < best.gap) best = { b, gap };
      }
      if (best) {
        created.push(createMatch(db, a.player_id, best.b.player_id, config.match.defaultRules, null));
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

function createMatch(db, a, b, rules, seriesId) {
  const id = 'm_' + crypto.randomBytes(9).toString('base64url');
  // The host creates the private room in-game; alternate who hosts at random.
  const [host, guest] = crypto.randomInt(2) ? [a, b] : [b, a];
  db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, series_id, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(id, host, guest, JSON.stringify(rules), seriesId, now());
  return id;
}

function matchView(db, m, viewerId) {
  const pa = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_a);
  const pb = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_b);
  const view = {
    id: m.id, state: m.state, rules: json(m.rules, {}), seriesId: m.series_id,
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
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
  if (!m) throw new HttpError(404, 'match not found');
  return matchView(db, m, viewerId);
}

function setLobby(db, player, matchId, lobbyCode) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!m) throw new HttpError(404, 'match not found');
  if (m.player_a !== player.id) throw new HttpError(403, 'only the host sets the lobby');
  if (m.state !== 'pending') throw new HttpError(409, 'match already started');
  if (typeof lobbyCode !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(lobbyCode)) throw new HttpError(400, 'invalid lobby code');
  db.prepare("UPDATE matches SET lobby_code = ?, state = 'live' WHERE id = ?").run(lobbyCode, matchId);
  return getMatch(db, matchId, player.id);
}

// ---------- match reports ----------
function submitReport(db, player, matchId, report) {
  return tx(db, () => {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!m) throw new HttpError(404, 'match not found');
    if (m.player_a !== player.id && m.player_b !== player.id) throw new HttpError(403, 'not a participant');
    if (!['live', 'awaiting_reports'].includes(m.state)) throw new HttpError(409, `match is ${m.state}`);
    const errs = matchlog.validateShape(report);
    if (errs.length) throw new HttpError(400, 'invalid report: ' + errs.join(', '));

    db.prepare('INSERT OR REPLACE INTO match_reports (match_id, player_id, report, received_at) VALUES (?, ?, ?, ?)')
      .run(matchId, player.id, JSON.stringify(report), now());
    const reports = db.prepare('SELECT * FROM match_reports WHERE match_id = ?').all(matchId);
    if (reports.length < 2) {
      db.prepare("UPDATE matches SET state = 'awaiting_reports' WHERE id = ?").run(matchId);
      return getMatch(db, matchId, player.id);
    }
    resolveMatch(db, m, reports);
    return getMatch(db, matchId, player.id);
  });
}

function resolveMatch(db, m, reports) {
  const repA = json(reports.find((r) => r.player_id === m.player_a).report);
  const repB = json(reports.find((r) => r.player_id === m.player_b).report);
  const gameVersion = repA.gameVersion || repB.gameVersion;
  const baseline = activeBaseline(db, gameVersion);
  const rules = json(m.rules, {});
  const res = matchlog.reconcile(repA, repB, {
    rules, aircraftStats: baseline ? baseline.aircraft : {}, playerA: m.player_a, playerB: m.player_b,
  });
  if (repA.durationSec < config.match.minDurationSec && res.outcome === 'draw') res.flags.push({ code: 'too_short' });

  if (res.flags.length) {
    db.prepare("UPDATE matches SET state = 'disputed', score_a = ?, score_b = ?, flags = ? WHERE id = ?")
      .run(res.scoreA, res.scoreB, JSON.stringify(res.flags), m.id);
    // Physics anomalies seen by the opponent flag the suspect's account for review.
    for (const f of res.flags.filter((x) => x.code === 'speed_anomaly')) {
      db.prepare("UPDATE players SET status = 'flagged' WHERE id = ? AND status = 'active'").run(f.player);
    }
    return;
  }
  applyResult(db, m, res.outcome, res.scoreA, res.scoreB, repA, repB);
}

function applyResult(db, m, outcome, scoreA, scoreB, repA, repB) {
  const pa = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_a);
  const pb = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_b);
  const s = outcome === 'a' ? 1 : outcome === 'b' ? 0 : 0.5;
  const d = eloUpdate(pa, pb, s);
  const upd = db.prepare(`UPDATE players SET rating = rating + ?, peak_rating = MAX(peak_rating, rating + ?),
    wins = wins + ?, losses = losses + ?, kills = kills + ?, deaths = deaths + ? WHERE id = ?`);
  upd.run(d.a, d.a, s === 1 ? 1 : 0, s === 0 ? 1 : 0, repA ? repA.self.kills : scoreA, repA ? repA.self.deaths : scoreB, pa.id);
  upd.run(d.b, d.b, s === 0 ? 1 : 0, s === 1 ? 1 : 0, repB ? repB.self.kills : scoreB, repB ? repB.self.deaths : scoreA, pb.id);
  const winner = s === 1 ? pa.id : s === 0 ? pb.id : null;
  db.prepare(`UPDATE matches SET state = 'verified', winner = ?, score_a = ?, score_b = ?, rating_delta_a = ?, rating_delta_b = ?,
    verified_at = ? WHERE id = ?`).run(winner, scoreA, scoreB, d.a, d.b, now(), m.id);
  if (m.series_id && winner) tournaments.recordSeriesResult(db, m.series_id, winner);
}

// Admin: settle a disputed match (or void it).
function resolveDispute(db, matchId, { winner, scoreHost = 0, scoreGuest = 0, void: isVoid }) {
  return tx(db, () => {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!m) throw new HttpError(404, 'match not found');
    if (!['disputed', 'awaiting_reports', 'live', 'pending'].includes(m.state)) throw new HttpError(409, `match is ${m.state}`);
    if (isVoid) {
      db.prepare("UPDATE matches SET state = 'void' WHERE id = ?").run(matchId);
    } else {
      const outcome = winner === 'host' ? 'a' : winner === 'guest' ? 'b' : winner === 'draw' ? 'draw' : null;
      if (!outcome) throw new HttpError(400, 'winner must be host, guest or draw');
      applyResult(db, m, outcome, Number(scoreHost), Number(scoreGuest), null, null);
    }
    return getMatch(db, matchId);
  });
}

// Matches where only one side reported inside the window go to admin review.
function sweepStaleMatches(db, t = now()) {
  const stale = db.prepare(`SELECT m.id FROM matches m WHERE m.state = 'awaiting_reports'
    AND (SELECT MIN(received_at) FROM match_reports r WHERE r.match_id = m.id) < ?`).all(t - config.match.reportWindowMs);
  const upd = db.prepare("UPDATE matches SET state = 'disputed', flags = ? WHERE id = ?");
  for (const { id } of stale) upd.run(JSON.stringify([{ code: 'missing_opponent_report' }]), id);
  // Rooms never created within the window are voided.
  db.prepare("UPDATE matches SET state = 'void' WHERE state = 'pending' AND created_at < ?").run(t - config.match.reportWindowMs);
  return stale.length;
}

function recentMatches(db, { playerId, state, limit = 50 } = {}) {
  const where = []; const args = [];
  if (playerId) { where.push('(m.player_a = ? OR m.player_b = ?)'); args.push(playerId, playerId); }
  if (state) { where.push('m.state = ?'); args.push(state); }
  const rows = db.prepare(`SELECT m.*, pa.name a_name, pb.name b_name FROM matches m
    JOIN players pa ON pa.id = m.player_a JOIN players pb ON pb.id = m.player_b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT ?`).all(...args, Math.min(limit, 200));
  return rows.map((m) => ({
    id: m.id, state: m.state, host: { id: m.player_a, name: m.a_name }, guest: { id: m.player_b, name: m.b_name },
    score: m.score_a == null ? null : { host: m.score_a, guest: m.score_b }, winner: m.winner,
    ratingDelta: m.rating_delta_a == null ? null : { host: m.rating_delta_a, guest: m.rating_delta_b },
    seriesId: m.series_id, flags: json(m.flags, []), createdAt: m.created_at,
  }));
}

// ---------- admin: baselines & mods ----------
function putBaseline(db, { gameVersion, manifest, aircraft }) {
  if (!gameVersion || !manifest || !Array.isArray(manifest.files)) throw new HttpError(400, 'gameVersion and manifest.files required');
  db.prepare(`INSERT INTO baselines (game_version, manifest, aircraft, active, created_at) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(game_version) DO UPDATE SET manifest = excluded.manifest, aircraft = excluded.aircraft, active = 1`)
    .run(String(gameVersion), JSON.stringify(manifest), JSON.stringify(aircraft || {}), now());
  return { gameVersion, files: manifest.files.length, aircraft: Object.keys(aircraft || {}).length };
}

function addApprovedMod(db, { name, path, size, sha256: hash, category = 'cosmetic' }) {
  if (!name || !path || !Number.isInteger(size) || !/^[a-f0-9]{64}$/i.test(hash || '')) throw new HttpError(400, 'name, path, size, sha256 required');
  if (!['required', 'cosmetic'].includes(category)) throw new HttpError(400, 'category must be required or cosmetic');
  db.prepare('INSERT OR REPLACE INTO approved_mods (name, path, size, sha256, category) VALUES (?, ?, ?, ?, ?)')
    .run(name, path, size, hash.toLowerCase(), category);
  return db.prepare('SELECT * FROM approved_mods ORDER BY name').all();
}

function setPlayerStatus(db, id, status) {
  if (!['active', 'flagged', 'banned'].includes(status)) throw new HttpError(400, 'bad status');
  db.prepare('UPDATE players SET status = ? WHERE id = ?').run(status, id);
  if (status !== 'active') db.prepare('DELETE FROM queue WHERE player_id = ?').run(id);
}

function integrityLog(db, { limit = 100, verdict } = {}) {
  return db.prepare(`SELECT r.id, r.player_id, p.name, r.game_version, r.verdict, r.findings, r.mods, r.created_at
    FROM integrity_reports r JOIN players p ON p.id = r.player_id ${verdict ? 'WHERE r.verdict = ?' : ''}
    ORDER BY r.id DESC LIMIT ?`).all(...(verdict ? [verdict] : []), limit)
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
  putBaseline, addApprovedMod, setPlayerStatus, integrityLog, stats,
};
