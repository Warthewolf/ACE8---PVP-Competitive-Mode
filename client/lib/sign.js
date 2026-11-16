'use strict';
// Must stay in sync with server/src/auth.js (canonical + sign).
const crypto = require('node:crypto');

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');

function signedHeaders(creds, method, path, body) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('base64url');
  const canonical = [method.toUpperCase(), path, ts, nonce, sha256(body || '')].join('\n');
  return {
    'x-player-key': creds.apiKey,
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-signature': crypto.createHmac('sha256', creds.apiSecret).update(canonical).digest('hex'),
  };
}

async function api(server, creds, method, path, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers = { ...(creds ? signedHeaders(creds, method, path, body) : {}) };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(server.replace(/\/$/, '') + path, { method, headers, body: body || undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

module.exports = { signedHeaders, api, sha256 };
