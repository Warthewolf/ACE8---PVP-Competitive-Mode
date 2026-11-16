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

// Central configuration. Everything can be overridden by environment variables.
module.exports = {
  parseTrustProxy,
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

  rating: {
    initial: 1500,
    kProvisional: 40, // first `provisionalGames` games
    kStandard: 24,
    kHigh: 16, // rating >= highThreshold
    provisionalGames: 10,
    highThreshold: 2100,
  },

  matchmaking: {
    baseWindow: 100, // initial allowed rating gap
    windowGrowthPerSec: 5, // widen search over time
    maxWindow: 600,
    queueTimeoutMs: 10 * 60 * 1000,
    longWaitMs: 120 * 1000, // after this, both players may be paired across regions
    regions: ['global', 'na', 'sa', 'eu', 'asia', 'oce', 'me', 'af'],
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
