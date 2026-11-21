// The RVNG server on Cloudflare (the user, 2026-11-21: "Port it to Cloudflare like Survival"). The same src/ as the Node
// server, so matchmaking, the mod scans, match reports, ratings, events and the admin API behave the same:
// - one Durable Object ("main") holds the whole database in its own SQLite (worker/sqlstore.js) and answers /api/* through
//   src/app.js's routes (worker/express.js stands in for Express). It handles one request at a time, as the Node
//   server's synchronous database did;
// - its alarm replaces the Node server's 3 s timer: matchmaking and the stale-match sweep every 3 s while someone is
//   queued, every 30 s while a match is open; idle, no alarm;
// - the website (public/) is the Worker's static assets, with public/_headers' security headers. Everything is on
//   the website (no Discord bot: the user, 2026-11-21).
import { DurableObject } from 'cloudflare:workers';
import shim from './express.js';
import sqlstore from './sqlstore.js';
import dbmod from '../src/db.js';
import appmod from '../src/app.js';
import svc from '../src/service.js';

const OPEN_STATES = "('pending', 'live', 'awaiting_reports')";

export class RvngServer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = dbmod.initDb(sqlstore.makeDb(ctx.storage));
    this.app = appmod.createApp({ db: this.db });
  }

  async fetch(request) {
    const ip = request.headers.get('cf-connecting-ip') || '';
    const res = await shim.handle(this.app, request, { ip });
    await this.arm();
    return res || new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }

  async alarm() {
    try { svc.runMatchmaker(this.db); svc.sweepStaleMatches(this.db); } catch (e) { console.error(e); }
    await this.arm();
  }

  nextDelay() {
    if (this.db.prepare('SELECT 1 FROM queue LIMIT 1').get()) return 3000;
    if (this.db.prepare(`SELECT 1 FROM matches WHERE state IN ${OPEN_STATES} LIMIT 1`).get()) return 30000;
    return null;
  }

  async arm() {
    const d = this.nextDelay();
    if (d == null) return;
    const at = Date.now() + d;
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur > at) await this.ctx.storage.setAlarm(at);
  }
}

const server = (env) => env.RVNG.get(env.RVNG.idFromName('main'));

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) return server(env).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
