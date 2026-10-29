#!/usr/bin/env node
// Builds dist/ — the static files Cloudflare serves. Run: node scripts/build-cf.mjs
//
// An explicit allowlist, not "the repo root": wrangler uploads from local disk, so serving "."
// would publish .env.local, the api source and the supabase folder. Vercel never had that
// risk because it deploys from git, where those files are ignored or harmless.
// Runs the same preflight as the Vercel build first, so a broken index.html can't ship here either.

import { cpSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

execFileSync(process.execPath, [join(root, 'scripts', 'preflight.mjs')], { stdio: 'inherit' });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const FILES = /\.(html|png|ico|jpg|jpeg|webp|svg)$|^(manifest\.json|robots\.txt|sitemap\.xml)$/i;
for (const f of readdirSync(root)) if (FILES.test(f)) cpSync(join(root, f), join(dist, f));
for (const d of ['brochure', 'gallery']) if (existsSync(join(root, d))) cpSync(join(root, d), join(dist, d), { recursive: true });

// Same headers vercel.json sets on every path. (The Worker adds them to /api responses.)
writeFileSync(join(dist, '_headers'), `/*
  X-Frame-Options: SAMEORIGIN
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
`);

console.log(`  ok    dist/ built (${readdirSync(dist).length} top-level entries)`);
