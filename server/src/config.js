'use strict';

// Central configuration. Everything can be overridden by environment variables.
module.exports = {
  port: Number(process.env.PORT || 8080),
  dbPath: process.env.DB_PATH || 'ace8pvp.sqlite',
  // Admin bearer token for baseline uploads, tournament management, dispute resolution.
  adminToken: process.env.ADMIN_TOKEN || '',

  // Request signing (client/mod -> server)
  signatureMaxSkewMs: 5 * 60 * 1000,

  // Integrity attestations are short-lived: a player must re-scan before each queue session.
  integrityTokenTtlMs: 30 * 60 * 1000,

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
    minDurationSec: 30,
  },
};
