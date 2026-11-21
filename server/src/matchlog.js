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
 *   events: [ { t: 12.4, type: "missile_fired"|"special_fired"|"hit"|"kill"|"death"|"disconnect"|..., actor: "self"|"opponent" } ],
 *   telemetry: { selfMaxSpeed: 2410, opponentMaxSpeed: 2380 },  // km/h, observed
 *   runtime:   { aircraft:    { "<aircraftId>": { maxSpeed, turnRate, hp, ... } },   // highest value sampled per stat
 *                aircraftMin: { "<aircraftId>": { ... } } }                         // lowest value sampled per stat
 * }
 *
 * Neither player can control the other player's log, so every number is cross-checked
 * against the opponent's view of the same match. The game build (and so the reference
 * stats) comes from both players' clean integrity scans, never from the logs.
 */

const { compareAircraft, isPlainObject, SEVERITY } = require('./integrity');

const EVENT_TYPES = new Set(['missile_fired', 'gun_fired', 'special_fired', 'hit', 'kill', 'death', 'respawn', 'flare', 'disconnect']);
const END_REASONS = new Set(['kill_target', 'time_limit', 'disconnect', 'surrender']);
const SPEED_TOLERANCE = 1.05; // observed speed may exceed baseline max by 5% (dives, lag interpolation)
const DURATION_TOLERANCE_SEC = 15;
const MAX_DURATION_SEC = 24 * 3600;
const MAX_SPEED = 100000; // km/h; anything above is a malformed value, not an observation
const MAX_SCORE = 1e7;
// The native deathmatch: the game's own clock (MC_DM MissionLimitTime 210 s, docs/re/DEATHMATCH_NATIVE.md 1), counted by
// the mod from GamePlaying to the result; both PCs hold the same scores (the host's ScoreUpdates), as shown (one decimal).
const NATIVE_DM_TIME_SEC = 210;
const NATIVE_DM_TIME_SLACK_SEC = 30;
const SCORE_TOLERANCE = 0.5;

const isInt = (n) => Number.isInteger(n) && n >= 0;
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function validateShape(r) {
  const errs = [];
  if (!isPlainObject(r)) return ['report must be an object'];
  // Older mod builds encode an empty events list as {}.
  if (isPlainObject(r.events) && Object.keys(r.events).length === 0) r.events = [];
  if (!isNum(r.durationSec) || r.durationSec < 0 || r.durationSec > MAX_DURATION_SEC) errs.push('durationSec');
  if (!END_REASONS.has(r.endReason)) errs.push('endReason');
  if (r.gameVersion !== undefined && typeof r.gameVersion !== 'string') errs.push('gameVersion');
  for (const side of ['self', 'opponent']) {
    const s = r[side];
    if (!isPlainObject(s) || typeof s.aircraftId !== 'string' || s.aircraftId.length > 64 || !isInt(s.kills) || !isInt(s.deaths)) errs.push(side);
  }
  if (!Array.isArray(r.events) || r.events.length > 20000) errs.push('events');
  else if (r.events.some((e) => !isPlainObject(e) || !EVENT_TYPES.has(e.type) || !['self', 'opponent'].includes(e.actor) || !isNum(e.t))) {
    errs.push('events[]');
  }
  if (r.telemetry !== undefined) {
    if (!isPlainObject(r.telemetry)) errs.push('telemetry');
    else {
      for (const k of ['selfMaxSpeed', 'opponentMaxSpeed']) {
        const v = r.telemetry[k];
        if (v !== undefined && !(isNum(v) && v >= 0 && v <= MAX_SPEED)) errs.push(`telemetry.${k}`);
      }
    }
  }
  if (r.runtime !== undefined && !isPlainObject(r.runtime)) errs.push('runtime');
  // The game's own deathmatch (RVNG runtime 0.4.4): each side's score as the game shows it, decided at time-up.
  if (r.format !== undefined && r.format !== 'native_dm') errs.push('format');
  if (r.format === 'native_dm') {
    for (const side of ['self', 'opponent']) {
      const s = r[side];
      if (!isPlainObject(s) || !isNum(s.score) || s.score < 0 || s.score > MAX_SCORE) errs.push(`${side}.score`);
    }
  }
  return errs;
}

/**
 * Reconcile the two reports (A = host, B = guest).
 * @param ctx { rules, aircraftStats, playerA, playerB, minDurationSec }
 * @returns { ok, scoreA, scoreB, outcome: 'a'|'b'|'draw', flags: [{code, player?, ...}] }
 */
