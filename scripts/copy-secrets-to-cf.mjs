#!/usr/bin/env node
// Copies the Vercel production env vars of project "podder" into the Cloudflare Worker as
// secrets. Run: node scripts/copy-secrets-to-cf.mjs   (needs `vercel login` + `wrangler login`)
//
// Values are never printed: it lists names only, and the temp file holding them is deleted
// at the end even if a step fails. Vars Vercel marks "Sensitive" come back empty (Vercel
// won't reveal them to anyone); those are listed so they can be pasted in the Cloudflare
// dashboard by hand.

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'podder-secrets-'));
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });

try {
  try { run('npx -y vercel@48 whoami', tmp); }
  catch {
    console.log('\nSign in to Vercel: open the link below (or press Enter) and approve it.\n');
    execSync('npx -y vercel@48 login', { cwd: tmp, stdio: 'inherit' });
  }
  run('npx -y vercel@48 link --yes --project podder --scope prosim', tmp);
  run('npx -y vercel@48 env pull .env.prod --environment=production --yes', tmp);

  const vars = {}, empty = [];
  const text = readFileSync(join(tmp, '.env.prod'), 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || /^(VERCEL|TURBO|NX)(_|$)/.test(m[1])) continue;   // Vercel's own system vars
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    v = v.replace(/\\n/g, '\n');
    if (v) vars[m[1]] = v; else empty.push(m[1]);
  }

  console.log(`\nFound ${Object.keys(vars).length + empty.length} keys in Vercel (${text.split(/\r?\n/).length} lines in the download):`);
  for (const k of Object.keys(vars)) console.log(`  ${k.padEnd(28)} has a value`);
  for (const k of empty) console.log(`  ${k.padEnd(28)} EMPTY`);
  if (!Object.keys(vars).length) throw new Error('No values came through from Vercel, so nothing was sent to Cloudflare.');

  writeFileSync(join(tmp, 'secrets.json'), JSON.stringify(vars));
  console.log('\nSending them to Cloudflare (if a browser opens, approve the Cloudflare sign-in)...\n');
  execSync(`npx wrangler secret bulk "${join(tmp, 'secrets.json')}"`, { cwd: root, stdio: 'inherit' });
  console.log('\nDone.');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
