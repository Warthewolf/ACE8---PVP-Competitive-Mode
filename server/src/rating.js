'use strict';
const config = require('./config');

function expected(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

function kFactor(rating, gamesPlayed) {
  const c = config.rating;
  if (gamesPlayed < c.provisionalGames) return c.kProvisional;
  if (rating >= c.highThreshold) return c.kHigh;
  return c.kStandard;
}

// Returns rating deltas for winner/loser of a 1v1.
function eloDeltas(winner, loser) {
  const ew = expected(winner.rating, loser.rating);
  const kw = kFactor(winner.rating, winner.wins + winner.losses);
  const kl = kFactor(loser.rating, loser.wins + loser.losses);
  return {
    winner: +(kw * (1 - ew)).toFixed(2),
    loser: +(-kl * (1 - ew)).toFixed(2),
  };
}

const TIERS = [
  [2300, 'Ace'],
  [2000, 'Elite'],
  [1800, 'Veteran'],
  [1600, 'Wingman'],
  [1400, 'Pilot'],
  [0, 'Rookie'],
];
const tierFor = (rating) => TIERS.find(([min]) => rating >= min)[1];

module.exports = { expected, kFactor, eloDeltas, tierFor };

// General Elo update with scoreA in {1, 0.5, 0}.
function eloUpdate(a, b, scoreA) {
  const ea = expected(a.rating, b.rating);
  const ka = kFactor(a.rating, a.wins + a.losses);
  const kb = kFactor(b.rating, b.wins + b.losses);
  return {
    a: +(ka * (scoreA - ea)).toFixed(2),
    b: +(kb * ((1 - scoreA) - (1 - ea))).toFixed(2),
  };
}
module.exports.eloUpdate = eloUpdate;
