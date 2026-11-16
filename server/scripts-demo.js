'use strict';
// Seeds a local database with demo pilots, matches and a finished knockout event so the website has content.
// Usage: DB_PATH=demo.sqlite node scripts-demo.js
const { openDb } = require('./src/db');
const config = require('./src/config');
const svc = require('./src/service');
const tournaments = require('./src/tournaments');

const db = openDb(process.env.DB_PATH || 'demo.sqlite');
// Reference stats for the demo build: matches are cross-checked against them like real ones.
const AIRCRAFT = { f22a: { maxSpeed: 2400, turnRate: 30, hp: 100 }, su57: { maxSpeed: 2450, turnRate: 32, hp: 100 } };
svc.putBaseline(db, { gameVersion: 'demo', manifest: { files: [] }, aircraft: AIRCRAFT });
const RULES = JSON.stringify(config.match.defaultRules);
const player = (id) => db.prepare('SELECT * FROM players WHERE id = ?').get(id);
const names = ['Trigger', 'Count', 'Talisman', 'Cipher', 'Pixy', 'Mobius1', 'Wardog', 'Garuda', 'Strider', 'Sol', 'Avril', 'Huxian'];
const ids = names.map((n) => { try { return svc.registerPlayer(db, { name: n }).id; } catch { return db.prepare('SELECT id FROM players WHERE name = ?').get(n).id; } });
const skill = Object.fromEntries(ids.map((id, i) => [id, 12 - i]));

function play(a, b, seriesId = null) {
  const id = 'm_demo' + Math.random().toString(36).slice(2, 10);
  db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, game_version, state, series_id, created_at) VALUES (?, ?, ?, ?, 'demo', 'live', ?, ?)`)
    .run(id, a, b, RULES, seriesId, Date.now() - Math.floor(Math.random() * 3 * 86400000));
  const aWins = Math.random() < skill[a] / (skill[a] + skill[b]);
  const loserKills = Math.floor(Math.random() * 5);
  const [ka, kb] = aWins ? [5, loserKills] : [loserKills, 5];
  const mk = (k, d, s, o) => ({ gameVersion: 'demo', durationSec: 240 + Math.floor(Math.random() * 300), endReason: 'kill_target',
    self: { aircraftId: s, kills: k, deaths: d }, opponent: { aircraftId: o, kills: d, deaths: k },
    events: [...Array(k)].map((_, i) => ({ t: i * 20, type: 'kill', actor: 'self' })).concat([...Array(d)].map((_, i) => ({ t: i * 20 + 7, type: 'kill', actor: 'opponent' }))),
    telemetry: { opponentMaxSpeed: 2300 }, runtime: { aircraft: { [s]: AIRCRAFT[s] } } });
  const ra = mk(ka, kb, 'f22a', 'su57'); const rb = mk(kb, ka, 'su57', 'f22a'); rb.durationSec = ra.durationSec;
  db.prepare('INSERT INTO match_reports (match_id, player_id, report, received_at) VALUES (?, ?, ?, ?)').run(id, a, JSON.stringify(ra), Date.now());
  const m = svc.submitReport(db, player(b), id, rb);
  if (m.state !== 'verified') throw new Error(`demo match ${id} was ${m.state}: ${JSON.stringify(m.flags)}`);
}

for (let i = 0; i < 150; i++) {
  const a = ids[Math.floor(Math.random() * ids.length)];
  let b; do { b = ids[Math.floor(Math.random() * ids.length)]; } while (b === a);
  play(a, b);
}

const t = tournaments.create(db, { name: 'Wings of Theve Invitational', size: 8, bestOf: 1, finalBestOf: 3 });
for (const id of ids.slice(0, 8)) tournaments.register(db, t.id, player(id));
tournaments.start(db, t.id);
for (let guard = 0; guard < 50; guard++) {
  const next = db.prepare(`SELECT player_a FROM series WHERE tournament_id = ? AND winner IS NULL
    AND player_a IS NOT NULL AND player_b IS NOT NULL ORDER BY round LIMIT 1`).get(t.id);
  const s = next && tournaments.openSeriesFor(db, next.player_a).find((x) => x.tournament_id === t.id);
  if (!s) break;
  play(s.player_a, s.player_b, s.id);
}
const open = tournaments.create(db, { name: 'Season 1 Knockout', size: 16, bestOf: 3, finalBestOf: 5 });
for (const id of ids.slice(2, 11)) tournaments.register(db, open.id, player(id));
console.log('Demo data written to', process.env.DB_PATH || 'demo.sqlite');
