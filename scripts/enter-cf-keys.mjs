#!/usr/bin/env node
// Asks for each Podder key one at a time and saves it to the Cloudflare Worker as a secret.
// Run: node scripts/enter-cf-keys.mjs  (or double-click ENTER-KEYS-FOR-CLOUDFLARE.bat)
//
// Exists because Vercel never gives env values back out (`vercel env pull` returns them blank),
// so the keys can't be copied across. Typing is hidden; values go straight to `wrangler secret put`
// over stdin and are never written to disk or printed. Press Enter on an empty line to skip one.
// Making a NEW key at a provider is fine: the old one keeps Vercel working until it's deleted.

import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const KEYS = [
  ['PODDER_PIN', 'Your owner PIN (the same one you use on podder.dev).'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'https://supabase.com/dashboard/project/knosaqkwhxxbgvshzxqg/settings/api-keys\n  -> "Legacy API keys" tab -> service_role -> Reveal -> Copy.'],
  ['BFL_API_KEY', 'https://dashboard.bfl.ai -> API Keys. If you can\'t see the old one, make a new key.'],
  ['REPLICATE_API_TOKEN', 'https://replicate.com/account/api-tokens -> copy, or Create token.'],
  ['TRIPO_API_KEY', 'https://platform.tripo3d.ai/api-keys -> make a new key if the old one is hidden.'],
  ['RENDER_REVIEW_KEY', 'Anthropic key for "Report a bad render": https://console.anthropic.com/settings/keys -> Create key.'],
];

// Hidden input: echo '*' instead of the typed characters.
function askHidden(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = s => { if (!muted) rl.output.write(s); else if (!/[\r\n]/.test(s)) rl.output.write('*'.repeat(s.length)); };
    rl.question(prompt, v => { rl.output.write('\n'); rl.close(); resolve(v.trim()); });
    muted = true;
  });
}

// Run wrangler's own JS with this node: no .cmd shim, no shell quoting on Windows.
const WR = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const wr = (args, opts = {}) => spawnSync(process.execPath, [WR, ...args], { cwd: root, encoding: 'utf8', ...opts });
// `secret put` over stdin can't open a browser, so make sure Cloudflare is signed in first.
if (!/logged in/i.test(wr(['whoami']).stdout || '')) {
  console.log('\nSign in to Cloudflare: a browser tab will open, click Allow.\n');
  wr(['login'], { stdio: 'inherit' });
}
const saved = [], skipped = [];
console.log('\nPaste each key and press Enter (it shows as ***). Press Enter on its own to skip one.\n');
for (const [name, hint] of KEYS) {
  console.log(`\n${name}\n  ${hint}`);
  const v = await askHidden('  Paste here: ');
  if (!v) { skipped.push(name); console.log('  skipped'); continue; }
  const r = wr(['secret', 'put', name], { input: v });
  if (r.status === 0 || /Success!/.test(r.stdout || '')) { saved.push(name); console.log('  saved to Cloudflare'); }
  else { skipped.push(name); console.log('  FAILED: ' + String(r.stderr || r.stdout).split('\n').filter(Boolean).slice(-2).join(' ')); }
}
console.log(`\nSaved: ${saved.join(', ') || 'none'}`);
if (skipped.length) console.log(`Not saved: ${skipped.join(', ')}`);
