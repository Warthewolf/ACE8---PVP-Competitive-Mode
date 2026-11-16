'use strict';
const { DatabaseSync } = require('node:sqlite');
const { canonPath } = require('./integrity');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  platform_id   TEXT UNIQUE,                 -- e.g. SteamID64 reported by the mod
  api_key_hash  TEXT NOT NULL,               -- sha256 of the key (for lookup)
  api_secret    TEXT NOT NULL,               -- HMAC secret used to verify signed requests
  rating        REAL NOT NULL,
  peak_rating   REAL NOT NULL,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  kills         INTEGER NOT NULL DEFAULT 0,
  deaths        INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active', -- active | flagged | banned
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
  player_id  INTEGER NOT NULL,
  nonce      TEXT NOT NULL,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (player_id, nonce)
);

-- Clean-install manifest per game build: every tracked file with size + sha256.
CREATE TABLE IF NOT EXISTS baselines (
  id           INTEGER PRIMARY KEY,
  game_version TEXT NOT NULL UNIQUE,
  manifest     TEXT NOT NULL,   -- JSON: { files: [{path,size,sha256}] }
  aircraft     TEXT NOT NULL,   -- JSON: { "<aircraftId>": { maxSpeed, turnRate, hp, ... } }
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- Mods that are allowed in competitive play (pinned by hash + size). One row per file of each build, so a
-- file that two builds share is listed in both and each build stays complete.
CREATE TABLE IF NOT EXISTS approved_mods (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  path     TEXT NOT NULL,      -- path relative to game root
  size     INTEGER NOT NULL,
  sha256   TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'cosmetic', -- required | cosmetic | retired (an old build: rejected, never flagged)
  version  TEXT NOT NULL DEFAULT '',         -- build of the mod; any one complete build of a required mod passes
  UNIQUE (name, version, path)
);

CREATE TABLE IF NOT EXISTS integrity_reports (
  id           INTEGER PRIMARY KEY,
  player_id    INTEGER NOT NULL REFERENCES players(id),
  game_version TEXT NOT NULL,
  verdict      TEXT NOT NULL,  -- clean | flagged | rejected
  findings     TEXT NOT NULL,  -- JSON array
  mods         TEXT NOT NULL,  -- JSON array of detected mods
  manifest_hash TEXT NOT NULL,
  token        TEXT UNIQUE,
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
  player_id     INTEGER PRIMARY KEY REFERENCES players(id),
  rating        REAL NOT NULL,
  region        TEXT NOT NULL,
  integrity_id  INTEGER NOT NULL REFERENCES integrity_reports(id),
  game_version  TEXT NOT NULL DEFAULT '',   -- build the player scanned clean on; only equal builds are paired
  joined_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id            TEXT PRIMARY KEY,
  player_a      INTEGER NOT NULL REFERENCES players(id), -- host
  player_b      INTEGER NOT NULL REFERENCES players(id),
  rules         TEXT NOT NULL,
  game_version  TEXT NOT NULL DEFAULT '',   -- from both players' clean scans, never from the match logs
  lobby_code    TEXT,
  state         TEXT NOT NULL,  -- pending | live | awaiting_reports | verified | disputed | void
  winner        INTEGER REFERENCES players(id),
  score_a       INTEGER,
  score_b       INTEGER,
  rating_delta_a REAL,
  rating_delta_b REAL,
  series_id     INTEGER REFERENCES series(id),
  flags         TEXT NOT NULL DEFAULT '[]',
  -- kills/deaths credited to each player when the result was applied (so a void can undo them)
  kills_a       INTEGER,
  deaths_a      INTEGER,
  kills_b       INTEGER,
  deaths_b      INTEGER,
  created_at    INTEGER NOT NULL,
  live_at       INTEGER,                  -- when the host posted the room code
  swept_at      INTEGER,                  -- when the background sweep closed it (late logs may still settle it)
  verified_at   INTEGER
);

CREATE TABLE IF NOT EXISTS match_reports (
  match_id    TEXT NOT NULL REFERENCES matches(id),
  player_id   INTEGER NOT NULL REFERENCES players(id),
  report      TEXT NOT NULL,  -- full JSON log as submitted
  received_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  state       TEXT NOT NULL,     -- registration | running | complete
  size        INTEGER NOT NULL,  -- bracket size (power of two)
  best_of     INTEGER NOT NULL,
  final_best_of INTEGER NOT NULL,
  rules       TEXT NOT NULL,
  champion    INTEGER REFERENCES players(id),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tournament_entrants (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  player_id     INTEGER NOT NULL REFERENCES players(id),
  seed          INTEGER,
  PRIMARY KEY (tournament_id, player_id)
);

-- One row per bracket slot. round 1 = first round; the final is round log2(size).
CREATE TABLE IF NOT EXISTS series (
  id            INTEGER PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
  round         INTEGER NOT NULL,
  slot          INTEGER NOT NULL,
  player_a      INTEGER REFERENCES players(id),
  player_b      INTEGER REFERENCES players(id),
  wins_a        INTEGER NOT NULL DEFAULT 0,
  wins_b        INTEGER NOT NULL DEFAULT 0,
  best_of       INTEGER NOT NULL,
  winner        INTEGER REFERENCES players(id),
  UNIQUE (tournament_id, round, slot)
);

CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_key ON players(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_nonces_seen ON nonces(seen_at);
CREATE INDEX IF NOT EXISTS idx_matches_state ON matches(state);
CREATE INDEX IF NOT EXISTS idx_matches_series ON matches(series_id);
CREATE INDEX IF NOT EXISTS idx_integrity_player ON integrity_reports(player_id, id);
`;

// Columns added after the first release. CREATE TABLE IF NOT EXISTS does not add them to older databases.
const ADDED_COLUMNS = [
  ['players', 'draws', 'INTEGER NOT NULL DEFAULT 0'],
  ['queue', 'game_version', "TEXT NOT NULL DEFAULT ''"],
  ['matches', 'game_version', "TEXT NOT NULL DEFAULT ''"],
  ['matches', 'kills_a', 'INTEGER'], ['matches', 'deaths_a', 'INTEGER'],
  ['matches', 'kills_b', 'INTEGER'], ['matches', 'deaths_b', 'INTEGER'],
  ['matches', 'live_at', 'INTEGER'],
  ['matches', 'swept_at', 'INTEGER'],
  ['approved_mods', 'version', "TEXT NOT NULL DEFAULT ''"],
];

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function migrate(db) {
  for (const [table, col, def] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  rekeyApprovedMods(db);
  // A pseudo-build "<version>#<id>" (an earlier file kept known) is never required. It is always one row, named
  // after its own row id. One release stored some as required, which let a one-file install pass. Uploads can no
  // longer create "#" versions, but releases before that accepted them: a real build such as "1.0#2" or "1.0#5"
  // has several rows (even when one of them is row 5) and is left alone.
  db.exec(`UPDATE approved_mods SET category = 'retired' WHERE category = 'required'
    AND substr(version, -length('#' || id)) = '#' || id
    AND NOT EXISTS (SELECT 1 FROM approved_mods o WHERE o.name = approved_mods.name AND o.version = approved_mods.version AND o.id != approved_mods.id)`);
  // The backfills below only touch rows that still lack (or contradict) the value, so they also repair
  // databases that an earlier release had already upgraded.
  // Queue entries keep their build: it is the build of the scan they joined with.
  db.exec(`UPDATE queue SET game_version = COALESCE((SELECT game_version FROM integrity_reports r WHERE r.id = queue.integrity_id), '')
    WHERE game_version = ''`);
  // Matches still being played: the build both pilots last scanned clean on before the match was created.
  const lastClean = db.prepare(`SELECT game_version FROM integrity_reports WHERE player_id = ? AND verdict = 'clean'
    AND created_at <= ? ORDER BY id DESC LIMIT 1`);
  const setVersion = db.prepare('UPDATE matches SET game_version = ? WHERE id = ?');
  for (const m of db.prepare("SELECT * FROM matches WHERE state IN ('pending', 'live', 'awaiting_reports') AND game_version = ''").all()) {
    const a = lastClean.get(m.player_a, m.created_at); const b = lastClean.get(m.player_b, m.created_at);
    if (a && b && a.game_version === b.game_version) setVersion.run(a.game_version, m.id);
  }
  // Verified matches: the kills/deaths that were credited, so voiding one later undoes exactly those. Releases
  // before these columns credited the logs only when the match verified by itself (no flags, both logs);
  // a match an admin settled was credited from the admin's scores, even when both logs were stored.
  const rep = db.prepare('SELECT report FROM match_reports WHERE match_id = ? AND player_id = ?');
  const setKd = db.prepare('UPDATE matches SET kills_a = ?, deaths_a = ?, kills_b = ?, deaths_b = ? WHERE id = ?');
  const int = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
  for (const m of db.prepare("SELECT * FROM matches WHERE state = 'verified' AND kills_a IS NULL").all()) {
    const flags = parse(m.flags);
    const ra = parse(rep.get(m.id, m.player_a)?.report); const rb = parse(rep.get(m.id, m.player_b)?.report);
    if (Array.isArray(flags) && !flags.length && ra?.self && rb?.self) setKd.run(int(ra.self.kills), int(ra.self.deaths), int(rb.self.kills), int(rb.self.deaths), m.id);
    else setKd.run(int(m.score_a), int(m.score_b), int(m.score_b), int(m.score_a), m.id);
  }
  // A verified match that carries a dispute flag was settled by an admin, and every release credited such a
  // settle from the scores. One earlier upgrade filled these from the logs instead: put the scores back.
  for (const m of db.prepare("SELECT * FROM matches WHERE state = 'verified' AND flags != '[]'").all()) {
    const flags = parse(m.flags);
    if (!Array.isArray(flags) || !flags.some((f) => !['no_reports', 'missing_opponent_report'].includes(f?.code))) continue;
    const want = [int(m.score_a), int(m.score_b), int(m.score_b), int(m.score_a)];
    if ([m.kills_a, m.deaths_a, m.kills_b, m.deaths_b].some((v, i) => v !== want[i])) setKd.run(...want, m.id);
  }
  // Career totals: exactly the sum of the pilot's verified matches, now that every verified match records what
  // it credited. This counts draws from the first release, which had no draws column, and repairs totals that
  // voids on earlier releases took too much from (they undid scores or logs instead of what was credited).
  // Ratings are not recomputed (see docs/SECURITY.md).
  // The matches are read inside the same write transaction as the totals: a server still running on this
  // database (a second start, an overlapping deploy) cannot verify a match in between and lose its credit.
  const setTotals = db.prepare('UPDATE players SET kills = ?, deaths = ?, wins = ?, losses = ?, draws = ? WHERE id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
    const totals = new Map();
    const add = (id, k, d, w, l, dr) => {
      const t = totals.get(id) || { kills: 0, deaths: 0, wins: 0, losses: 0, draws: 0 };
      t.kills += k; t.deaths += d; t.wins += w; t.losses += l; t.draws += dr;
      totals.set(id, t);
    };
    for (const m of db.prepare("SELECT player_a, player_b, winner, kills_a, deaths_a, kills_b, deaths_b FROM matches WHERE state = 'verified'").all()) {
      const draw = m.winner == null ? 1 : 0;
      add(m.player_a, m.kills_a ?? 0, m.deaths_a ?? 0, m.winner === m.player_a ? 1 : 0, m.winner === m.player_b ? 1 : 0, draw);
      add(m.player_b, m.kills_b ?? 0, m.deaths_b ?? 0, m.winner === m.player_b ? 1 : 0, m.winner === m.player_a ? 1 : 0, draw);
    }
    for (const p of db.prepare('SELECT id, kills, deaths, wins, losses, draws FROM players').all()) {
      const t = totals.get(p.id) || { kills: 0, deaths: 0, wins: 0, losses: 0, draws: 0 };
      if (['kills', 'deaths', 'wins', 'losses', 'draws'].some((k) => p[k] !== t[k])) setTotals.run(t.kills, t.deaths, t.wins, t.losses, t.draws, p.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Releases before per-build rows keyed approved files by (path, sha256), so a file shared by two builds was
// moved to whichever build was uploaded last, and stored paths kept whatever spelling the admin typed. Rebuild
// the table with one row per (name, version, path) and paths in the form the scan compares.
// Rows that land on the same (name, version, path) slot: the slot goes to the row that counts most (required,
// then cosmetic, then retired; then the newest). Each other row keeps its file known as a pseudo-build
// "<version>#<id>", and a required one is retired there, so a pseudo-build is never a required build.
// Builds that had already lost shared files must be uploaded again (see README).
function rekeyApprovedMods(db) {
  const keys = db.prepare("PRAGMA index_list('approved_mods')").all().filter((i) => i.unique)
    .map((i) => db.prepare(`PRAGMA index_info('${i.name.replace(/'/g, "''")}')`).all().map((c) => c.name).join(','));
  const rows = db.prepare('SELECT * FROM approved_mods').all();
  if (keys.includes('name,version,path') && rows.every((r) => canonPath(r.path) === r.path)) return;
  const rank = { required: 2, cosmetic: 1, retired: 0 };
  rows.sort((a, b) => (rank[b.category] ?? 0) - (rank[a.category] ?? 0) || b.id - a.id);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DROP TABLE approved_mods');
    db.exec(SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS approved_mods'), SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS integrity_reports')));
    const ins = db.prepare('INSERT OR IGNORE INTO approved_mods (id, name, path, size, sha256, category, version) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) {
      const p = canonPath(r.path);
      if (!ins.run(r.id, r.name, p, r.size, r.sha256, r.category, r.version).changes) {
        ins.run(r.id, r.name, p, r.size, r.sha256, r.category === 'required' ? 'retired' : r.category, `${r.version}#${r.id}`);
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function openDb(path) {
  const db = new DatabaseSync(path);
  // Tables first (without the indexes that may reference new columns), then columns, then indexes.
  const [tables, indexes] = SCHEMA.split('CREATE INDEX IF NOT EXISTS idx_players_rating');
  db.exec(tables);
  migrate(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_players_rating' + indexes);
  return db;
}

// Run fn inside a transaction; rolls back on throw.
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx };
