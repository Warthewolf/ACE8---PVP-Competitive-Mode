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
  // Invite-only: the account exists, but it can do nothing that costs anyone else anything until an admin lets it in.
  const status = config.access.inviteOnly ? 'pending' : 'active';
  try {
    const r = db.prepare(`INSERT INTO players (name, api_key_hash, api_secret, rating, peak_rating, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(n, sha256(apiKey), apiSecret, config.rating.initial, config.rating.initial, status, now());
    return { id: Number(r.lastInsertRowid), name: n, apiKey, apiSecret, status };
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'callsign already registered');
    throw e;
  }
}

// What a pending account is told wherever it tries to play.
const PENDING_MESSAGE = 'your account is waiting for an admin to let you in (this server is invite-only)';
// Scanning, queueing, event entry and reports: only for accounts that have been let in.
function requireLetIn(player) {
  if (player.status === 'pending') throw new HttpError(403, PENDING_MESSAGE);
}

// A pilot who hides their rating shows the tier only, everywhere but in their own signed view. Peak rating and
// their own rating changes are hidden too (summing the changes would give the number back). The casual rating
// is never part of any view.
const publicPlayer = (p, { self = false } = {}) => {
  if (!p) return p;
  const hidden = !!p.hide_rating && !self;
  return {
    id: p.id, name: p.name, rating: hidden ? null : Math.round(p.rating), peakRating: hidden ? null : Math.round(p.peak_rating),
    ratingHidden: !!p.hide_rating, tier: tierFor(p.rating), wins: p.wins, losses: p.losses, draws: p.draws || 0,
    kills: p.kills, deaths: p.deaths, kd: p.deaths ? +(p.kills / p.deaths).toFixed(2) : p.kills, status: p.status,
    role: p.role || 'player', note: p.note || '',
  };
};

function leaderboard(db, { limit = 100, offset = 0 } = {}) {
  const lim = clampInt(limit, 100, 1, 500);
  const off = clampInt(offset, 0, 0, 1e6);
  // Pilots who hide their rating keep their place in the order.
  const rows = db.prepare(`SELECT * FROM players WHERE status = 'active' AND (wins + losses + draws) > 0
    ORDER BY rating DESC, wins DESC, id ASC LIMIT ? OFFSET ?`).all(lim, off);
  return rows.map((p, i) => ({ rank: off + i + 1, ...publicPlayer(p) }));
}

function playerProfile(db, id, { self = false } = {}) {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'player not found');
  const matches = recentMatches(db, { playerId: id, limit: 20, viewerId: self ? id : undefined });
  const lastScan = db.prepare(`SELECT verdict, mods, created_at FROM integrity_reports WHERE player_id = ?
    ORDER BY id DESC LIMIT 1`).get(id);
  const mods = lastScan ? json(lastScan.mods, []) : [];
  return {
    ...publicPlayer(p, { self }),
    integrity: lastScan ? { verdict: lastScan.verdict, mods: mods.slice(0, 50), modsTotal: mods.length, at: lastScan.created_at } : null,
    matches,
  };
}

// Player settings (signed). Only `hideRating` for now.
function updateSettings(db, player, body = {}) {
  if (!isPlainObject(body) || !Object.hasOwn(body, 'hideRating')) throw new HttpError(400, 'nothing to change: send { "hideRating": true | false }');
  if (typeof body.hideRating !== 'boolean') throw new HttpError(400, 'hideRating must be true or false');
  db.prepare('UPDATE players SET hide_rating = ? WHERE id = ?').run(body.hideRating ? 1 : 0, player.id);
  return playerProfile(db, player.id, { self: true });
}

// Plain one-line text: no control characters, and no bidirectional overrides that would make a note or a
// report read differently from what it holds. (The website escapes it as well.)
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

// Admin: a player's role badge and the short note on their card. Either field may be left out.
function setPlayerCard(db, id, body = {}) {
  if (!isPlainObject(body) || (body.role === undefined && body.note === undefined)) throw new HttpError(400, 'send role and/or note');
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, 'player not found');
  const roles = config.players.roles;
  if (body.role !== undefined && (typeof body.role !== 'string' || !roles.includes(body.role))) {
    throw new HttpError(400, `role must be one of: ${roles.join(', ')}`);
  }
  let note;
  if (body.note !== undefined) {
    const max = config.players.maxNoteLength;
    if (typeof body.note !== 'string' || body.note.length > max || UNSAFE_TEXT.test(body.note)) {
      throw new HttpError(400, `note must be one line of plain text, at most ${max} characters`);
    }
    note = body.note.trim();
  }
  db.prepare('UPDATE players SET role = COALESCE(?, role), note = COALESCE(?, note) WHERE id = ?').run(body.role ?? null, note ?? null, p.id);
  return publicPlayer(db.prepare('SELECT * FROM players WHERE id = ?').get(p.id));
}

// Admin: players by status (for example the pending sign-ups of an invite-only server), newest first.
function adminPlayers(db, { status, limit = 100 } = {}) {
  const s = typeof status === 'string' && status ? status : null;
  return db.prepare(`SELECT p.id, p.name, p.status, p.role, p.note, p.hide_rating, p.rating, p.wins, p.losses, p.draws, p.created_at,
      (SELECT COUNT(*) FROM lapses l WHERE l.player_id = p.id) lapses,
      (SELECT COUNT(*) FROM player_reports r WHERE r.reported_id = p.id AND r.state = 'open') open_reports
    FROM players p ${s ? 'WHERE p.status = ?' : ''} ORDER BY p.id DESC LIMIT ?`).all(...(s ? [s] : []), clampInt(limit, 100, 1, 500))
    .map((r) => ({ ...r, rating: Math.round(r.rating), hide_rating: !!r.hide_rating }));
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
const SELF_INCRIMINATING = ['aircraft_stat_modified', 'stat_row_added', 'proxy_dll_injection', 'approved_mod_tampered'];

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
  requireLetIn(player);
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
const MODES = ['ranked', 'casual'];

// Repeated lapses (a matched host who never opened the room) within the window: a short queue cooldown after
// the last one.
function lapseCooldown(db, playerId, t = now()) {
  const d = config.dodging;
  if (!(d.lapses > 0) || !(d.cooldownMs > 0)) return null;
  const r = db.prepare('SELECT COUNT(*) c, MAX(at) last FROM lapses WHERE player_id = ? AND at >= ?').get(playerId, t - d.windowMs);
  if (r.c < d.lapses || t - r.last >= d.cooldownMs) return null;
  return { lapses: r.c, untilMs: r.last + d.cooldownMs };
}

function joinQueue(db, player, { integrityToken, region, mode } = {}) {
  requireLetIn(player);
  if (player.status !== 'active') throw new HttpError(403, `account is ${player.status}; competitive queue disabled`);
  const regions = config.matchmaking.regions;
  const reg = region == null || region === '' ? 'global' : region;
  if (typeof reg !== 'string' || !regions.includes(reg)) throw new HttpError(400, `region must be one of: ${regions.join(', ')}`);
  if (mode != null && mode !== '' && (typeof mode !== 'string' || !MODES.includes(mode))) throw new HttpError(400, `mode must be one of: ${MODES.join(', ')}`);
  // A join that names no mode is ranked, as before modes existed, or casual while the ranked queue is off. Event
  // games are played through the ranked queue, also while it is off: a pilot who owes a series is then only ever
  // paired with their series opponent.
  let m = mode || 'ranked';
  if (m === 'ranked' && !config.modes.ranked && !tournaments.openSeriesFor(db, player.id).length) {
    if (mode) throw new HttpError(403, 'the ranked queue is turned off on this server: queue casual instead (mode "casual")');
    m = 'casual';
  }
  const scan = validIntegrity(db, player, integrityToken);
  if (openMatchFor(db, player.id)) throw new HttpError(409, 'you already have an open match');
  const cd = lapseCooldown(db, player.id);
  if (cd) {
    const hours = Math.round(config.dodging.windowMs / 3600000);
    throw new HttpError(403, `queue cooldown: ${cd.lapses} of your matches lapsed in the last ${hours} h because the room was never opened; `
      + `you can queue again in ${Math.ceil((cd.untilMs - now()) / 60000)} min`);
  }
  // Casual pairs on the hidden casual rating; a pilot new to casual starts from their ranked rating.
  const rating = m === 'casual' ? (player.casual_rating ?? player.rating) : player.rating;
  db.prepare(`INSERT OR REPLACE INTO queue (player_id, rating, region, integrity_id, game_version, mode, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(player.id, rating, reg, scan.id, scan.game_version, m, now());
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
  // While queued, nothing about other pilots is shown: the opponent is only named once the match is created.
  const q = db.prepare('SELECT * FROM queue WHERE player_id = ?').get(player.id);
  if (q) return { state: 'queued', mode: q.mode, waitingSec: Math.round((now() - q.joined_at) / 1000) };
  return { state: 'idle' };
}

// Matching parameters of a queue: ranked uses the top-level values, casual its own looser ones.
const queueParams = (mode) => {
  const mm = config.matchmaking;
  return mode === 'casual' ? { ...mm, ...mm.casual } : mm;
};

function windowFor(entry, t, c = config.matchmaking) {
  return Math.min(c.maxWindow, c.baseWindow + c.windowGrowthPerSec * ((t - entry.joined_at) / 1000));
}

const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

// Pairs queued players. Tournament opponents are paired first, then rating-based ranked matches, then casual
// matches on the hidden casual rating. The two queues never pair with each other.
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

    // 1. Tournament series: any open series whose opponent is queued (ranked) on the same build. Casual entries
    //    never play event games.
    for (const e of entries) {
      if (e.mode === 'casual') continue;
      const open = openSeries.all(e.player_id, e.player_id);
      if (open.length) seriesBound.add(e.player_id);
      if (taken.has(e.player_id)) continue;
      for (const s of open) {
        const opp = s.player_a === e.player_id ? s.player_b : s.player_a;
        const o = byId.get(opp);
        if (!o || o.mode === 'casual' || taken.has(opp) || o.game_version !== e.game_version) continue;
        const rules = { ...config.match.defaultRules, ...json(rulesOf.get(s.tournament_id).rules, {}) };
        created.push(createMatch(db, s.player_a, s.player_b, rules, s.id, e.game_version, 'ranked'));
        taken.add(e.player_id); taken.add(opp);
        break;
      }
    }

    // Pilots who met recently (any mode, also event games) are paired again only if neither has anyone else.
    const recent = new Set();
    if (mm.rematch.windowMs > 0) {
      for (const r of db.prepare('SELECT player_a, player_b FROM matches WHERE created_at >= ?').all(t - mm.rematch.windowMs)) {
        recent.add(pairKey(r.player_a, r.player_b));
      }
    }

    // 2. Ranked (while it is on), then casual: closest rating inside both players' windows, same mode, same build,
    //    same region unless both waited long. Candidates are found by binary search on a rating-sorted pool, so a
    //    big queue stays cheap. A first pass pairs fresh opponents only; a second pass pairs whoever is left with a
    //    recent opponent once both have waited the extra time, so a rematch only happens when there is no one else.
    const ladder = (mode) => {
      const c = queueParams(mode);
      const queued = entries.filter((e) => e.mode === mode && !seriesBound.has(e.player_id)); // oldest first
      const pool = [...queued].sort((x, y) => x.rating - y.rating || x.player_id - y.player_id);
      const firstAtLeast = (r) => {
        let lo = 0; let hi = pool.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pool[mid].rating < r) lo = mid + 1; else hi = mid; }
        return lo;
      };
      for (const rematches of [false, true]) {
        for (const a of queued) {
          if (taken.has(a.player_id)) continue;
          let best = null;
          for (let i = firstAtLeast(a.rating - c.maxWindow); i < pool.length && pool[i].rating <= a.rating + c.maxWindow; i++) {
            const b = pool[i];
            if (b.player_id === a.player_id || taken.has(b.player_id) || b.game_version !== a.game_version) continue;
            if (recent.has(pairKey(a.player_id, b.player_id))
              && (!rematches || t - a.joined_at < mm.rematch.waitMs || t - b.joined_at < mm.rematch.waitMs)) continue;
            const gap = Math.abs(a.rating - b.rating);
            const win = Math.max(windowFor(a, t, c), windowFor(b, t, c));
            const longWait = t - a.joined_at > c.longWaitMs && t - b.joined_at > c.longWaitMs;
            if (gap > win || (a.region !== b.region && !longWait)) continue;
            if (!best || gap < best.gap) best = { b, gap };
          }
          if (best) {
            created.push(createMatch(db, a.player_id, best.b.player_id, config.match.defaultRules, null, a.game_version, mode));
            taken.add(a.player_id); taken.add(best.b.player_id);
          }
        }
      }
    };
    if (config.modes.ranked) ladder('ranked');
    ladder('casual');
    if (taken.size) {
      const del = db.prepare('DELETE FROM queue WHERE player_id = ?');
      for (const id of taken) del.run(id);
    }
    return created;
  });
}

