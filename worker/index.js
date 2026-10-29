// Cloudflare Workers entry for podder.dev. Runs the SAME api/*.js handlers Vercel runs —
// there is one codebase, not a port. This file only translates between a Workers
// fetch(Request) and the Vercel/Node (req, res) shape those handlers expect.
//
// Static files (index.html, the book, images) are served by Workers assets straight from
// dist/ (built by scripts/build-cf.mjs) and never reach this code; wrangler.jsonc sends only
// /api/* here.

const ROUTES = {
  '/api/account': () => import('../api/account.js'),
  '/api/auth': () => import('../api/auth.js'),
  '/api/brochure': () => import('../api/brochure.js'),
  '/api/checkout': () => import('../api/checkout.js'),
  '/api/claim': () => import('../api/claim.js'),
  '/api/config': () => import('../api/config.js'),
  '/api/generate': () => import('../api/generate.js'),
  '/api/me': () => import('../api/me.js'),
  '/api/model3d': () => import('../api/model3d.js'),
  '/api/report': () => import('../api/report.js'),
  '/api/stripe-webhook': () => import('../api/stripe-webhook.js'),
  '/api/admin/grant': () => import('../api/admin/grant.js'),
};
// vercel.json rewrites that land on a function.
const REWRITES = { '/api/admin/alerts': ['/api/admin/grant', { op: 'alerts' }] };
// Verifies a signature over the exact bytes, so it reads the body itself (bodyParser: false).
const RAW_ROUTES = new Set(['/api/stripe-webhook']);

const SECURITY_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// The handlers read process.env (some at import time), so copy the Worker's vars and
// secrets in before the first handler module is imported.
let envReady = false;
function loadEnv(env) {
  if (envReady) return;
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] ??= v;
  envReady = true;
}

function makeReq(request, url, query, raw, body) {
  const headers = {};
  for (const [k, v] of request.headers) headers[k] = v;
  // clientIp() reads x-forwarded-for (the PIN lockout is per IP).
  headers['x-forwarded-for'] = request.headers.get('cf-connecting-ip') || headers['x-forwarded-for'] || '';
  const req = { method: request.method, url: url.pathname + url.search, headers, query, body, readable: true, readableEnded: false };
  // Minimal readable stream for readRawBody(): one 'data' chunk, then 'end'.
  const on = { data: [], end: [] };
  req.on = (ev, fn) => {
    if (ev === 'data') on.data.push(fn);
    if (ev === 'end') queueMicrotask(() => { if (raw) on.data.forEach(f => f(raw)); req.readableEnded = true; fn(); });
    return req;
  };
  return req;
}

function makeRes() {
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const headers = new Headers();
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader(k, v) { headers.set(k, String(v)); return res; },
    getHeader(k) { return headers.get(k); },
    status(c) { res.statusCode = c; return res; },
    json(o) { headers.set('content-type', 'application/json'); return res.end(JSON.stringify(o)); },
    send(b) { return res.end(typeof b === 'object' && !(b instanceof Uint8Array) ? JSON.stringify(b) : b); },
    end(b) {
      if (res.writableEnded) return res;
      res.writableEnded = true;
      resolve(new Response(b ?? null, { status: res.statusCode, headers }));
      return res;
    },
  };
  return { res, done };
}

async function handleApi(request, env, ctx) {
  loadEnv(env);
  const url = new URL(request.url);
  let path = url.pathname.replace(/\/+$/, '');
  const query = Object.fromEntries(url.searchParams);
  if (REWRITES[path]) { Object.assign(query, REWRITES[path][1]); path = REWRITES[path][0]; }
  const load = ROUTES[path];
  if (!load) return Response.json({ error: 'not_found' }, { status: 404 });

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const raw = hasBody ? await request.text() : '';
  let body;
  if (!RAW_ROUTES.has(path)) {
    body = {};
    if (raw) { try { body = JSON.parse(raw); } catch {} }
  }

  const req = makeReq(request, url, query, raw, body);
  const { res, done } = makeRes();
  const { default: handler } = await load();
  const run = (async () => {
    try { await handler(req, res); }
    catch (e) { if (!res.writableEnded) res.status(500).json({ error: String(e?.message || e) }); }
    if (!res.writableEnded) res.end();
  })();
  // Vercel keeps a function alive until the handler returns, even after the response is
  // sent (alerts, the Tripo balance check). waitUntil gives Workers the same behaviour.
  ctx.waitUntil(run);
  return done;
}

export default {
  async fetch(request, env, ctx) {
    const resp = await handleApi(request, env, ctx);
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  },
};
