'use strict';
/**
 * Match log validation and reconciliation.
 *
 * Each player's mod submits a log after the match ends:
 * {
 *   matchId: "m_...",
 *   gameVersion: "1.0.2",
 *   durationSec: 412,
 *   endReason: "kill_target" | "time_limit" | "disconnect" | "surrender",
 *   self:     { aircraftId: "f22a", kills: 5, deaths: 3 },
 *   opponent: { aircraftId: "su57", kills: 3, deaths: 5 },
 *   events: [ { t: 12.4, type: "missile_fired"|"hit"|"kill"|"death"|"respawn", actor: "self"|"opponent", weapon: "MSL", damage: 40 } ],
 *   telemetry: { selfMaxSpeed: 2410, opponentMaxSpeed: 2380 }   // km/h, observed
 * }
 *
 * Neither player can control the other player's log, so every number is cross-checked
 * against the opponent's view of the same match.
 */

const EVENT_TYPES = new Set(['missile_fired', 'gun_fired', 'special_fired', 'hit', 'kill', 'death', 'respawn', 'flare', 'disconnect']);
const END_REASONS = new Set(['kill_target', 'time_limit', 'disconnect', 'surrender']);
const SPEED_TOLERANCE = 1.05; // observed speed may exceed baseline max by 5% (dives, lag interpolation)
const DURATION_TOLERANCE_SEC = 15;

const isInt = (n) => Number.isInteger(n) && n >= 0;

function validateShape(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['report must be an object'];
  if (typeof r.durationSec !== 'number' || r.durationSec < 0) errs.push('durationSec');
  if (!END_REASONS.has(r.endReason)) errs.push('endReason');
  for (const side of ['self', 'opponent']) {
    const s = r[side];
    if (!s || typeof s.aircraftId !== 'string' || !isInt(s.kills) || !isInt(s.deaths)) errs.push(side);
  }
  if (!Array.isArray(r.events) || r.events.length > 20000) errs.push('events');
  else if (r.events.some((e) => !e || !EVENT_TYPES.has(e.type) || !['self', 'opponent'].includes(e.actor) || typeof e.t !== 'number')) {
    errs.push('events[]');
  }
  return errs;
}

/**
 * Reconcile the two reports (A = host, B = guest).
 * @returns { ok, scoreA, scoreB, outcome: 'a'|'b'|'draw', flags: [{code, player?, ...}] }
 */
function reconcile(repA, repB, ctx) {
  const { rules, aircraftStats = {}, playerA, playerB } = ctx;
  const flags = [];
  const flag = (code, extra = {}) => flags.push({ code, ...extra });

  // Score agreement: A's kills as seen by A must equal A's kills as seen by B.
  if (repA.self.kills !== repB.opponent.kills || repA.opponent.kills !== repB.self.kills) {
    flag('score_mismatch', { a: [repA.self.kills, repA.opponent.kills], b: [repB.opponent.kills, repB.self.kills] });
  }
  if (repA.self.deaths !== repB.opponent.deaths || repA.opponent.deaths !== repB.self.deaths) {
    flag('death_mismatch');
  }
  if (repA.self.aircraftId !== repB.opponent.aircraftId || repA.opponent.aircraftId !== repB.self.aircraftId) {
    flag('aircraft_mismatch');
  }
  if (Math.abs(repA.durationSec - repB.durationSec) > DURATION_TOLERANCE_SEC) flag('duration_mismatch');

  // Rules.
  const bans = new Set(rules.aircraftBans || []);
  for (const [rep, pid] of [[repA, playerA], [repB, playerB]]) {
    if (bans.has(rep.self.aircraftId)) flag('banned_aircraft', { player: pid, aircraft: rep.self.aircraftId });
    if (rules.killTarget && rep.self.kills > rules.killTarget) flag('kills_exceed_target', { player: pid });
    if (rules.timeLimitSec && rep.durationSec > rules.timeLimitSec + DURATION_TOLERANCE_SEC) flag('duration_exceeds_limit');
    if (!rules.specialWeapons && rep.events.some((e) => e.actor === 'self' && e.type === 'special_fired')) {
      flag('special_weapon_used', { player: pid });
    }
    // Kill events in the log must account for the claimed kills.
    const killEvents = rep.events.filter((e) => e.type === 'kill' && e.actor === 'self').length;
    if (killEvents !== rep.self.kills) flag('kill_events_inconsistent', { player: pid, claimed: rep.self.kills, events: killEvents });
  }

  // Physics plausibility using the opponent's observation (the suspect cannot edit it).
  for (const [observer, suspect, pid] of [[repB, repA, playerA], [repA, repB, playerB]]) {
    const ref = aircraftStats[suspect.self.aircraftId];
    const seen = observer.telemetry && observer.telemetry.opponentMaxSpeed;
    if (ref && typeof ref.maxSpeed === 'number' && typeof seen === 'number' && seen > ref.maxSpeed * SPEED_TOLERANCE) {
      flag('speed_anomaly', { player: pid, observed: seen, max: ref.maxSpeed });
    }
  }

  const scoreA = repA.self.kills;
  const scoreB = repA.opponent.kills;
  let outcome = scoreA > scoreB ? 'a' : scoreB > scoreA ? 'b' : 'draw';
  // A surrender/disconnect by one side is a loss for that side, whatever the score.
  const leaver = (rep, side) => rep.events.some((e) => e.type === 'disconnect' && e.actor === side);
  if (repA.endReason === 'disconnect' || repB.endReason === 'disconnect' || repA.endReason === 'surrender' || repB.endReason === 'surrender') {
    const aLeft = leaver(repA, 'self') || leaver(repB, 'opponent');
    const bLeft = leaver(repB, 'self') || leaver(repA, 'opponent');
    if (aLeft && !bLeft) outcome = 'b';
    else if (bLeft && !aLeft) outcome = 'a';
  }

  return { ok: flags.length === 0, scoreA, scoreB, outcome, flags };
}

module.exports = { validateShape, reconcile, SPEED_TOLERANCE };
