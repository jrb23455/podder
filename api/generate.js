// POST /api/generate
//   headers: Authorization: Bearer <supabase access token>   (or x-podder-pin for the owner)
//   body: { prompt, aspect?: "1:1"|"2:3"|"3:2", image?: dataURL, strength?: 0..1, quality?: "fast"|"quality" }
//   ->   { image: dataURL, credits: <new balance>, mock?: true }
//
// Runs the image model server-side so API keys never reach the browser.
// With `image` set it does an img2img edit (Podder's ✎ Edit box); without, plain txt2img.
//
// MODELS (switched 2026-10-22 after a same-prompt shoot-out, see PodderQC-shift-log.md):
//   fast    -> FLUX 3 Image Klein on Black Forest Labs' own API (BFL_API_KEY). ~$0.005/image, ~6 s.
//   quality -> FLUX 3 Image (full) on Replicate (REPLICATE_API_TOKEN), grounding (web search) off. ~25 s.
// Rollback without a code change: FAST_PROVIDER=replicate puts fast back on flux-2-klein-4b, and
// QUALITY_MODEL=black-forest-labs/flux-2-pro puts quality back on Flux 2 pro.
// Both FLUX 3 services rewrite prompts before rendering, so the client sends a concrete subject
// (buildPrompt picks one for figurine "Auto" shapes) or the rewriter invents one.
//
// Billing order is deliberate: debit FIRST, render second, refund on failure. Rendering
// first would let a client abandon the connection mid-render and never be charged, and
// concurrent requests could each see a sufficient balance before any of them deducted.
// The debit is a single guarded UPDATE (see debit_credits in 0001_credits.sql), so
// parallel renders serialize on the row and the balance can never go negative.

import { getUser, debit, credit, isInsufficient, missingEnv, checkOwnerPin, alert } from './_lib/server.js';
import { creditsFor } from './_lib/config.js';
import { createHash } from 'node:crypto';

export const maxDuration = 60;

