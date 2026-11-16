'use strict';
const crypto = require('node:crypto');
const config = require('./config');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function newCredentials() {
  return {
    apiKey: 'ak_' + crypto.randomBytes(18).toString('base64url'),
    apiSecret: crypto.randomBytes(32).toString('base64url'),
  };
}

// Canonical string the client signs. Must match client/lib/sign.js and the mod.
function canonical(method, path, timestamp, nonce, rawBody) {
  return [method.toUpperCase(), path, timestamp, nonce, sha256(rawBody || '')].join('\n');
}

function sign(secret, method, path, timestamp, nonce, rawBody) {
  return crypto.createHmac('sha256', secret).update(canonical(method, path, timestamp, nonce, rawBody)).digest('hex');
}

function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

// Express middleware: authenticates a player via HMAC-signed request.
function requirePlayer(db) {
  const findByKey = db.prepare('SELECT * FROM players WHERE api_key_hash = ?');
  const insertNonce = db.prepare('INSERT OR IGNORE INTO nonces (player_id, nonce, seen_at) VALUES (?, ?, ?)');
  const purge = db.prepare('DELETE FROM nonces WHERE seen_at < ?');

  return (req, res, next) => {
    const key = req.get('x-player-key');
    const ts = req.get('x-timestamp');
    const nonce = req.get('x-nonce');
    const sig = req.get('x-signature');
    if (!key || !ts || !nonce || !sig) return res.status(401).json({ error: 'missing signature headers' });

    const now = Date.now();
    if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > config.signatureMaxSkewMs) {
      return res.status(401).json({ error: 'stale or invalid timestamp' });
    }
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return res.status(401).json({ error: 'invalid nonce' });

    const player = findByKey.get(sha256(key));
    if (!player) return res.status(401).json({ error: 'unknown key' });

    const expected = sign(player.api_secret, req.method, req.originalUrl.split('?')[0], ts, nonce, req.rawBody);
    if (!safeEqualHex(sig, expected)) return res.status(401).json({ error: 'bad signature' });

    purge.run(now - 2 * config.signatureMaxSkewMs);
    const r = insertNonce.run(player.id, nonce, now);
    if (r.changes === 0) return res.status(401).json({ error: 'replayed request' });

    if (player.status === 'banned') return res.status(403).json({ error: 'player banned' });
    req.player = player;
    next();
  };
}

function requireAdmin(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!config.adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN not configured' });
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(sha256(config.adminToken));
  if (!crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'admin only' });
  next();
}

module.exports = { sha256, newCredentials, canonical, sign, requirePlayer, requireAdmin };
