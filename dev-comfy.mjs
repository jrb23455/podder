// Dev-only: renders /api/generate on the local ComfyUI instead of Replicate, so the real web
// page and its real prompts can be tested on this PC for free. Used by dev-server.mjs only;
// NOT deployed (listed in .vercelignore). Production rendering is api/generate.js, unchanged.
//
// Same request/response shape as api/generate.js: { prompt, aspect, image?, strength?, quality }
// -> { image: dataURL, credits: null, local: true }. Only the owner PIN is accepted, so nothing
// here ever touches Supabase or bills anyone.
//
// The model is the local one (flux1-dev fp8), not podder.dev's Flux 2, so pictures differ from
// the live site even though the prompt text is identical. Settings match the local Podder app
// (15 steps, guidance 7, 768 px) so results line up with past local audit renders.

import { pinMatches } from './api/_lib/server.js';

const COMFY = (process.env.COMFY_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
const UNET = process.env.COMFY_UNET || 'flux1-dev-fp8.safetensors';
const T5 = process.env.COMFY_T5 || 't5-v1_1-xxl-encoder-Q4_K_M.gguf';
const CLIP_L = process.env.COMFY_CLIP_L || 'clip_l.safetensors';
const VAE = process.env.COMFY_VAE || 'ae.safetensors';
const STEPS = { fast: 15, quality: 25 };
const GUIDANCE = 7;
const SIZES = { '1:1': [768, 768], '2:3': [640, 960], '3:2': [960, 640] };

export async function comfyAvailable() {
  try { return (await fetch(`${COMFY}/system_stats`, { signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
}

async function uploadImage(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('image must be a data URL');
  const fd = new FormData();
  fd.append('image', new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), `podderweb_src_${Date.now()}_${Math.floor(Math.random() * 1e6)}.png`);
  fd.append('type', 'input');
  fd.append('overwrite', 'true');
  const r = await fetch(`${COMFY}/upload/image`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`ComfyUI upload failed (${r.status})`);
  const j = await r.json();
  return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
}

function graph(prompt, { aspect, quality, imageName, denoise, seed, name }) {
  const [w, h] = SIZES[aspect] || SIZES['1:1'];
  const g = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'fp8_e4m3fn' } },
    '2': { class_type: /\.gguf$/i.test(T5) ? 'DualCLIPLoaderGGUF' : 'DualCLIPLoader', inputs: { clip_name1: T5, clip_name2: CLIP_L, type: 'flux' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: VAE } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': { class_type: 'FluxGuidance', inputs: { guidance: GUIDANCE, conditioning: ['4', 0] } },
    '8': { class_type: 'KSampler', inputs: { seed: Number.isInteger(seed) ? seed : Math.floor(Math.random() * 1e15), steps: STEPS[quality] || STEPS.fast, cfg: 1,
      sampler_name: 'euler', scheduler: 'simple', denoise: imageName ? denoise : 1,
      model: ['1', 0], positive: ['6', 0], negative: ['5', 0], latent_image: ['7', 0] } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'PodderWeb-local/' + (String(name || 'render').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'render'), images: ['9', 0] } },
  };
  if (imageName) {
    g['11'] = { class_type: 'LoadImage', inputs: { image: imageName } };
    g['7'] = { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['3', 0] } };
  } else {
    g['7'] = { class_type: 'EmptySD3LatentImage', inputs: { width: w, height: h, batch_size: 1 } };
  }
  return g;
}

async function render(prompt, opts) {
  const q = await fetch(`${COMFY}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph(prompt, opts), client_id: 'podderweb-dev' }),
  });
  const qj = await q.json().catch(() => ({}));
  if (!q.ok || !qj.prompt_id) throw new Error(`ComfyUI rejected the job: ${JSON.stringify(qj.node_errors || qj.error || q.status).slice(0, 200)}`);
  const id = qj.prompt_id;
  const deadline = Date.now() + 10 * 60_000;   // no 60 s Vercel cap locally; a busy queue can take a while
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
    const h = await fetch(`${COMFY}/history/${id}`).then(r => r.json()).catch(() => ({}));
    const e = h[id];
    if (e?.status?.status_str === 'error') throw new Error('ComfyUI render error (check its console)');
    for (const out of Object.values(e?.outputs || {})) {
      const img = out.images?.[0];
      if (!img) continue;
      const v = await fetch(`${COMFY}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'output')}`);
      if (!v.ok) throw new Error(`could not read the render (${v.status})`);
      return 'data:image/png;base64,' + Buffer.from(await v.arrayBuffer()).toString('base64');
    }
  }
  throw new Error('timed out waiting for ComfyUI');
}

// Drop-in for api/generate.js on the dev server.
export default async function comfyGenerate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!pinMatches(req.headers['x-podder-pin'])) {
    return res.status(401).json({ error: 'not_signed_in', detail: 'Local renders need the owner PIN from .env.local (default 2323).' });
  }
  const { prompt, aspect = '1:1', image, strength, quality = 'fast', seed, name } = req.body || {};   // seed/name: dev-only, for labelled same-seed A/B tests
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'missing_prompt' });
  try {
    // Same meaning as Replicate's prompt_strength: 0 keeps the image, 1 ignores it.
    const denoise = typeof strength === 'number' && strength > 0 && strength <= 1 ? strength : 0.62;
    const imageName = image ? await uploadImage(image) : null;
    const dataUrl = await render(prompt, { aspect, quality, imageName, denoise, seed, name });
    return res.status(200).json({ image: dataUrl, credits: null, renderId: null, local: true });
  } catch (e) {
    return res.status(502).json({ error: 'render_failed', detail: String(e.message || e), credits: null, refunded: false });
  }
}
