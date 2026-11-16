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
  category TEXT NOT NULL DEFAULT 'cosmetic', -- required | cosmetic
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
  joined_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id            TEXT PRIMARY KEY,
  player_a      INTEGER NOT NULL REFERENCES players(id), -- host
  player_b      INTEGER NOT NULL REFERENCES players(id),
  rules         TEXT NOT NULL,
  lobby_code    TEXT,
  state         TEXT NOT NULL,  -- pending | live | awaiting_reports | verified | disputed | void
  winner        INTEGER REFERENCES players(id),
  score_a       INTEGER,
  score_b       INTEGER,
  rating_delta_a REAL,
  rating_delta_b REAL,
  series_id     INTEGER REFERENCES series(id),
  flags         TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_matches_state ON matches(state);
`;

function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
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
