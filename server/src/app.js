'use strict';
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { requirePlayer, requireAdmin } = require('./auth');
const svc = require('./service');
const tournaments = require('./tournaments');

function createApp({ db = openDb(require('./config').dbPath) } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('db', db);

  // Keep the raw body: request signatures are computed over the exact bytes sent.
  app.use(express.json({ limit: '4mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'");
    next();
  });

  const player = requirePlayer(db);
  const wrap = (fn) => (req, res, next) => {
    try { const out = fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); }
  };
  const intParam = (v, d) => (Number.isInteger(Number(v)) ? Number(v) : d);

  // ----- public (website) -----
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/stats', wrap(() => svc.stats(db)));
  app.get('/api/leaderboard', wrap((req) => svc.leaderboard(db, { limit: intParam(req.query.limit, 100), offset: intParam(req.query.offset, 0) })));
  app.get('/api/players/:id', wrap((req) => svc.playerProfile(db, intParam(req.params.id, -1))));
  app.get('/api/matches', wrap((req) => svc.recentMatches(db, { state: req.query.state, limit: intParam(req.query.limit, 50) })));
  app.get('/api/matches/:id/public', wrap((req) => svc.getMatch(db, req.params.id)));
  app.get('/api/tournaments', wrap(() => tournaments.list(db)));
  app.get('/api/tournaments/:id', wrap((req) => {
    const t = tournaments.get(db, intParam(req.params.id, -1));
    if (!t) throw new tournaments.HttpError(404, 'tournament not found');
    return t;
  }));

  // Registration returns credentials exactly once; the player pastes them into the mod config.
  app.post('/api/players/register', wrap((req, res) => { res.status(201); return svc.registerPlayer(db, req.body || {}); }));

  // ----- player (signed by client scanner / in-game mod) -----
  app.get('/api/me', player, wrap((req) => svc.playerProfile(db, req.player.id)));
  app.post('/api/integrity/report', player, wrap((req) => svc.submitIntegrity(db, req.player, req.body)));
  app.post('/api/queue/join', player, wrap((req) => svc.joinQueue(db, req.player, req.body || {})));
  app.post('/api/queue/leave', player, wrap((req) => { svc.leaveQueue(db, req.player); return { state: 'idle' }; }));
  app.get('/api/queue/status', player, wrap((req) => { svc.runMatchmaker(db); return svc.queueStatus(db, req.player); }));
  app.get('/api/matches/:id', player, wrap((req) => svc.getMatch(db, req.params.id, req.player.id)));
  app.post('/api/matches/:id/lobby', player, wrap((req) => svc.setLobby(db, req.player, req.params.id, (req.body || {}).lobbyCode)));
  app.post('/api/matches/:id/report', player, wrap((req) => svc.submitReport(db, req.player, req.params.id, req.body)));
  app.post('/api/tournaments/:id/register', player, wrap((req) => {
    tournaments.register(db, intParam(req.params.id, -1), req.player.id);
    return tournaments.get(db, intParam(req.params.id, -1));
  }));

  // ----- admin -----
  app.put('/api/admin/baselines', requireAdmin, wrap((req) => svc.putBaseline(db, req.body || {})));
  app.post('/api/admin/mods', requireAdmin, wrap((req) => svc.addApprovedMod(db, req.body || {})));
  app.get('/api/admin/integrity', requireAdmin, wrap((req) => svc.integrityLog(db, { verdict: req.query.verdict, limit: intParam(req.query.limit, 100) })));
  app.post('/api/admin/players/:id/status', requireAdmin, wrap((req) => { svc.setPlayerStatus(db, intParam(req.params.id, -1), (req.body || {}).status); return { ok: true }; }));
  app.post('/api/admin/matches/:id/resolve', requireAdmin, wrap((req) => svc.resolveDispute(db, req.params.id, req.body || {})));
  app.post('/api/admin/tournaments', requireAdmin, wrap((req, res) => { res.status(201); return tournaments.create(db, req.body || {}); }));
  app.post('/api/admin/tournaments/:id/start', requireAdmin, wrap((req) => tournaments.start(db, intParam(req.params.id, -1))));

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });
  return app;
}

module.exports = { createApp };