const REPLICATE_MODELS = {
  'black-forest-labs/flux-2-klein-4b': { useVersionApi: true,  goFast: true,  imgField: 'images' },
  'black-forest-labs/flux-2-pro':      { useVersionApi: false, goFast: false, imgField: 'image'  },
  'black-forest-labs/flux-3-image':    { useVersionApi: false, flux3: true,   imgField: 'images' },
};
const env = k => (process.env[k] || '').trim().replace(/^["']|["']$/g, '');
const fastProvider = () => (env('FAST_PROVIDER') || (env('BFL_API_KEY') ? 'bfl' : 'replicate')).toLowerCase();
const qualityModel = () => env('QUALITY_MODEL') || 'black-forest-labs/flux-3-image';

// FLUX 3 Image Klein on api.bfl.ai: submit, then poll the returned polling_url until Ready.
async function bfl(input, key) {
  const deadline = Date.now() + 50_000;
  const sub = await fetch('https://api.bfl.ai/v1/flux-3-image-klein', {
    method: 'POST', headers: { 'x-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  });
  const sj = await sub.json().catch(() => ({}));
  if (!sub.ok || !sj.polling_url) throw new Error(sj.detail?.[0]?.msg || sj.detail || sj.message || `BFL ${sub.status}`);
  for (;;) {
    if (Date.now() > deadline) throw new Error('Render timed out — try again');
    await new Promise(r => setTimeout(r, 1200));
    const pr = await fetch(sj.polling_url, { headers: { 'x-key': key, accept: 'application/json' } });
    const pj = await pr.json().catch(() => ({}));
    if (pj.status === 'Ready') return pj.result?.sample;
    if (/moderat/i.test(pj.status || '')) throw new Error("That design was blocked by the image service's safety filter — try different wording");
    if (pj.status === 'Error' || pj.status === 'Failed') throw new Error(pj.result?.error || 'Render failed');
  }
}

function mockImage(prompt) {
  const label = (prompt || 'mock render').slice(0, 90).replace(/[<>&"]/g, ' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2a1e3a"/><stop offset="1" stop-color="#0a0710"/></linearGradient></defs>
    <rect width="1024" height="1024" fill="url(#g)"/>
    <circle cx="512" cy="460" r="230" fill="none" stroke="#c04bff" stroke-width="6" opacity=".8"/>
    <circle cx="512" cy="460" r="150" fill="none" stroke="#54d69b" stroke-width="4" opacity=".6"/>
    <text x="512" y="790" fill="#b9a8d8" font-family="Segoe UI,Arial" font-size="34" text-anchor="middle">MOCK RENDER — add REPLICATE_API_TOKEN</text>
    <text x="512" y="840" fill="#6f5f8f" font-family="Segoe UI,Arial" font-size="22" text-anchor="middle">${label}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

async function replicate(input, token, cfg) {
  const deadline = Date.now() + 50_000;

  const url = cfg.useVersionApi
    ? 'https://api.replicate.com/v1/predictions'
    : `https://api.replicate.com/v1/models/${cfg.model}/predictions`;

  const body = cfg.useVersionApi
    ? { version: cfg.model, input }
    : { input };

  let pred;
  for (;;) {
    const create = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=30' },
      body: JSON.stringify(body),
    });
    pred = await create.json();
    if (create.ok) break;
    const msg = pred?.detail || pred?.title || `Replicate ${create.status}`;
    const throttled = create.status === 429 || /throttl|rate limit/i.test(String(msg));
    if (!throttled || Date.now() + 12_000 > deadline) throw new Error(msg);
    await new Promise(r => setTimeout(r, 12_000));
  }
  while (pred.status === 'starting' || pred.status === 'processing') {
    if (Date.now() > deadline) {
      // The user is refunded on timeout, so stop Replicate finishing (and billing) a render
      // nobody will ever see.
      if (pred.urls?.cancel) {
        fetch(pred.urls.cancel, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      }
      throw new Error('Render timed out — try again');
    }
    await new Promise(r => setTimeout(r, 1500));
    const poll = await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${token}` } });
    pred = await poll.json();
  }
  if (pred.status !== 'succeeded') throw new Error(pred.error || `Render ${pred.status}`);
  const out = pred.output;
  if (Array.isArray(out)) return typeof out[0] === 'string' ? out[0] : out[0]?.url?.() || out[0];
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const { prompt, aspect = '1:1', image, strength, quality = 'fast' } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'missing_prompt' });

  // The owner PIN still works and bypasses billing entirely — it is how the account
  // holder uses their own app without buying credits from themselves.
  const pinState = await checkOwnerPin(req);
  if (pinState === 'locked') return res.status(429).json({ error: 'too_many_attempts' });
  const owner = pinState === 'ok';

  let user = null;
  if (!owner) {
    const missing = missingEnv();
    if (missing.length) return res.status(500).json({ error: 'server_not_configured', detail: `Missing: ${missing.join(', ')}` });
    user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'not_signed_in' });
  }

  const token = env('REPLICATE_API_TOKEN').replace(/^Bearer\s+/i, '').trim();
  const bflKey = env('BFL_API_KEY');
  const useBfl = quality !== 'quality' && fastProvider() === 'bfl' && !!bflKey;
  const model = quality === 'quality' ? qualityModel() : 'black-forest-labs/flux-2-klein-4b';
  const cfg = REPLICATE_MODELS[model] || REPLICATE_MODELS['black-forest-labs/flux-3-image'];

  // No key for the service this render would use means nothing real is generated, so nothing is charged.
  if (!useBfl && !token) return res.status(200).json({ image: mockImage(prompt), mock: true });
  const cost = creditsFor(quality);
  const renderId = crypto.randomUUID();

  let balance = null;
  if (user) {
    try {
      balance = await debit(user.id, cost, `render:${quality}`, `render:${renderId}`);
    } catch (e) {
      if (isInsufficient(e)) {
        return res.status(402).json({ error: 'insufficient_credits', needed: cost });
      }
      return res.status(500).json({ error: 'billing_failed', detail: String(e.message || e) });
    }
  }

  try {
    const isEdit = !!image;
    const ratio = ['1:1', '2:3', '3:2'].includes(aspect) ? aspect : '1:1';
    let imgUrl;
    if (useBfl) {
      const input = { prompt, aspect_ratio: ratio, resolution: '1k', output_format: 'png', safety_tolerance: 2 };
      if (isEdit) input.images = [String(image).replace(/^data:image\/[a-z+]+;base64,/i, '')];   // URL or bare base64
      imgUrl = await bfl(input, bflKey);
    } else {
      const input = { prompt, aspect_ratio: ratio, output_format: 'png' };
      if (cfg.flux3) {
        input.resolution = '1k';
        input.grounding = false;   // on by default: it web-searches the prompt first (slower, and can drift the subject)
      } else {
        // go_fast cuts sampling steps; edits need the full pass to follow the instruction.
        input.go_fast = isEdit ? false : cfg.goFast;
      }
      if (isEdit) {
        input[cfg.imgField] = cfg.imgField === 'images' ? [image] : image;
        // prompt_strength (Flux 2 only): 0 = copy image exactly, 1 = ignore image entirely.
        if (!cfg.flux3 && typeof strength === 'number' && strength > 0 && strength <= 1) {
          input.prompt_strength = strength;
        }
      }
      imgUrl = await replicate(input, token, { ...cfg, model });
    }
    if (!imgUrl) throw new Error('The image service returned no picture');

    const imgResp = await fetch(imgUrl);
    if (!imgResp.ok) throw new Error(`Image fetch failed (${imgResp.status})`);
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const type = imgResp.headers.get('content-type') || 'image/png';
    // Record the billed render so a later "Report a bad render" can be checked against exactly this
    // image (by hash) and this prompt, and so a refunded image can be locked out of 3D export.
    if (user) {
      try {
        await fetch(`${(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/rest/v1/renders`, {
          method: 'POST',
          headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ id: renderId, user_id: user.id, cost, quality: quality === 'quality' ? 'quality' : 'fast',
            prompt_head: prompt.slice(0, 600), image_sha: createHash('sha256').update(buf).digest('hex') }),
        });
      } catch { /* reporting is optional; the render itself succeeded */ }
    }
    return res.status(200).json({
      image: `data:${type};base64,${buf.toString('base64')}`,
      renderId: user ? renderId : null,
      credits: balance,
    });
  } catch (e) {
    // The render failed after the user was charged — put the credits back. If the refund
    // itself fails the debit is still in the ledger, so it can be reconciled by hand.
    if (user) {
      try {
        balance = await credit(user.id, cost, `refund:${quality}`, `refund:${renderId}`);
      } catch (re) {
        await alert('render_refund_failed', { user: user.id, renderId, cost, error: String(re.message || re) });
      }
    }
    return res.status(502).json({
      error: 'render_failed',
      detail: String(e.message || e),
      credits: balance,
      refunded: !!user,
    });
  }
}