function reconcile(repA, repB, ctx) {
  const { rules, aircraftStats = {}, playerA, playerB, minDurationSec = 0 } = ctx;
  const flags = [];
  const flag = (code, extra = {}) => flags.push({ code, ...extra });
  const sides = [[repA, repB, playerA], [repB, repA, playerB]]; // [report, other report, author]

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
  if (Math.min(repA.durationSec, repB.durationSec) < minDurationSec) flag('too_short');

  // How the match ended: both pilots must agree, and the end must fit the room rules, so the side that is
  // ahead cannot close the room early or run it with a lower kill target.
  if (repA.endReason !== repB.endReason) flag('end_reason_mismatch', { a: repA.endReason, b: repB.endReason });
  for (const [rep, , pid] of sides) {
    const top = Math.max(rep.self.kills, rep.opponent.kills);
    if (rep.endReason === 'kill_target' && (!rules.killTarget || top < rules.killTarget)) {
      flag('premature_end', { player: pid, endReason: rep.endReason, top });
    }
    if (rep.endReason === 'time_limit' && (!rules.timeLimitSec || rep.durationSec < rules.timeLimitSec - DURATION_TOLERANCE_SEC)) {
      flag('premature_end', { player: pid, endReason: rep.endReason, durationSec: rep.durationSec });
    }
  }

  // Rules.
  const bans = new Set(rules.aircraftBans || []);
  for (const [rep, other, pid] of sides) {
    if (bans.has(rep.self.aircraftId)) flag('banned_aircraft', { player: pid, aircraft: rep.self.aircraftId });
    if (rules.killTarget && rep.self.kills > rules.killTarget) flag('kills_exceed_target', { player: pid });
    if (rules.timeLimitSec && rep.durationSec > rules.timeLimitSec + DURATION_TOLERANCE_SEC) flag('duration_exceeds_limit');
    // A ban is checked in both logs: the offender can strip their own events but not the opponent's.
    if (rules.specialWeapons === false && (
      rep.events.some((e) => e.actor === 'self' && e.type === 'special_fired')
      || other.events.some((e) => e.actor === 'opponent' && e.type === 'special_fired'))) {
      flag('special_weapon_used', { player: pid });
    }
    // Kill events in the log must account for the claimed kills.
    const killEvents = rep.events.filter((e) => e.type === 'kill' && e.actor === 'self').length;
    if (killEvents !== rep.self.kills) flag('kill_events_inconsistent', { player: pid, claimed: rep.self.kills, events: killEvents });
  }

  // Live flight parameters the author's own game reported during the match (sampled by the mod), for the
  // aircraft the author flew: the highest and the lowest value seen for each stat. A changed value lies above
  // or below the reference, so it shows up in one of the two whenever it was active, even if the trainer was
  // already on at match start or off for the final sample. Only self-incriminating: nobody can put values
  // into another pilot's log.
  for (const [rep, , pid] of sides) {
    const id = rep.self.aircraftId;
    const seen = new Set();
    const once = (code, extra) => { const k = `${code}:${extra.stat ?? ''}`; if (!seen.has(k)) { seen.add(k); flag(code, extra); } };
    for (const key of ['aircraft', 'aircraftMin']) {
      const ac = rep.runtime && rep.runtime[key];
      if (!isPlainObject(ac) || !Object.hasOwn(ac, id)) { once('runtime_stats_missing', { player: pid, aircraft: id }); continue; }
      for (const f of compareAircraft({ [id]: ac[id] }, aircraftStats)) {
        if (SEVERITY[f.severity] < SEVERITY.high) continue;
        once(f.code === 'aircraft_stat_modified' ? 'aircraft_stat_modified' : 'runtime_stats_invalid',
          { player: pid, aircraft: id, stat: f.stat, expected: f.expected, actual: f.actual });
      }
    }
  }

  // Physics plausibility using the opponent's observation (the suspect cannot edit it).
  for (const [observer, suspect, pid] of [[repB, repA, playerA], [repA, repB, playerB]]) {
    const id = suspect.self.aircraftId;
    const ref = Object.hasOwn(aircraftStats, id) ? aircraftStats[id] : null;
    if (!ref || !isNum(ref.maxSpeed)) { flag('unknown_reference', { player: pid, aircraft: id }); continue; }
    const seen = observer.telemetry && observer.telemetry.opponentMaxSpeed;
    if (isNum(seen) && seen > ref.maxSpeed * SPEED_TOLERANCE) {
      flag('speed_anomaly', { player: pid, observed: seen, max: ref.maxSpeed });
    }
  }

  const scoreA = repA.self.kills;
  const scoreB = repA.opponent.kills;
  let outcome = scoreA > scoreB ? 'a' : scoreB > scoreA ? 'b' : 'draw';

  // A surrender/disconnect is a loss for the pilot who left, whatever the score, but only when both logs
  // name the same single leaver: the leaver's own log ("self") and the opponent's log ("opponent").
  // Anything else (a one-sided claim, both sides blaming each other) goes to an admin.
  const left = (rep, side) => rep.events.some((e) => e.type === 'disconnect' && e.actor === side);
  const aSelf = left(repA, 'self'); const aSeen = left(repB, 'opponent');
  const bSelf = left(repB, 'self'); const bSeen = left(repA, 'opponent');
  const early = [repA.endReason, repB.endReason].some((r) => r === 'disconnect' || r === 'surrender');
  if (early || aSelf || aSeen || bSelf || bSeen) {
    const aLeft = aSelf && aSeen; const bLeft = bSelf && bSeen;
    if (aSelf !== aSeen || bSelf !== bSeen || aLeft === bLeft) {
      flag('end_mismatch', { a: repA.endReason, b: repB.endReason });
    } else outcome = aLeft ? 'b' : 'a';
  }

  return { ok: flags.length === 0, scoreA, scoreB, outcome, flags };
}

