// POST /api/generate
//   headers: Authorization: Bearer <supabase access token>   (or x-podder-pin for the owner)
//   body: { prompt, aspect?: "1:1"|"2:3"|"3:2", image?: dataURL, strength?: 0..1, quality?: "fast"|"quality" }
//   ->   { image: dataURL, credits: <new balance>, mock?: true }
//
// Runs Flux on Replicate server-side so the API token never reaches the browser.
// With `image` set it does an img2img edit (Podder's ✎ Edit box); without, plain txt2img.
//
// Billing order is deliberate: debit FIRST, render second, refund on failure. Rendering
// first would let a client abandon the connection mid-render and never be charged, and
// concurrent requests could each see a sufficient balance before any of them deducted.
// The debit is a single guarded UPDATE (see debit_credits in 0001_credits.sql), so
// parallel renders serialize on the row and the balance can never go negative.

import { pinOk } from './auth.js';
import { getUser, debit, credit, isInsufficient, missingEnv } from './_lib/server.js';
import { creditsFor } from './_lib/config.js';

export const maxDuration = 60;

const MODELS = {
  fast:    { model: 'black-forest-labs/flux-2-klein-4b', useVersionApi: true,  goFast: true,  imgField: 'images' },
  quality: { model: 'black-forest-labs/flux-2-pro',      useVersionApi: false, goFast: false, imgField: 'image'  },
};

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
    if (Date.now() > deadline) throw new Error('Render timed out — try again');
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
  const owner = pinOk(req.headers['x-podder-pin']);

  let user = null;
  if (!owner) {
    const missing = missingEnv();
    if (missing.length) return res.status(500).json({ error: 'server_not_configured', detail: `Missing: ${missing.join(', ')}` });
    user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'not_signed_in' });
  }

  const token = (process.env.REPLICATE_API_TOKEN || '')
    .trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();

  // No Replicate token means nothing real is being generated, so nothing is charged.
  if (!token) return res.status(200).json({ image: mockImage(prompt), mock: true });

  const cfg = MODELS[quality] || MODELS.fast;
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
    const input = {
      prompt,
      aspect_ratio: ['1:1', '2:3', '3:2'].includes(aspect) ? aspect : '1:1',
      output_format: 'png',
      // go_fast cuts sampling steps; edits need the full pass to follow the instruction.
      go_fast: isEdit ? false : cfg.goFast,
    };
    if (isEdit) {
      input[cfg.imgField] = cfg.imgField === 'images' ? [image] : image;
      // prompt_strength: 0 = copy image exactly, 1 = ignore image entirely. Default ~0.8
      // if omitted, which is usually too high for subtle edits. Pass whatever the UI chose.
      if (typeof strength === 'number' && strength > 0 && strength <= 1) {
        input.prompt_strength = strength;
      }
    }
    const imgUrl = await replicate(input, token, cfg);

    const imgResp = await fetch(imgUrl);
    if (!imgResp.ok) throw new Error(`Image fetch failed (${imgResp.status})`);
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const type = imgResp.headers.get('content-type') || 'image/png';
    return res.status(200).json({
      image: `data:${type};base64,${buf.toString('base64')}`,
      credits: balance,
    });
  } catch (e) {
    // The render failed after the user was charged — put the credits back. If the refund
    // itself fails the debit is still in the ledger, so it can be reconciled by hand.
    if (user) {
      try {
        balance = await credit(user.id, cost, `refund:${quality}`, `refund:${renderId}`);
      } catch (re) {
        console.error('refund failed', { user: user.id, renderId, cost, error: String(re.message || re) });
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
