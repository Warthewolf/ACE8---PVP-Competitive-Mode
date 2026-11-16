'use strict';
const { DatabaseSync } = require('node:sqlite');

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

-- Mods that are allowed in competitive play (pinned by hash + size).
CREATE TABLE IF NOT EXISTS approved_mods (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  path     TEXT NOT NULL,      -- path relative to game root
  size     INTEGER NOT NULL,
  sha256   TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'cosmetic', -- required | cosmetic | retired (an old build: rejected, never flagged)
  version  TEXT NOT NULL DEFAULT '',         -- build of the mod; any one complete build of a required mod passes
  UNIQUE (path, sha256)
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
  ['approved_mods', 'version', "TEXT NOT NULL DEFAULT ''"],
];

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function migrate(db) {
  const added = new Set();
  for (const [table, col, def] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); added.add(`${table}.${col}`); }
  }
  // Queue entries keep their build: it is the build of the scan they joined with.
  if (added.has('queue.game_version')) {
    db.exec(`UPDATE queue SET game_version = COALESCE((SELECT game_version FROM integrity_reports r WHERE r.id = queue.integrity_id), '')`);
  }
  // Matches still being played: the build both pilots last scanned clean on before the match was created.
  if (added.has('matches.game_version')) {
    const lastClean = db.prepare(`SELECT game_version FROM integrity_reports WHERE player_id = ? AND verdict = 'clean'
      AND created_at <= ? ORDER BY id DESC LIMIT 1`);
    const set = db.prepare('UPDATE matches SET game_version = ? WHERE id = ?');
    for (const m of db.prepare("SELECT * FROM matches WHERE state IN ('pending', 'live', 'awaiting_reports')").all()) {
      const a = lastClean.get(m.player_a, m.created_at); const b = lastClean.get(m.player_b, m.created_at);
      if (a && b && a.game_version === b.game_version) set.run(a.game_version, m.id);
    }
  }
  // Verified matches: the kills/deaths that were credited, so voiding one later undoes exactly those.
  if (added.has('matches.kills_a')) {
    const rep = db.prepare('SELECT report FROM match_reports WHERE match_id = ? AND player_id = ?');
    const set = db.prepare('UPDATE matches SET kills_a = ?, deaths_a = ?, kills_b = ?, deaths_b = ? WHERE id = ?');
    const int = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
    for (const m of db.prepare("SELECT * FROM matches WHERE state = 'verified'").all()) {
      const ra = parse(rep.get(m.id, m.player_a)?.report); const rb = parse(rep.get(m.id, m.player_b)?.report);
      if (ra?.self && rb?.self) set.run(int(ra.self.kills), int(ra.self.deaths), int(rb.self.kills), int(rb.self.deaths), m.id);
      else set.run(int(m.score_a), int(m.score_b), int(m.score_b), int(m.score_a), m.id); // settled by an admin
    }
  }
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
