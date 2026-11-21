'use strict';

// Express 'trust proxy' from an env string: a hop count or a comma-separated list of proxy addresses/subnets
// (e.g. "loopback, 10.0.0.0/8"). Express would read "1" as an IP address. `true` is refused: it trusts every
// X-Forwarded-For entry, and a proxy that appends to the header lets each client pick its own address.
function parseTrustProxy(v) {
  const s = String(v ?? '').trim();
  const l = s.toLowerCase();
  if (s === '' || l === 'false') return false;
  if (l === 'true') {
    throw new Error('TRUST_PROXY=true would let clients choose their own address through X-Forwarded-For. '
      + 'Set the number of proxy hops (TRUST_PROXY=1) or the proxy addresses (TRUST_PROXY="loopback, 10.0.0.0/8").');
  }
  if (/^\d+$/.test(s)) return Number(s);
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

// An on/off switch from an env string. Unset or empty gives the default. Anything other than the usual spellings
// is refused at startup: a typo such as RVNG_INVITE_ONLY=ture must not quietly leave the server open.
function parseFlag(v, def, name = 'flag') {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return def;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new Error(`${name}=${v} is not an on/off value: use 1 or 0`);
}

// Central configuration. Everything can be overridden by environment variables.
module.exports = {
  parseTrustProxy,
  parseFlag,
  port: Number(process.env.PORT || 8080),
  dbPath: process.env.DB_PATH || 'rvng.sqlite',
  // Admin bearer token for baseline uploads, tournament management, dispute resolution.
  adminToken: process.env.ADMIN_TOKEN || '',
  // Set when running behind a reverse proxy so per-IP limits see the client address (Express 'trust proxy'):
  // TRUST_PROXY=1 (one proxy hop) or the proxy addresses, such as "loopback, 10.0.0.0/8".
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // Request signing (client/mod -> server)
  signatureMaxSkewMs: 5 * 60 * 1000,

  // Integrity attestations are short-lived: a player must re-scan before each queue session.
  integrityTokenTtlMs: 30 * 60 * 1000,
  integrity: {
    minIntervalMs: 10 * 1000, // per-player spacing between integrity reports
    maxFiles: 50000,
    maxLoadedModules: 2048,
    maxAircraft: 1000,
    keepReports: 20, // per player; older reports not in use are deleted
    storedFindings: 200, // findings/mods kept per stored report, most severe first (a per-code summary keeps the rest)
    maxStoredBytes: 256 * 1024, // stored findings + mods per report; over this only the summary is kept
    maxPathLength: 1024, // characters per file path
    maxModuleName: 260, // characters per loaded-module entry
    maxAircraftId: 128, // characters per aircraft id
  },

  // Anonymous sign-ups per client address (IPv6 clients are counted per /64 network).
  registration: { windowMs: 60 * 60 * 1000, max: 10, maxTracked: 50000 },

  // Invite-only (RVNG_INVITE_ONLY=1): a new account starts 'pending' and cannot scan, queue, enter events or file
  // reports until an admin sets it 'active' (POST /api/admin/players/:id/status). Off by default so an upgraded
  // server keeps letting people in; turn it on for a private test group (assume the client will leak).
  access: { inviteOnly: parseFlag(process.env.RVNG_INVITE_ONLY, false, 'RVNG_INVITE_ONLY') },

  // Queues the server runs. RVNG_RANKED=0 refuses ranked joins (the ladder is paused, casual still works; a pilot
  // who owes an event series can still queue for that game). A join that names no mode goes to ranked while
  // ranked is on, and to casual while it is off.
  modes: { ranked: parseFlag(process.env.RVNG_RANKED, true, 'RVNG_RANKED') },

  // Admin-set player roles shown as a badge on player cards ('player' is the default and shows no badge), and
  // the admin's short note on the card. Add a role here to offer it.
  players: { roles: ['player', 'tester', 'veteran'], maxNoteLength: 200 },

  // Player reports (cheating, griefing, ...). They go to an admin and never change anything by themselves.
  reports: {
    reasons: ['cheating', 'griefing', 'abuse', 'other'],
    maxDetails: 500, // characters
    windowMs: 60 * 60 * 1000, // per reporter: at most `maxPerWindow` reports in this window
    maxPerWindow: 5,
  },

  // A matched host who lets the room lapse (never posts the room code, so the sweep voids the match) gets a lapse
  // on record. `lapses` lapses within `windowMs` put the pilot on a queue cooldown of `cooldownMs` after the last.
  dodging: { windowMs: 24 * 60 * 60 * 1000, lapses: 3, cooldownMs: 15 * 60 * 1000 },

  rating: {
    initial: 1500,
    kProvisional: 40, // first `provisionalGames` games
    kStandard: 24,
    kHigh: 16, // rating >= highThreshold
    provisionalGames: 10,
    highThreshold: 2100,
  },

  matchmaking: {
    // Ranked: tight rating windows.
    baseWindow: 100, // initial allowed rating gap
    windowGrowthPerSec: 5, // widen search over time
    maxWindow: 600,
    queueTimeoutMs: 10 * 60 * 1000,
    longWaitMs: 120 * 1000, // after this, both players may be paired across regions
    regions: ['global', 'na', 'sa', 'eu', 'asia', 'oce', 'me', 'af'],
    // Casual: matched on a hidden casual rating with much looser windows; some imbalance is fine.
    casual: { baseWindow: 300, windowGrowthPerSec: 15, maxWindow: 1200, longWaitMs: 45 * 1000 },
    // Two pilots who met within `windowMs` (any mode) are not paired again while either has another eligible
    // opponent. If they are the only match for each other, they are paired once both have waited `waitMs`.
    // Event series always pair. windowMs 0 turns this off.
    rematch: { windowMs: 30 * 60 * 1000, waitMs: 60 * 1000 },
  },

  match: {
    // Default competitive 1v1 ruleset. The mod applies these to the private room.
    defaultRules: {
      timeLimitSec: 600,
      killTarget: 5,
      respawn: true,
      specialWeapons: true,
      // empty = all aircraft allowed
      aircraftBans: [],
    },
    reportWindowMs: 15 * 60 * 1000, // both reports must arrive within this time of the first
    // A room that went live but never got a report is closed after the time limit plus this grace (ranked:
    // void, event game: admin review). Reports that arrive later are still accepted and settle it.
    liveGraceMs: 15 * 60 * 1000,
    untimedMatchSec: 3 * 60 * 60, // stands in for the time limit of rooms without one (timeLimitSec 0)
    lateReportMs: 24 * 60 * 60 * 1000, // logs for a room the sweep closed are accepted for this long afterwards
    minDurationSec: 30,
    maxObservedSpeed: 100000, // km/h; telemetry above this is malformed
  },
};
