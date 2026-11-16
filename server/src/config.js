'use strict';

// Central configuration. Everything can be overridden by environment variables.
module.exports = {
  port: Number(process.env.PORT || 8080),
  dbPath: process.env.DB_PATH || 'rvng.sqlite',
  // Admin bearer token for baseline uploads, tournament management, dispute resolution.
  adminToken: process.env.ADMIN_TOKEN || '',
  // Set when running behind a reverse proxy so per-IP limits see the client address (Express 'trust proxy').
  trustProxy: process.env.TRUST_PROXY || false,

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
    storedFindings: 200, // findings/mods kept per stored report (a per-code summary keeps the rest)
  },

  // Anonymous sign-ups per client IP.
  registration: { windowMs: 60 * 60 * 1000, max: 10 },

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
    // A room that went live but never got a report is voided after the time limit plus this grace.
    liveGraceMs: 15 * 60 * 1000,
    minDurationSec: 30,
    maxObservedSpeed: 100000, // km/h; telemetry above this is malformed
  },
};
