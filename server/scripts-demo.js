'use strict';
// Seeds a local database with demo pilots, matches and a finished knockout event so the website has content.
// Usage: DB_PATH=demo.sqlite node scripts-demo.js
const { openDb, tx } = require('./src/db');
const svc = require('./src/service');
const tournaments = require('./src/tournaments');

const db = openDb(process.env.DB_PATH || 'demo.sqlite');
const names = ['Trigger', 'Count', 'Talisman', 'Cipher', 'Pixy', 'Mobius1', 'Wardog', 'Garuda', 'Strider', 'Sol', 'Avril', 'Huxian'];
const ids = names.map((n) => { try { return svc.registerPlayer(db, { name: n }).id; } catch { return db.prepare('SELECT id FROM players WHERE name = ?').get(n).id; } });
const skill = Object.fromEntries(ids.map((id, i) => [id, 12 - i]));

function play(a, b, seriesId = null) {
  const id = 'm_demo' + Math.random().toString(36).slice(2, 10);
  db.prepare(`INSERT INTO matches (id, player_a, player_b, rules, state, series_id, created_at) VALUES (?, ?, ?, '{}', 'live', ?, ?)`)
    .run(id, a, b, seriesId, Date.now() - Math.floor(Math.random() * 3 * 86400000));
  const aWins = Math.random() < skill[a] / (skill[a] + skill[b]);
  const loserKills = Math.floor(Math.random() * 5);
  const [ka, kb] = aWins ? [5, loserKills] : [loserKills, 5];
  const mk = (k, d, s, o) => ({ gameVersion: 'demo', durationSec: 240 + Math.floor(Math.random() * 300), endReason: 'kill_target',
    self: { aircraftId: s, kills: k, deaths: d }, opponent: { aircraftId: o, kills: d, deaths: k },
    events: [...Array(k)].map((_, i) => ({ t: i * 20, type: 'kill', actor: 'self' })).concat([...Array(d)].map((_, i) => ({ t: i * 20 + 7, type: 'kill', actor: 'opponent' }))) });
  const ra = mk(ka, kb, 'f22a', 'su57'); const rb = mk(kb, ka, 'su57', 'f22a'); rb.durationSec = ra.durationSec;
  db.prepare('INSERT INTO match_reports (match_id, player_id, report, received_at) VALUES (?, ?, ?, ?)').run(id, a, JSON.stringify(ra), Date.now());
  const pa = db.prepare('SELECT * FROM players WHERE id = ?').get(a);
  svc.submitReport(db, db.prepare('SELECT * FROM players WHERE id = ?').get(b), id, rb);
  void pa;
}

for (let i = 0; i < 150; i++) {
  const a = ids[Math.floor(Math.random() * ids.length)];
  let b; do { b = ids[Math.floor(Math.random() * ids.length)]; } while (b === a);
  play(a, b);
}

const t = tournaments.create(db, { name: 'Wings of Theve Invitational', size: 8, bestOf: 1, finalBestOf: 3 });
for (const id of ids.slice(0, 8)) tournaments.register(db, t.id, id);
tournaments.start(db, t.id);
for (let guard = 0; guard < 50; guard++) {
  const s = tournaments.pendingSeriesFor(db, db.prepare(`SELECT player_a FROM series WHERE tournament_id = ? AND winner IS NULL
    AND player_a IS NOT NULL AND player_b IS NOT NULL ORDER BY round LIMIT 1`).get(t.id)?.player_a ?? -1);
  if (!s) break;
  play(s.player_a, s.player_b, s.id);
}
const open = tournaments.create(db, { name: 'Season 1 Knockout', size: 16, bestOf: 3, finalBestOf: 5 });
for (const id of ids.slice(2, 11)) tournaments.register(db, open.id, id);
void tx;
console.log('Demo data written to', process.env.DB_PATH || 'demo.sqlite');