/**
 * Reconcile two native deathmatch logs (format 'native_dm', RVNG runtime 0.4.4: docs/re/DEATHMATCH_NATIVE.md 9.15).
 * The match is the game's own deathmatch on the two PCs: decided by score at time-up; a pilot's kills are the other's
 * deaths. Both logs must agree on everything (kills, deaths, aircraft, scores, length, end). A lost link (endReason
 * 'disconnect') can't say who left, so it goes to an admin. The old design's sampled flight stats aren't in these logs.
 * @param ctx { rules, playerA, playerB, minDurationSec }
 */
function reconcileNativeDm(repA, repB, ctx) {
  const { rules = {}, playerA, playerB, minDurationSec = 0 } = ctx;
  const flags = [];
  const flag = (code, extra = {}) => flags.push({ code, ...extra });
  const sides = [[repA, repB, playerA], [repB, repA, playerB]];
  if (repA.format !== 'native_dm' || repB.format !== 'native_dm') flag('format_mismatch', { a: repA.format ?? null, b: repB.format ?? null });
  if (repA.self.kills !== repB.opponent.kills || repA.opponent.kills !== repB.self.kills) {
    flag('kills_mismatch', { a: [repA.self.kills, repA.opponent.kills], b: [repB.opponent.kills, repB.self.kills] });
  }
  if (repA.self.deaths !== repB.opponent.deaths || repA.opponent.deaths !== repB.self.deaths) flag('death_mismatch');
  if (repA.self.aircraftId !== repB.opponent.aircraftId || repA.opponent.aircraftId !== repB.self.aircraftId) flag('aircraft_mismatch');
  const sa = repA.self.score; const sb = repA.opponent.score;
  if (Math.abs(sa - repB.opponent.score) > SCORE_TOLERANCE || Math.abs(sb - repB.self.score) > SCORE_TOLERANCE) {
    flag('score_mismatch', { a: [sa, sb], b: [repB.opponent.score, repB.self.score] });
  }
  if (Math.abs(repA.durationSec - repB.durationSec) > DURATION_TOLERANCE_SEC) flag('duration_mismatch');
  if (Math.min(repA.durationSec, repB.durationSec) < minDurationSec) flag('too_short');
  if (repA.endReason !== repB.endReason) flag('end_reason_mismatch', { a: repA.endReason, b: repB.endReason });
  const bans = new Set(rules.aircraftBans || []);
  for (const [rep, , pid] of sides) {
    if (rep.endReason !== 'time_limit' && rep.endReason !== 'disconnect') flag('end_reason_invalid', { player: pid, endReason: rep.endReason });
    if (rep.endReason === 'time_limit' && (rep.durationSec < NATIVE_DM_TIME_SEC - DURATION_TOLERANCE_SEC
      || rep.durationSec > NATIVE_DM_TIME_SEC + NATIVE_DM_TIME_SLACK_SEC)) {
      flag('duration_off_clock', { player: pid, durationSec: rep.durationSec });
    }
    if (bans.has(rep.self.aircraftId)) flag('banned_aircraft', { player: pid, aircraft: rep.self.aircraftId });
    const killEvents = rep.events.filter((e) => e.type === 'kill' && e.actor === 'self').length;
    if (killEvents !== rep.self.kills) flag('kill_events_inconsistent', { player: pid, claimed: rep.self.kills, events: killEvents });
  }
  if (repA.endReason === 'disconnect' && repB.endReason === 'disconnect') flag('link_lost');
  const scoreA = Math.round(sa); const scoreB = Math.round(sb);
  const outcome = sa > sb ? 'a' : sb > sa ? 'b' : 'draw';
  return { ok: flags.length === 0, scoreA, scoreB, outcome, flags };
}

module.exports = { validateShape, reconcile, reconcileNativeDm, SPEED_TOLERANCE, DURATION_TOLERANCE_SEC, NATIVE_DM_TIME_SEC };
