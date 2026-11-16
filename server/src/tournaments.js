'use strict';
/** Single-elimination knockout brackets, seeded by rating, ending in a 1v1 championship final. */
const { tx } = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Standard bracket order so seeds 1 and 2 can only meet in the final. n must be a power of two.
function seedOrder(n) {
  let order = [1, 2];
  while (order.length < n) {
    const len = order.length * 2;
    order = order.flatMap((s) => [s, len + 1 - s]);
  }
  return order;
}

const isPow2 = (n) => n >= 2 && (n & (n - 1)) === 0;
const rounds = (size) => Math.log2(size);

function create(db, { name, size, bestOf = 3, finalBestOf = 5, rules }) {
  if (!name || typeof name !== 'string') throw new HttpError(400, 'name required');
  if (!isPow2(size) || size > 256) throw new HttpError(400, 'size must be a power of two between 2 and 256');
  for (const b of [bestOf, finalBestOf]) if (!Number.isInteger(b) || b < 1 || b % 2 === 0) throw new HttpError(400, 'bestOf must be odd');
  const r = db.prepare(`INSERT INTO tournaments (name, state, size, best_of, final_best_of, rules, created_at)
    VALUES (?, 'registration', ?, ?, ?, ?, ?)`).run(name, size, bestOf, finalBestOf, JSON.stringify(rules || {}), Date.now());
  return get(db, Number(r.lastInsertRowid));
}

function register(db, tournamentId, playerId) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!t) throw new HttpError(404, 'tournament not found');
  if (t.state !== 'registration') throw new HttpError(409, 'registration closed');
  const count = db.prepare('SELECT COUNT(*) c FROM tournament_entrants WHERE tournament_id = ?').get(tournamentId).c;
  if (count >= t.size) throw new HttpError(409, 'tournament full');
  db.prepare('INSERT OR IGNORE INTO tournament_entrants (tournament_id, player_id) VALUES (?, ?)').run(tournamentId, playerId);
}

function start(db, tournamentId) {
  return tx(db, () => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
    if (!t) throw new HttpError(404, 'tournament not found');
    if (t.state !== 'registration') throw new HttpError(409, 'already started');
    const entrants = db.prepare(`SELECT p.id, p.rating FROM tournament_entrants e JOIN players p ON p.id = e.player_id
      WHERE e.tournament_id = ? AND p.status != 'banned' ORDER BY p.rating DESC, p.id ASC`).all(tournamentId);
    if (entrants.length < 2) throw new HttpError(409, 'need at least 2 entrants');

    const setSeed = db.prepare('UPDATE tournament_entrants SET seed = ? WHERE tournament_id = ? AND player_id = ?');
    entrants.forEach((p, i) => setSeed.run(i + 1, tournamentId, p.id));

    const total = rounds(t.size);
    const ins = db.prepare(`INSERT INTO series (tournament_id, round, slot, player_a, player_b, best_of)
      VALUES (?, ?, ?, ?, ?, ?)`);
    for (let r = 1; r <= total; r++) {
      const slots = t.size >> r;
      for (let s = 0; s < slots; s++) {
        let a = null; let b = null;
        if (r === 1) {
          const order = seedOrder(t.size);
          a = entrants[order[2 * s] - 1]?.id ?? null;
          b = entrants[order[2 * s + 1] - 1]?.id ?? null;
        }
        ins.run(tournamentId, r, s, a, b, r === total ? t.final_best_of : t.best_of);
      }
    }
    db.prepare("UPDATE tournaments SET state = 'running' WHERE id = ?").run(tournamentId);

    // Byes: a first-round slot with only one player advances automatically.
    const firstRound = db.prepare('SELECT * FROM series WHERE tournament_id = ? AND round = 1').all(tournamentId);
    for (const s of firstRound) {
      if (s.player_a && !s.player_b) finishSeries(db, t, s, s.player_a);
      else if (!s.player_a && s.player_b) finishSeries(db, t, s, s.player_b);
    }
    return get(db, tournamentId);
  });
}

function finishSeries(db, t, s, winnerId) {
  db.prepare('UPDATE series SET winner = ? WHERE id = ?').run(winnerId, s.id);
  const total = rounds(t.size);
  if (s.round === total) {
    db.prepare("UPDATE tournaments SET state = 'complete', champion = ? WHERE id = ?").run(winnerId, t.id);
    return;
  }
  const col = s.slot % 2 === 0 ? 'player_a' : 'player_b';
  db.prepare(`UPDATE series SET ${col} = ? WHERE tournament_id = ? AND round = ? AND slot = ?`)
    .run(winnerId, t.id, s.round + 1, Math.floor(s.slot / 2));
}

// Called (inside a transaction) when a match belonging to a series is verified.
function recordSeriesResult(db, seriesId, winnerId) {
  const s = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!s || s.winner || !winnerId) return;
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(s.tournament_id);
  const col = winnerId === s.player_a ? 'wins_a' : winnerId === s.player_b ? 'wins_b' : null;
  if (!col) return;
  db.prepare(`UPDATE series SET ${col} = ${col} + 1 WHERE id = ?`).run(s.id);
  const updated = db.prepare('SELECT * FROM series WHERE id = ?').get(s.id);
  const need = Math.ceil(updated.best_of / 2);
  if (updated.wins_a >= need) finishSeries(db, t, updated, updated.player_a);
  else if (updated.wins_b >= need) finishSeries(db, t, updated, updated.player_b);
}

// The open series (both players known, no winner) a player is currently due to play.
function pendingSeriesFor(db, playerId) {
  return db.prepare(`SELECT s.* FROM series s JOIN tournaments t ON t.id = s.tournament_id
    WHERE t.state = 'running' AND s.winner IS NULL AND s.player_a IS NOT NULL AND s.player_b IS NOT NULL
      AND (s.player_a = ? OR s.player_b = ?) ORDER BY s.round ASC LIMIT 1`).get(playerId, playerId);
}

function get(db, id) {
  const t = db.prepare(`SELECT t.*, p.name champion_name FROM tournaments t LEFT JOIN players p ON p.id = t.champion WHERE t.id = ?`).get(id);
  if (!t) return null;
  const entrants = db.prepare(`SELECT p.id, p.name, p.rating, e.seed FROM tournament_entrants e JOIN players p ON p.id = e.player_id
    WHERE e.tournament_id = ? ORDER BY COALESCE(e.seed, 9999), p.rating DESC`).all(id);
  const series = db.prepare(`SELECT s.*, pa.name a_name, pb.name b_name FROM series s
    LEFT JOIN players pa ON pa.id = s.player_a LEFT JOIN players pb ON pb.id = s.player_b
    WHERE s.tournament_id = ? ORDER BY s.round, s.slot`).all(id);
  return { ...t, rules: JSON.parse(t.rules), entrants, rounds: rounds(t.size), series };
}

function list(db) {
  return db.prepare(`SELECT t.id, t.name, t.state, t.size, t.created_at, p.name champion_name,
    (SELECT COUNT(*) FROM tournament_entrants e WHERE e.tournament_id = t.id) entrants
    FROM tournaments t LEFT JOIN players p ON p.id = t.champion ORDER BY t.id DESC`).all();
}

module.exports = { HttpError, seedOrder, create, register, start, recordSeriesResult, pendingSeriesFor, get, list };
