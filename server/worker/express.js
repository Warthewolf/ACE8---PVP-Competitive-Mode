'use strict';
// The part of Express that src/app.js uses, on the Fetch API (a Cloudflare Worker has no Node HTTP server), so the
// routes are written once for both servers. Matching what app.js relies on from Express 4 and body-parser:
// - routes and app.use paths are case-insensitive, a trailing slash is allowed, :params are URI-decoded;
// - middleware with four arguments handles errors; handlers call next() or next(err);
// - express.json: req.body is {} unless a JSON body was parsed; only Content-Type application/json is read; a
//   charset other than utf-* is 415 charset.unsupported; over the limit is 413 entity.too.large; only an object or
//   array at the top (strict), else 400 entity.parse.failed; verify(req, res, buf, charset) runs on the raw bytes;
// - req.query: one value is a string, a repeated one an array;
// - express.static does nothing here: the files in public/ are the Worker's static assets.
// handle(app, request) answers with a Response, or null when nothing handled the request (the caller then serves
// the static assets).
const { Buffer } = require('node:buffer');

function compile(path, prefix) {
  const keys = [];
  const src = String(path).replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === ':' ? c : '\\' + c))
    .replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+?)'; });
  return { re: new RegExp('^' + src + (prefix ? '(?:/|$)' : '/?$'), 'i'), keys };
}

function parseLimit(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(v || '100kb'));
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m && m[2] || 'b').toLowerCase()];
  return m ? Math.floor(Number(m[1]) * mult) : 100 * 1024;
}

// The parameters of a Content-Type value as the content-type package reads them: name=token or name="quoted" (with
// backslash escapes), names lower-cased, a repeated name's last value kept.
function contentTypeParams(ct) {
  const out = {};
  const re = /;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*/g;
  const semi = ct.indexOf(';');
  if (semi < 0) return out;
  re.lastIndex = semi;
  let m;
  while ((m = re.exec(ct)) && m.index === re.lastIndex - m[0].length) {
    out[m[1].toLowerCase()] = m[2][0] === '"' ? m[2].slice(1, -1).replace(/\\(.)/g, '$1') : m[2];
    if (re.lastIndex >= ct.length) break;
  }
  return out;
}

function httpError(status, type, message) { return Object.assign(new Error(message), { status, type }); }

function express() {
  const stack = []; // { method|null, match, keys, fns, prefix }
  const settings = {};
  const add = (method, prefix, paths, fns) => {
    const list = Array.isArray(paths) ? paths : [paths];
    for (const p of list) {
      const c = p == null ? null : compile(p, prefix);
      stack.push({ method, prefix, re: c && c.re, keys: c ? c.keys : [], fns });
    }
  };
  const app = {
    disable(k) { settings[k] = false; },
    set(k, v) { settings[k] = v; },
    get(path, ...fns) { if (!fns.length) return settings[path]; add('GET', false, path, fns); return app; },
    post(path, ...fns) { add('POST', false, path, fns); return app; },
    put(path, ...fns) { add('PUT', false, path, fns); return app; },
    delete(path, ...fns) { add('DELETE', false, path, fns); return app; },
    use(first, ...rest) {
      if (typeof first === 'function') add(null, true, null, [first, ...rest]);
      else add(null, true, first, rest);
      return app;
    },
    _stack: stack,
  };
  return app;
}

// A JSON body parser like express.json({ limit, verify }); the request's bytes are read once by handle().
express.json = ({ limit, verify } = {}) => {
  const max = parseLimit(limit);
  return (req, res, next) => {
    if (req._body) return next();
    req.body = req.body || {};
    const ct = String(req.get('content-type') || '');
    if (!/^application\/json\s*(;|$)/i.test(ct)) return next();
    const charset = (contentTypeParams(ct).charset || 'utf-8').toLowerCase();
    if (charset.slice(0, 4) !== 'utf-') return next(httpError(415, 'charset.unsupported', `unsupported charset "${charset.toUpperCase()}"`));
    const buf = req._raw;
    if (buf.length > max) return next(httpError(413, 'entity.too.large', 'request entity too large'));
    req._body = true;
    if (!buf.length) return next();
    try { if (verify) verify(req, res, buf, charset); } catch (e) {
      return next(Object.assign(e, { status: e.status || 403, type: e.type || 'entity.verify.failed' }));
    }
    const text = buf.toString('utf8');
    const first = text.trimStart()[0];
    if (first !== '{' && first !== '[') return next(httpError(400, 'entity.parse.failed', 'invalid JSON'));
    try { req.body = JSON.parse(text); } catch { return next(httpError(400, 'entity.parse.failed', 'invalid JSON')); }
    next();
  };
};
express.static = () => (_req, _res, next) => next();

function makeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null, sent: false,
    status(n) { res.statusCode = n; return res; },
    set(k, v) { res.headers[k.toLowerCase()] = String(v); return res; },
    get(k) { return res.headers[k.toLowerCase()]; },
    json(obj) {
      res.headers['content-type'] = 'application/json; charset=utf-8';
      res.body = JSON.stringify(obj === undefined ? null : obj);
      res.sent = true;
      return res;
    },
  };
  return res;
}

// request: a Fetch API Request; ip: the client's address (on Cloudflare, CF-Connecting-IP)
async function handle(app, request, { ip, remoteAddress } = {}) {
  const url = new URL(request.url);
  const query = {};
  for (const [k, v] of url.searchParams) {
    if (!(k in query)) query[k] = v;
    else query[k] = Array.isArray(query[k]) ? [...query[k], v] : [query[k], v];
  }
  const raw = ['GET', 'HEAD'].includes(request.method) ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
  const req = {
    method: request.method, path: url.pathname, originalUrl: url.pathname + url.search, query, params: {},
    headers: Object.fromEntries(request.headers), ip: ip || '', socket: { remoteAddress: remoteAddress ?? ip ?? '' }, _raw: raw,
    get: (name) => request.headers.get(name) ?? undefined,
  };
  const res = makeRes();
  const layers = app._stack.filter((l) => {
    if (l.method && l.method !== req.method && !(l.method === 'GET' && req.method === 'HEAD')) return false;
    return !l.re || l.re.test(url.pathname);
  });
  let i = 0; let j = 0;
  await new Promise((done) => {
    const next = (err) => {
      if (res.sent) return done();
      while (i < layers.length) {
        const l = layers[i];
        if (j >= l.fns.length) { i++; j = 0; continue; }
        const fn = l.fns[j++];
        if ((fn.length === 4) !== Boolean(err)) continue; // error handlers only see errors, the rest only requests
        if (l.re) {
          const m = l.re.exec(url.pathname);
          req.params = {};
          try { l.keys.forEach((k, n) => { req.params[k] = decodeURIComponent(m[n + 1]); }); } catch {
            err = httpError(400, 'uri.malformed', 'Failed to decode param');
            continue;
          }
        }
        let called = false;
        const step = (e) => { if (called) return; called = true; next(e); };
        try {
          const out = err ? fn(err, req, res, step) : fn(req, res, step);
          if (out && typeof out.then === 'function') out.then(() => { if (res.sent && !called) done(); }, step);
          else if (res.sent && !called) done();
        } catch (e) { step(e); }
        return;
      }
      if (err) { res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'internal error' }); }
      done();
    };
    next();
  });
  if (!res.sent) return null;
  return new Response(req.method === 'HEAD' ? null : res.body, { status: res.statusCode, headers: res.headers });
}

module.exports = express;
module.exports.handle = handle;
module.exports.contentTypeParams = contentTypeParams;
