// Local preview of the Vercel deployment: static files from the repo root plus the
// /api functions, with the same req/res shape Vercel's Node runtime provides.
// NOT deployed — Vercel ignores this file and serves api/*.js as real serverless functions.
//
//   node dev-server.mjs          -> http://localhost:8299   (PIN from .env.local, else 2323)
//
// Renders: with REPLICATE_API_TOKEN set they are REAL, PAID Replicate renders. Without it they
// go to the local ComfyUI (dev-comfy.mjs: same page, same prompts, free, owner PIN only), or to
// mock placeholder images if ComfyUI is not running. 3D models are not routed here at all.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// .env.local (gitignored) so Supabase/Stripe/Replicate keys can be exercised locally
// without exporting them into the shell every time. Loaded before the API modules read
// process.env at import time.
{
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env.local');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
    }
  }
}
import authHandler from './api/auth.js';
import generateHandler from './api/generate.js';
import configHandler from './api/config.js';
import meHandler from './api/me.js';
import checkoutHandler from './api/checkout.js';
import webhookHandler from './api/stripe-webhook.js';
import claimHandler from './api/claim.js';
import adminGrantHandler from './api/admin/grant.js';
import comfyGenerate, { comfyAvailable } from './dev-comfy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8299;
process.env.PODDER_PIN ||= '2323';

const ROUTES = {
  '/api/auth': authHandler,
  '/api/generate': generateHandler,
  '/api/config': configHandler,
  '/api/me': meHandler,
  '/api/checkout': checkoutHandler,
  '/api/stripe-webhook': webhookHandler,
  '/api/claim': claimHandler,
  '/api/admin/grant': adminGrantHandler,
};
const RAW_ROUTES = new Set(['/api/stripe-webhook']);

// Decided per request so starting ComfyUI after the dev server still works.
const HAS_REPLICATE = !!(process.env.REPLICATE_API_TOKEN || '').trim();
async function pickGenerate() {
  if (HAS_REPLICATE) return generateHandler;
  return (await comfyAvailable()) ? comfyGenerate : generateHandler;   // generateHandler = mock images
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.css': 'text/css' };

function vercelify(req, res, body) {
  req.body = body;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
}

const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];

  if (ROUTES[p]) {
    // The Stripe webhook verifies a signature over the exact bytes, so it reads the stream
    // itself (mirroring `bodyParser: false` on Vercel). Consuming it here would hang it.
    if (RAW_ROUTES.has(p)) {
      vercelify(req, res, undefined);
      try { await ROUTES[p](req, res); }
      catch (e) { if (!res.writableEnded) res.status(500).json({ error: String(e.message || e) }); }
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    vercelify(req, res, body);
    const handler = p === '/api/generate' ? await pickGenerate() : ROUTES[p];
    try { await handler(req, res); }
    catch (e) { if (!res.writableEnded) res.status(500).json({ error: String(e.message || e) }); }
    return;
  }

  const file = p === '/' ? 'index.html' : path.normalize(decodeURIComponent(p)).replace(/^([/\\])+/, '');
  const fp = path.join(__dirname, file);
  if (!fp.startsWith(__dirname)) { res.statusCode = 403; return res.end('Forbidden'); }
  try {
    const data = await readFile(fp);
    res.setHeader('content-type', TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404; res.end('Not found');
  }
});

// 127.0.0.1 only: local renders run on this PC's GPU, so nothing else on the network may queue them.
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`\n  Podder Web (dev) -> http://localhost:${PORT}`);
  const renders = HAS_REPLICATE ? 'REPLICATE (real, paid)' : (await comfyAvailable()) ? 'local ComfyUI (free)' : 'mock images (ComfyUI not running)';
  console.log(`  Renders: ${renders}   Unlock with the owner PIN from .env.local (default 2323)\n`);
});
