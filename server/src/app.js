'use strict';
const path = require('node:path');
const express = require('express');
const config = require('./config');
const { openDb } = require('./db');
const { requirePlayer, requireAdmin } = require('./auth');
const svc = require('./service');
const tournaments = require('./tournaments');

// Fixed-window counter per key (client IP), kept in memory.
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key, t = Date.now()) => {
    if (hits.size > 10000) for (const [k, v] of hits) if (t - v.start > windowMs) hits.delete(k);
    const h = hits.get(key);
    if (!h || t - h.start > windowMs) { hits.set(key, { start: t, n: 1 }); return true; }
    h.n += 1;
    return h.n <= max;
  };
}

function createApp({ db = openDb(config.dbPath) } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('db', db);
  app.set('trust proxy', config.trustProxy);

  // Keep the raw body: request signatures are computed over the exact bytes sent. Only routes that carry
  // integrity reports, match logs or manifests may send large bodies.
  const verify = (req, _res, buf) => { req.rawBody = buf.toString('utf8'); };
  app.use(['/api/integrity/report', '/api/matches/:id/report', '/api/admin/baselines', '/api/admin/mods'],
    express.json({ limit: '4mb', verify }));
  app.use(express.json({ limit: '64kb', verify }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; "
      + "font-src https://fonts.gstatic.com; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    next();
  });

  const player = requirePlayer(db);
  const wrap = (fn) => (req, res, next) => {
    try { const out = fn(req, res); if (out !== undefined) res.json(out); } catch (e) { next(e); }
  };
  // Query values are strings, or arrays/objects when repeated or bracketed: accept plain strings only.
  const str = (v) => (typeof v === 'string' ? v : undefined);
  const int = (v, d, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const n = Number(str(v) ?? v);
    return typeof v !== 'object' && Number.isSafeInteger(n) ? Math.min(Math.max(n, min), max) : d;
  };
  const id = (v) => int(v, -1);
  const allowSignup = rateLimiter(config.registration);

  // ----- public (website) -----
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/stats', wrap(() => svc.stats(db)));
  app.get('/api/leaderboard', wrap((req) => svc.leaderboard(db, { limit: int(req.query.limit, 100, 1, 500), offset: int(req.query.offset, 0, 0, 1e6) })));
  app.get('/api/players/:id', wrap((req) => svc.playerProfile(db, id(req.params.id))));
  app.get('/api/matches', wrap((req) => svc.recentMatches(db, { state: str(req.query.state), limit: int(req.query.limit, 50, 1, 200) })));
  app.get('/api/matches/:id/public', wrap((req) => svc.getMatch(db, req.params.id)));
  app.get('/api/tournaments', wrap(() => tournaments.list(db)));
  app.get('/api/tournaments/:id', wrap((req) => {
    const t = tournaments.get(db, id(req.params.id));
    if (!t) throw new tournaments.HttpError(404, 'tournament not found');
    return t;
  }));

  // Registration returns credentials exactly once; the player saves them as credentials.json.
  app.post('/api/players/register', wrap((req, res) => {
    if (!allowSignup(req.ip)) throw new tournaments.HttpError(429, 'too many sign-ups from this address; try again later');
    res.status(201);
    return svc.registerPlayer(db, req.body || {});
  }));

  // ----- player (signed by client scanner / in-game mod) -----
  app.get('/api/me', player, wrap((req) => svc.playerProfile(db, req.player.id)));
  app.post('/api/integrity/report', player, wrap((req) => svc.submitIntegrity(db, req.player, req.body)));
  app.post('/api/queue/join', player, wrap((req) => svc.joinQueue(db, req.player, req.body || {})));
  app.post('/api/queue/leave', player, wrap((req) => { svc.leaveQueue(db, req.player); return svc.queueStatus(db, req.player); }));
  // Status polls only read: pairing runs on join and on the background tick.
  app.get('/api/queue/status', player, wrap((req) => svc.queueStatus(db, req.player)));
  app.get('/api/matches/:id', player, wrap((req) => svc.getMatch(db, req.params.id, req.player.id)));
  app.post('/api/matches/:id/lobby', player, wrap((req) => svc.setLobby(db, req.player, req.params.id, (req.body || {}).lobbyCode)));
  app.post('/api/matches/:id/report', player, wrap((req) => svc.submitReport(db, req.player, req.params.id, req.body)));
  app.post('/api/tournaments/:id/register', player, wrap((req) => {
    tournaments.register(db, id(req.params.id), req.player);
    return tournaments.get(db, id(req.params.id));
  }));

  // ----- admin -----
  app.put('/api/admin/baselines', requireAdmin, wrap((req) => svc.putBaseline(db, req.body || {})));
  app.post('/api/admin/baselines/:version/active', requireAdmin, wrap((req) => svc.setBaselineActive(db, req.params.version, (req.body || {}).active)));
  app.get('/api/admin/mods', requireAdmin, wrap(() => svc.listApprovedMods(db)));
  app.post('/api/admin/mods', requireAdmin, wrap((req) => svc.addApprovedMods(db, req.body || {})));
  app.delete('/api/admin/mods/:id', requireAdmin, wrap((req) => svc.removeApprovedMod(db, id(req.params.id))));
  app.get('/api/admin/integrity', requireAdmin, wrap((req) => svc.integrityLog(db, { verdict: str(req.query.verdict), limit: int(req.query.limit, 100, 1, 500) })));
  app.post('/api/admin/players/:id/status', requireAdmin, wrap((req) => { svc.setPlayerStatus(db, id(req.params.id), (req.body || {}).status); return { ok: true }; }));
  app.post('/api/admin/matches/:id/resolve', requireAdmin, wrap((req) => svc.resolveDispute(db, req.params.id, req.body || {})));
  app.post('/api/admin/tournaments', requireAdmin, wrap((req, res) => { res.status(201); return tournaments.create(db, req.body || {}); }));
  app.post('/api/admin/tournaments/:id/start', requireAdmin, wrap((req) => tournaments.start(db, id(req.params.id))));
  app.post('/api/admin/series/:id/forfeit', requireAdmin, wrap((req) => tournaments.forfeit(db, id(req.params.id), (req.body || {}).winner)));

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