function createMatch(db, a, b, rules, seriesId, gameVersion, mode = 'ranked') {
  const id = 'm_' + crypto.randomBytes(9).toString('base64url');
  // The host creates the private room in-game; alternate who hosts at random.
  const [host, guest] = crypto.randomInt(2) ? [a, b] : [b, a];
  db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, game_version, mode, state, series_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, host, guest, JSON.stringify(rules), gameVersion, mode, seriesId, now());
  return id;
}

// Rating changes as shown: none for casual matches (those move the hidden casual rating only), and none for a
// pilot who hides their rating, except to that pilot.
function deltaView(m, hideA, hideB, viewerId) {
  if (m.rating_delta_a == null) return null;
  return { host: hideA && viewerId !== m.player_a ? null : m.rating_delta_a, guest: hideB && viewerId !== m.player_b ? null : m.rating_delta_b };
}

function matchView(db, m, viewerId) {
  const pa = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_a);
  const pb = db.prepare('SELECT * FROM players WHERE id = ?').get(m.player_b);
  const view = {
    id: m.id, state: m.state, mode: m.mode || 'ranked', rules: json(m.rules, {}), gameVersion: m.game_version, seriesId: m.series_id,
    host: publicPlayer(pa, { self: viewerId === m.player_a }), guest: publicPlayer(pb, { self: viewerId === m.player_b }),
    score: m.score_a == null ? null : { host: m.score_a, guest: m.score_b },
    winner: m.winner, ratingDelta: deltaView(m, !!pa?.hide_rating, !!pb?.hide_rating, viewerId),
    flags: json(m.flags, []), createdAt: m.created_at, verifiedAt: m.verified_at,
  };
  // The room code and the link ids are only revealed to the two participants.
  if (viewerId === m.player_a || viewerId === m.player_b) {
    view.lobbyCode = m.lobby_code;
    view.role = viewerId === m.player_a ? 'host' : 'guest';
    const host = viewerId === m.player_a;
    view.link = { self: (host ? m.link_a : m.link_b) || null, peer: (host ? m.link_b : m.link_a) || null };
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

// The two PCs' link (the mod's relay-only Steam P2P, 2026-11-19): each pilot's mod posts its own SteamID64 for the
// match; each of the two then sees the other's (matchView), nobody else sees either. Valve's relays carry the traffic,
// so neither pilot learns the other's IP address. The host's post opens the match, as the room code does. An id
// can't change once posted (a restart posts the same one), and both pilots on one Steam account are refused.
const STEAM_ID64 = /^7656119\d{10}$/;
function setLink(db, player, matchId, steamId) {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(String(matchId));
  if (!m) throw new HttpError(404, 'match not found');
  const side = m.player_a === player.id ? 'a' : m.player_b === player.id ? 'b' : null;
  if (!side) throw new HttpError(403, 'not a player of this match');
  if (m.state !== 'pending' && m.state !== 'live') throw new HttpError(409, 'match already over');
  if (typeof steamId !== 'string' || !STEAM_ID64.test(steamId)) throw new HttpError(400, 'invalid steam id');
  const mine = side === 'a' ? m.link_a : m.link_b;
  const other = side === 'a' ? m.link_b : m.link_a;
  if (mine === steamId) return getMatch(db, m.id, player.id);
  if (mine) throw new HttpError(409, 'link already set');
  if (other === steamId) throw new HttpError(400, 'both pilots on one Steam account');
  if (side === 'a') {
    db.prepare(`UPDATE matches SET link_a = ?, state = 'live', live_at = COALESCE(live_at, ?) WHERE id = ?`).run(steamId, now(), m.id);
  } else {
    db.prepare('UPDATE matches SET link_b = ? WHERE id = ?').run(steamId, m.id);
  }
  return getMatch(db, m.id, player.id);
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
  // The game's own deathmatch (RVNG runtime 0.4.4): decided by score; its own checks (matchlog.reconcileNativeDm).
  if (repA.format === 'native_dm' || repB.format === 'native_dm') {
    const res = matchlog.reconcileNativeDm(repA, repB, {
      rules: json(m.rules, {}), playerA: m.player_a, playerB: m.player_b, minDurationSec: config.match.minDurationSec,
    });
    // The stats check's in-match pass: each pilot's own tables that load with the match (the online weapon and
    // durability tables), against the clean install's match capture (the baseline's aircraft.match). No capture or
    // no pass (a short match): nothing to compare.
    const baseline = baselineFor(db, m.game_version, { activeOnly: false });
    const matchRef = baseline && isPlainObject(baseline.aircraft) && integrity.validStats(baseline.aircraft.match) ? baseline.aircraft.match : null;
    const statFlags = [];
    for (const [rep, pid] of [[repA, m.player_a], [repB, m.player_b]]) {
      if (!matchRef || !integrity.validStats(rep.stats)) continue;
      for (const f of integrity.compareStats(rep.stats, matchRef)) {
        if (f.severity !== 'info') statFlags.push({ ...f, player: pid, when: 'match' });
      }
    }
    res.flags.push(...statFlags);
    if (res.flags.length) {
      db.prepare("UPDATE matches SET state = 'disputed', score_a = ?, score_b = ?, flags = ? WHERE id = ?")
        .run(res.scoreA, res.scoreB, JSON.stringify(res.flags), m.id);
      // (a changed table in a pilot's OWN log puts that pilot's account under review, as a scan does)
      for (const f of statFlags.filter((x) => x.code === 'aircraft_stat_modified' || x.code === 'stat_row_added')) {
        db.prepare("UPDATE players SET status = 'flagged' WHERE id = ? AND status = 'active'").run(f.player);
      }
      return;
    }
    db.prepare("UPDATE matches SET flags = '[]' WHERE id = ?").run(m.id);
    applyResult(db, m, res.outcome, res.scoreA, res.scoreB, repA, repB);
    return;
  }
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
  if (m.mode === 'casual') return applyCasualResult(db, m, pa, pb, s, scoreA, scoreB);
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

// A verified casual match moves only the hidden casual rating (seeded from the ranked rating the first time a
// pilot plays casual). Ranked rating, record, K/D and events are untouched; the change is kept on the match
// (casual_delta_*) so a void can undo it, and is never shown.
function applyCasualResult(db, m, pa, pb, s, scoreA, scoreB) {
  const side = (p) => ({ rating: p.casual_rating ?? p.rating, games: p.casual_games || 0 });
  const d = eloUpdate(side(pa), side(pb), s);
  const upd = db.prepare('UPDATE players SET casual_rating = COALESCE(casual_rating, rating) + ?, casual_games = casual_games + 1 WHERE id = ?');
  upd.run(d.a, pa.id); upd.run(d.b, pb.id);
  const winner = s === 1 ? pa.id : s === 0 ? pb.id : null;
  db.prepare(`UPDATE matches SET state = 'verified', winner = ?, score_a = ?, score_b = ?, casual_delta_a = ?, casual_delta_b = ?,
    verified_at = ? WHERE id = ?`).run(winner, scoreA, scoreB, d.a, d.b, now(), m.id);
}

// Undo a verified result: rating deltas, record, credited K/D and the series game. peak_rating is not
// recomputed (see docs/SECURITY.md).
function revertResult(db, m) {
  if (m.mode === 'casual') {
    const upd = db.prepare('UPDATE players SET casual_rating = casual_rating - ?, casual_games = MAX(0, casual_games - 1) WHERE id = ?');
    upd.run(m.casual_delta_a || 0, m.player_a); upd.run(m.casual_delta_b || 0, m.player_b);
    return undefined;
  }
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
        rating_delta_b = NULL, casual_delta_a = NULL, casual_delta_b = NULL, kills_a = NULL, deaths_a = NULL, kills_b = NULL,
        deaths_b = NULL, flags = ? WHERE id = ?`)
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
  // Rooms never created within the window are voided. Only the host can open the room, so the lapse is the
  // host's: it is recorded, and repeated lapses mean a queue cooldown (config.dodging). A guest who never joins an
  // opened room cannot be told apart from a host who posted a fake code, so that is not counted.
  tx(db, () => {
    const lapsed = db.prepare("SELECT id, player_a FROM matches WHERE state = 'pending' AND created_at < ?").all(t - c.reportWindowMs);
    const voidIt = db.prepare("UPDATE matches SET state = 'void' WHERE id = ? AND state = 'pending'");
    const record = db.prepare('INSERT OR IGNORE INTO lapses (match_id, player_id, at) VALUES (?, ?, ?)');
    for (const m of lapsed) if (voidIt.run(m.id).changes) record.run(m.id, m.player_a, t);
  });
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

function recentMatches(db, { playerId, state, limit = 50, viewerId } = {}) {
  const where = []; const args = [];
  if (playerId) { where.push('(m.player_a = ? OR m.player_b = ?)'); args.push(playerId, playerId); }
  if (typeof state === 'string' && state) { where.push('m.state = ?'); args.push(state); }
  const rows = db.prepare(`SELECT m.*, pa.name a_name, pb.name b_name, pa.role a_role, pb.role b_role, pa.hide_rating a_hide, pb.hide_rating b_hide
    FROM matches m JOIN players pa ON pa.id = m.player_a JOIN players pb ON pb.id = m.player_b
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT ?`).all(...args, clampInt(limit, 50, 1, 200));
  return rows.map((m) => ({
    id: m.id, state: m.state, mode: m.mode || 'ranked',
    host: { id: m.player_a, name: m.a_name, role: m.a_role || 'player' }, guest: { id: m.player_b, name: m.b_name, role: m.b_role || 'player' },
    score: m.score_a == null ? null : { host: m.score_a, guest: m.score_b }, winner: m.winner,
    ratingDelta: deltaView(m, !!m.a_hide, !!m.b_hide, viewerId),
    seriesId: m.series_id, flags: json(m.flags, []), createdAt: m.created_at,
  }));
}

// ---------- admin: baselines & mods ----------
function putBaseline(db, { gameVersion, manifest, aircraft, active = true } = {}) {
  if (typeof gameVersion !== 'string' || !gameVersion || gameVersion.length > 32 || !manifest || !Array.isArray(manifest.files)) {
    throw new HttpError(400, 'gameVersion (string) and manifest.files required');
  }
  if (aircraft !== undefined && !isPlainObject(aircraft)) throw new HttpError(400, 'aircraft must be an object of stats per aircraft id');
  // (the stats check's tables, taken by the mod on a clean install: rvng baseline puts them here)
  if (isPlainObject(aircraft) && aircraft.format !== undefined && !integrity.validStats(aircraft)) {
    throw new HttpError(400, `aircraft: not a well-formed ${integrity.STATS_FORMAT} stats object`);
  }
  if (isPlainObject(aircraft) && aircraft.match !== undefined && !integrity.validStats(aircraft.match)) {
    throw new HttpError(400, `aircraft.match: not a well-formed ${integrity.STATS_FORMAT} stats object (the match capture)`);
  }
  const on = active === false || active === 0 ? 0 : 1;
  db.prepare(`INSERT INTO baselines (game_version, manifest, aircraft, active, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_version) DO UPDATE SET manifest = excluded.manifest, aircraft = excluded.aircraft, active = excluded.active`)
    .run(gameVersion, JSON.stringify(manifest), JSON.stringify(aircraft || {}), on, now());
  const stats = isPlainObject(aircraft) && aircraft.format === integrity.STATS_FORMAT;
  return { gameVersion, active: !!on, files: manifest.files.length,
    aircraft: stats ? Object.keys(aircraft.planes || {}).length : Object.keys(aircraft || {}).length,
    ...(stats ? { tables: Object.keys(aircraft.groups).length,
      rows: Object.values(aircraft.groups).reduce((n, g) => n + Object.keys(g.entries).length, 0) } : {}) };
}

// The uploaded game builds, newest first: a summary of each (file, plane and stat-table counts), not the lists.
function listBaselines(db) {
  return db.prepare('SELECT game_version, manifest, aircraft, active, created_at FROM baselines ORDER BY created_at DESC, id DESC').all()
    .map((b) => {
      let files = 0; let a = {};
      try { files = (JSON.parse(b.manifest).files || []).length; } catch { /* kept as 0 */ }
      try { a = JSON.parse(b.aircraft) || {}; } catch { /* kept empty */ }
      const stats = isPlainObject(a) && a.format === integrity.STATS_FORMAT && isPlainObject(a.groups);
      return { gameVersion: b.game_version, active: !!b.active, createdAt: b.created_at, files,
        aircraft: stats ? Object.keys(a.planes || {}).length : Object.keys(a).length,
        tables: stats ? Object.keys(a.groups).length : 0,
        rows: stats ? Object.values(a.groups).reduce((n, g) => n + Object.keys((g && g.entries) || {}).length, 0) : 0,
        matchCapture: !!(stats && isPlainObject(a.match)) };
    });
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

// A file belongs to one mod. Refusing an upload names every file of it that another mod pins, and both ways out:
// an older approval of the other mod swept this mod's files in (retire those rows, all in one call, then upload
// again), or this upload holds the other mod's folder (leave it out of this approval).
function pinnedConflict(name, rows) {
  const byPath = new Map(); // each file once, with every build row that pins it
  for (const o of rows) {
    if (!byPath.has(o.path)) byPath.set(o.path, new Map());
    byPath.get(o.path).set(o.id, o);
  }
  const files = [...byPath];
  const ids = [...new Set(rows.map((o) => o.id))].sort((a, b) => a - b);
  const shown = files.slice(0, 10).map(([p, os]) => `${p} by ${[...os.values()].map((o) => `"${o.name}" version "${o.version}" (id ${o.id})`).join(', ')}`)
    .join('; ') + (files.length > 10 ? `; and ${files.length - 10} more` : '');
  return new HttpError(409, `${files.length === 1 ? 'a file is' : `${files.length} files are`} already pinned by another mod: ${shown}. `
    + `A file belongs to one mod. If these are part of "${name}" (an older approval swept them into the other build), retire them there `
    + `in one call, POST /api/admin/mods/retire {"ids":[${ids.join(',')}]}, then upload this again right away (pilots who scan in between `
    + 'are told to update, never flagged). If they belong to the other mod, leave its folder out of this approval: add it to rvng approve --exclude');
}
const PINNED_SQL = `SELECT id, name, version, path FROM approved_mods WHERE path = ? AND name != ? AND category != 'retired' ORDER BY id`;

// The checks on one file entry, made for the whole upload before anything is looked up or written. Returns the
// values as stored.
function checkMod(m) {
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
  return { name, p, size, sha: hash.toLowerCase(), category, version };
}

function addOneMod(db, { name, p, size, sha, category, version }) {
  // A file belongs to one mod. A loader folder approved with another mod inside it would make the loader's
  // build require that mod's files too, and one of the two could then never be updated. (addApprovedMods checks
  // the whole upload first; this catches two names for one path within an upload.)
  const others = db.prepare(PINNED_SQL).all(p, name);
  if (others.length) throw pinnedConflict(name, others);
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

// Body is one mod file, or { mods: [...], roots: [...] } from `rvng approve`: every file of one build under the
// approved files and folders (roots). Such an upload is the whole build there: files of that build under the
// roots that it no longer lists are retired (still known, so their pilots are told to update, never flagged).
// Files of the build outside the roots are untouched, so a build can be approved in several parts.
function addApprovedMods(db, body = {}) {
  const list = Array.isArray(body.mods) ? body.mods : [body];
  if (!list.length || list.length > 5000) throw new HttpError(400, 'mods must hold 1-5000 entries');
  let roots = null;
  if (body.roots !== undefined) {
    if (!Array.isArray(body.mods) || !Array.isArray(body.roots) || !body.roots.length || body.roots.length > 64
      || body.roots.some((r) => typeof r !== 'string' || r.length > 1024)) throw new HttpError(400, 'roots must list the approved files and folders');
    roots = body.roots.map(canonPath);
    if (roots.some((r) => !r || r.split('/').some((seg) => seg === '.' || seg === '..'))) throw new HttpError(400, 'roots must be paths under the game root');
  }
  const under = (p) => roots.some((r) => p === r || p.startsWith(r + '/'));
  // Every entry is checked before the conflict check: a refusal that says to retire another build's rows must
  // only come for an upload that will then go in.
  const mods = list.map(checkMod);
  if (roots && mods.some((c) => !under(c.p))) throw new HttpError(400, 'every file must be an object whose path is under one of the roots');
  const owner = new Map();
  for (const c of mods) {
    if (owner.has(c.p) && owner.get(c.p) !== c.name) throw new HttpError(400, `${c.p} is listed under two mods in this upload: "${owner.get(c.p)}" and "${c.name}"`);
    owner.set(c.p, c.name);
  }
  tx(db, () => {
    const pinned = db.prepare(PINNED_SQL);
    const clash = []; const seen = new Set(); let who = null;
    for (const c of mods) {
      const k = JSON.stringify([c.name, c.p]);
      if (seen.has(k)) continue;
      seen.add(k);
      const rows = pinned.all(c.p, c.name);
      if (rows.length) { clash.push(...rows); who ??= c.name; }
    }
    if (clash.length) throw pinnedConflict(who, clash);
    if (roots) {
      const builds = new Map();
      for (const c of mods) {
        const k = JSON.stringify([c.name, c.version]);
        if (!builds.has(k)) builds.set(k, new Set());
        builds.get(k).add(c.p);
      }
      const rows = db.prepare("SELECT id, path FROM approved_mods WHERE name = ? AND version = ? AND category != 'retired'");
      const retire = db.prepare("UPDATE approved_mods SET category = 'retired' WHERE id = ?");
      for (const [k, listed] of builds) {
        const [name, version] = JSON.parse(k);
        for (const r of rows.all(name, version)) if (under(r.path) && !listed.has(r.path)) retire.run(r.id);
      }
    }
    for (const c of mods) addOneMod(db, c);
  });
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
// the build shares with another build stay approved through that build's rows. `ids` retires those rows (the
// files an older approval swept into another mod's build, as the upload's 409 lists them), all or none.
function retireMods(db, { name, version = '', ids } = {}) {
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100000 || ids.some((i) => !Number.isSafeInteger(i) || i < 1)) {
      throw new HttpError(400, 'ids must list 1-100000 approved file ids');
    }
    return tx(db, () => {
      const st = db.prepare("UPDATE approved_mods SET category = 'retired' WHERE id = ?");
      const missing = ids.filter((i) => !st.run(i).changes);
      if (missing.length) throw new HttpError(404, `approved files not found: ${missing.slice(0, 20).join(', ')}`);
      return listApprovedMods(db);
    });
  }
  if (typeof name !== 'string' || !name || typeof version !== 'string') throw new HttpError(400, 'name (and optional version) required');
  const r = db.prepare("UPDATE approved_mods SET category = 'retired' WHERE name = ? AND version = ?").run(name, version);
  if (!r.changes) throw new HttpError(404, 'no approved files for that name and version');
  return listApprovedMods(db);
}

// 'active' lets a pending (invite-only) sign-up in; 'pending' takes an account back out of play.
function setPlayerStatus(db, id, status) {
  if (!['active', 'pending', 'flagged', 'banned'].includes(status)) throw new HttpError(400, 'status must be active, pending, flagged or banned');
  if (!db.prepare('UPDATE players SET status = ? WHERE id = ?').run(status, id).changes) throw new HttpError(404, 'player not found');
  if (status !== 'active') db.prepare('DELETE FROM queue WHERE player_id = ?').run(id);
}

// ---------- player reports ----------
// A pilot reports another pilot to the admins. Reports never change a rating, record or status by themselves.
// Limits: no self-reports, the reported pilot must exist, a match must be one the two played against each other,
// one open report per reporter, reported pilot and match, and config.reports.maxPerWindow per reporter.
function fileReport(db, player, body = {}) {
  requireLetIn(player);
  const c = config.reports;
  if (!isPlainObject(body)) throw new HttpError(400, 'report must be an object');
  const { playerId, matchId, reason } = body;
  if (!Number.isSafeInteger(playerId) || playerId < 1) throw new HttpError(400, 'playerId must be the id of the pilot you report');
  if (playerId === player.id) throw new HttpError(400, 'you cannot report yourself');
  if (typeof reason !== 'string' || !c.reasons.includes(reason)) throw new HttpError(400, `reason must be one of: ${c.reasons.join(', ')}`);
  const raw = body.details ?? '';
  // Multi-line text is fine here (tabs and line breaks), other control characters are not.
  const details = typeof raw === 'string' ? raw.replace(/\r\n?/g, '\n') : null;
  if (details == null || details.length > c.maxDetails || UNSAFE_TEXT.test(details.replace(/[\n\t]/g, ' '))) {
    throw new HttpError(400, `details must be plain text of at most ${c.maxDetails} characters`);
  }
  if (matchId != null && (typeof matchId !== 'string' || matchId.length > 64)) throw new HttpError(400, 'matchId must be a match id');
  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(playerId)) throw new HttpError(404, 'player not found');
    if (matchId != null) {
      const m = db.prepare('SELECT player_a, player_b FROM matches WHERE id = ?').get(matchId);
      if (!m) throw new HttpError(404, 'match not found');
      const pair = [m.player_a, m.player_b];
      if (!pair.includes(player.id) || !pair.includes(playerId)) throw new HttpError(403, 'you can only attach a match you played against this pilot');
    }
    const t = now();
    const recent = db.prepare('SELECT COUNT(*) c, MIN(created_at) first FROM player_reports WHERE reporter_id = ? AND created_at > ?').get(player.id, t - c.windowMs);
    if (recent.c >= c.maxPerWindow) {
      const per = c.windowMs === 3600000 ? 'hour' : `${Math.round(c.windowMs / 60000)} min`;
      throw new HttpError(429, `too many reports: at most ${c.maxPerWindow} per ${per}; try again in ${Math.ceil((recent.first + c.windowMs - t) / 60000)} min`);
    }
    if (db.prepare(`SELECT 1 FROM player_reports WHERE reporter_id = ? AND reported_id = ? AND COALESCE(match_id, '') = ? AND state = 'open'`)
      .get(player.id, playerId, matchId ?? '')) {
      throw new HttpError(409, matchId != null ? 'you already have an open report on this pilot for this match' : 'you already have an open report on this pilot');
    }
    const r = db.prepare('INSERT INTO player_reports (reporter_id, reported_id, match_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(player.id, playerId, matchId ?? null, reason, details.trim(), t);
    return { id: Number(r.lastInsertRowid), state: 'open', reportedId: playerId, matchId: matchId ?? null, reason, createdAt: t };
  });
}

const REPORT_STATES = ['open', 'resolved', 'dismissed'];
const reportView = (r) => ({
  id: r.id, state: r.state, reason: r.reason, details: r.details, matchId: r.match_id, resolution: r.resolution,
  reporter: { id: r.reporter_id, name: r.reporter_name, status: r.reporter_status },
  reported: { id: r.reported_id, name: r.reported_name, status: r.reported_status, openReports: r.reported_open },
  createdAt: r.created_at, closedAt: r.closed_at,
});
const REPORT_SQL = `SELECT r.*, a.name reporter_name, a.status reporter_status, b.name reported_name, b.status reported_status,
    (SELECT COUNT(*) FROM player_reports o WHERE o.reported_id = r.reported_id AND o.state = 'open') reported_open
  FROM player_reports r JOIN players a ON a.id = r.reporter_id JOIN players b ON b.id = r.reported_id`;

// Admin: reports by state (open by default, oldest first so nothing waits forever; closed ones newest first).
function listReports(db, { state = 'open', limit = 100 } = {}) {
  const st = typeof state === 'string' && state ? state : 'open';
  if (st !== 'all' && !REPORT_STATES.includes(st)) throw new HttpError(400, `state must be one of: ${[...REPORT_STATES, 'all'].join(', ')}`);
  const where = st === 'all' ? '' : 'WHERE r.state = ?';
  const order = st === 'open' ? 'r.id ASC' : 'r.id DESC';
  return db.prepare(`${REPORT_SQL} ${where} ORDER BY ${order} LIMIT ?`).all(...(st === 'all' ? [] : [st]), clampInt(limit, 100, 1, 500)).map(reportView);
}

// Admin: close a report as resolved (acted on) or dismissed, with an optional note. Any action against the pilot
// (status, match void) is taken separately: closing a report changes nothing else.
function closeReport(db, id, { state, note = '' } = {}) {
  if (!['resolved', 'dismissed'].includes(state)) throw new HttpError(400, 'state must be resolved or dismissed');
  if (typeof note !== 'string' || note.length > config.reports.maxDetails || UNSAFE_TEXT.test(note)) {
    throw new HttpError(400, `note must be one line of plain text, at most ${config.reports.maxDetails} characters`);
  }
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM player_reports WHERE id = ?').get(id);
    if (!r) throw new HttpError(404, 'report not found');
    if (r.state !== 'open') throw new HttpError(409, `report is already ${r.state}`);
    db.prepare('UPDATE player_reports SET state = ?, resolution = ?, closed_at = ? WHERE id = ?').run(state, note.trim(), now(), id);
    return reportView(db.prepare(`${REPORT_SQL} WHERE r.id = ?`).get(id));
  });
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
    // Which queues this server runs (the ranked ladder can be switched off with RVNG_RANKED=0).
    queues: { ranked: !!config.modes.ranked, casual: true },
  };
}

// Admin: a match with both pilots' logs as they were sent (the admin page's dispute view: what each log said).
function adminMatch(db, id) {
  const m = getMatch(db, id);
  const reports = db.prepare('SELECT player_id, report, received_at FROM match_reports WHERE match_id = ? ORDER BY received_at')
    .all(String(id)).map((r) => ({ side: r.player_id === m.host.id ? 'host' : 'guest', receivedAt: r.received_at, report: json(r.report, null) }));
  return { ...m, reports };
}

module.exports = {
  registerPlayer, leaderboard, playerProfile, publicPlayer, updateSettings, setPlayerCard, adminPlayers,
  fileReport, listReports, closeReport, lapseCooldown, PENDING_MESSAGE,
  submitIntegrity, joinQueue, leaveQueue, queueStatus, runMatchmaker,
  getMatch, setLobby, setLink, submitReport, resolveDispute, sweepStaleMatches, recentMatches,
  putBaseline, listBaselines, setBaselineActive, addApprovedMods, listApprovedMods, removeApprovedMod, retireMods, capFindings,
  setPlayerStatus, integrityLog, stats, adminMatch,
};
