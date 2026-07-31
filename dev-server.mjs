// Local preview of the Vercel deployment: static files from the repo root plus the
// /api functions, with the same req/res shape Vercel's Node runtime provides.
// NOT deployed — Vercel ignores this file and serves api/*.js as real serverless functions.
//
//   node dev-server.mjs          -> http://localhost:8299   (PIN defaults to 2323 in dev)
//
// Without REPLICATE_API_TOKEN set, /api/generate returns mock placeholder images.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authHandler from './api/auth.js';
import generateHandler from './api/generate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8299;
process.env.PODDER_PIN ||= '2323';

const ROUTES = { '/api/auth': authHandler, '/api/generate': generateHandler };
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
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch {}
    vercelify(req, res, body);
    try { await ROUTES[p](req, res); }
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

server.listen(PORT, () => {
  console.log(`\n  Podder Web (dev) -> http://localhost:${PORT}`);
  console.log(`  PIN: ${process.env.PODDER_PIN}   Replicate: ${process.env.REPLICATE_API_TOKEN ? 'LIVE' : 'mock mode'}\n`);
});
