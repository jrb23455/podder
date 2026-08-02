// POST /api/generate
//   headers: x-podder-pin
//   body: { prompt, aspect?: "1:1"|"2:3"|"3:2", image?: dataURL, strength?: 0..1 }
//   ->   { image: dataURL, mock?: true }
//
// Runs Flux on Replicate server-side so the API token never reaches the browser.
// With `image` set it does an img2img edit (Podder's ✎ Edit box); without, plain txt2img.
// If REPLICATE_API_TOKEN is unset (local preview / fresh deploy) it returns a mock
// placeholder image so the whole UI can be exercised without spending anything.

import { pinOk } from './auth.js';

export const maxDuration = 60;

const MODEL = 'black-forest-labs/flux-dev';

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

async function replicate(input, token) {
  const deadline = Date.now() + 50_000;   // stay inside the 60s function window

  // Accounts holding <$5 credit are throttled to 1 concurrent prediction (burst refills every
  // ~10s) — a 3-card Podder batch trips that instantly. On a throttle response, wait out the
  // refill and retry instead of failing the card; with credit on the account the first attempt
  // just succeeds and none of this runs.
  let pred;
  for (;;) {
    const create = await fetch(`https://api.replicate.com/v1/models/${MODEL}/predictions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'wait=30' },
      body: JSON.stringify({ input }),
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
  return Array.isArray(pred.output) ? pred.output[0] : pred.output;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!pinOk(req.headers['x-podder-pin'])) return res.status(401).json({ error: 'bad_pin' });

  const { prompt, aspect = '1:1', image, strength } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'missing_prompt' });

  // Tolerate the classic env-var paste accidents: surrounding whitespace/newlines, wrapping
  // quotes, or a copied "Bearer " prefix — all of which make Replicate reject the token.
  const token = (process.env.REPLICATE_API_TOKEN || '')
    .trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(200).json({ image: mockImage(prompt), mock: true });

  try {
    const isSchnell = MODEL.includes('schnell');
    const input = {
      prompt,
      aspect_ratio: ['1:1', '2:3', '3:2'].includes(aspect) ? aspect : '1:1',
      output_format: 'png',
      ...(isSchnell ? {} : { disable_safety_checker: false }),
    };
    if (image) {                       // img2img edit, anchored to the source picture
      input.image = image;             // data URL — Replicate accepts these directly
      const s = Math.min(0.95, Math.max(0.15, +strength || 0.5));
      if (isSchnell) input.image_prompt_strength = s;
      else input.prompt_strength = s;
    }
    const url = await replicate(input, token);

    // Replicate delivery URLs expire — hand the browser real bytes instead so favorites
    // and history (stored client-side in IndexedDB) keep working forever.
    const imgResp = await fetch(url);
    if (!imgResp.ok) throw new Error(`Image fetch failed (${imgResp.status})`);
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const type = imgResp.headers.get('content-type') || 'image/png';
    return res.status(200).json({ image: `data:${type};base64,${buf.toString('base64')}` });
  } catch (e) {
    return res.status(502).json({ error: 'render_failed', detail: String(e.message || e) });
  }
}
