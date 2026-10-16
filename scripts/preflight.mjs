#!/usr/bin/env node
// Pre-deploy guard for index.html. Run: node scripts/preflight.mjs
//
// Exists because of a real outage: a stray duplicated `neg:` line was left inside SD_OBJ, the
// whole inline <script> failed to parse, and EVERY handler on the page silently never bound.
// The gate links looked broken; in fact no JavaScript ran at all. It shipped to production and
// sat there until someone happened to open the console.
//
// Runtime error monitoring cannot catch that — a script that fails to parse never runs, so it
// never gets the chance to report anything. The only reliable guard is parsing before deploy.
//
// Checks:
//   1. every inline <script> parses
//   2. OBJECTS <-> SD_OBJ stay in sync (the sync drift that produced the stray line)
//   3. every object is structurally complete and its category is declared
//   4. no duplicate emoji within a category (makes picker entries indistinguishable)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL  ' + msg); };
const pass = (msg) => console.log('  ok    ' + msg);

// ---- 1. inline scripts parse -------------------------------------------------------------
const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
let m, blocks = 0;
while ((m = re.exec(html))) {
  blocks++;
  const line = html.slice(0, m.index).split('\n').length;
  try {
    new Function(m[1]);
  } catch (e) {
    fail(`inline script #${blocks} (opens at line ${line}) does not parse: ${e.message}`);
  }
}
if (!blocks) fail('no inline <script> blocks found — did index.html change shape?');
else if (!failures) pass(`all ${blocks} inline script blocks parse`);

// ---- extract the catalog literals --------------------------------------------------------
// Skips strings AND comments: a section header reads  /* ---- JEWELRY (cat:"jewelry") ---- */
// and that literal `cat:"jewelry"` otherwise parses as a real key, swallowing the entry after it.
function skipInert(src, i) {
  const c = src[i];
  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === c) return j + 1;
    }
    return src.length;
  }
  if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); return n === -1 ? src.length : n; }
  if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); return n === -1 ? src.length : n + 2; }
  return -1;
}

function grab(name) {
  const hit = new RegExp('const\\s+' + name + '\\s*=\\s*\\{').exec(html);
  if (!hit) return null;
  const start = hit.index + hit[0].length - 1;
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const skip = skipInert(html, i);
    if (skip !== -1) { i = skip - 1; continue; }
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

let OBJECTS, SD_OBJ, CATEGORIES;
try {
  OBJECTS = eval('(' + grab('OBJECTS') + ')');
  SD_OBJ = eval('(' + grab('SD_OBJ') + ')');
  CATEGORIES = eval('(' + grab('CATEGORIES') + ')');
} catch (e) {
  fail('could not read the catalog literals: ' + e.message);
}

if (OBJECTS && SD_OBJ && CATEGORIES) {
  const ok = Object.keys(OBJECTS), sk = Object.keys(SD_OBJ);
  const report = (label, bad) => bad.length ? fail(`${label}: ${bad.join(', ')}`) : pass(label);

  console.log(`\n  ${ok.length} objects / ${sk.length} SD_OBJ / ${Object.keys(CATEGORIES).length} categories\n`);

  report('every object has an SD_OBJ entry', ok.filter(k => !SD_OBJ[k]));
  report('every SD_OBJ entry has an object', sk.filter(k => !OBJECTS[k]));
  report('every object has fn + shapes', ok.filter(k => !OBJECTS[k].fn || !OBJECTS[k].shapes?.length));
  report('every object has an Auto shape', ok.filter(k => !OBJECTS[k].shapes?.some(s => s.label === 'Auto')));
  report('every shape has a prompt', ok.filter(k => OBJECTS[k].shapes?.some(s => !s.prompt)));
  report('every SD_OBJ has noun/bits/neg', sk.filter(k => !SD_OBJ[k].noun || !SD_OBJ[k].bits || !SD_OBJ[k].neg));
  report('every cat is declared', ok.filter(k => OBJECTS[k].cat && !CATEGORIES[OBJECTS[k].cat]));

  const dupes = [];
  for (const cat of Object.keys(CATEGORIES)) {
    const seen = {};
    for (const k of ok.filter(k => (OBJECTS[k].cat || 'homegoods') === cat)) {
      (seen[OBJECTS[k].emoji] ??= []).push(OBJECTS[k].label);
    }
    for (const [emoji, labels] of Object.entries(seen)) {
      if (labels.length > 1) dupes.push(`${cat} ${emoji} = ${labels.join(' / ')}`);
    }
  }
  report('no duplicate emoji within a category', dupes);
}

console.log('');
if (failures) {
  console.error(`PREFLIGHT FAILED — ${failures} problem${failures > 1 ? 's' : ''}. Do not deploy.`);
  process.exit(1);
}
console.log('preflight passed');
