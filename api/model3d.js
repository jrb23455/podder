// POST /api/model3d            { image: dataURL }        -> { taskId, credits }   create the mesh
// POST /api/model3d            { convert: taskId }       -> { taskId }            GLB -> STL
// POST /api/model3d            { refund: taskId }        -> { credits }           refund a failed job
// GET  /api/model3d?task=<id>                            -> { status, progress, glb?, stl? }
//
// Turns a Podder render into a downloadable printable mesh via Tripo.
//
// WHY THIS IS SPLIT ACROSS CALLS: Tripo generation takes minutes and Vercel functions cap at
// 60s (see maxDuration in generate.js), so a single request cannot create-and-wait. The client
// creates a task, polls GET until it succeeds, then asks for the STL conversion. Tripo returns
// GLB from every generation endpoint; STL only exists as a separate convert_model task.
//
// BILLING: same debit-first rule as generate.js — charge on create, refund if the task fails.
// The ledger ref is derived from the Tripo task id, so a refund can never double-apply even if
// the client retries it.

import { pinOk } from './auth.js';
import { getUser, debit, credit, isInsufficient, missingEnv } from './_lib/server.js';
import { MODEL3D_COST } from './_lib/config.js';

export const maxDuration = 60;

// VERIFY THESE AGAINST YOUR TRIPO DASHBOARD BEFORE GOING LIVE. Tripo has shipped both a
// /v2/openapi surface and a newer versioned one; the paths below are the v2 shape. They are
// isolated here so correcting them is a one-line change rather than a rewrite.
const TRIPO_BASE = process.env.TRIPO_API_BASE || 'https://api.tripo3d.ai/v2/openapi';

// Known-valid values on the v2 task endpoint: v2.5-20250123, v2.0-20240919, v1.4-20240625.
// A v3.x string here fails with "The version value is invalid" — v3 is a different surface
// (/v3/generation/image-to-model, no `type` field), not just a newer version tag on v2.
// Set TRIPO_MODEL to "none" to omit the field entirely and take Tripo's own default.
const GEN_MODEL = (process.env.TRIPO_MODEL ?? 'v2.5-20250123').trim();

const authHeader = token => ({ Authorization: `Bearer ${token}` });

async function tripo(path, token, init = {}) {
  const r = await fetch(`${TRIPO_BASE}${path}`, {
    ...init,
    headers: { ...authHeader(token), ...(init.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code !== undefined && j.code !== 0)) {
    throw new Error(j.message || j.suggestion || `Tripo ${r.status}`);
  }
  return j.data ?? j;
}

// Tripo wants an uploaded file token rather than an inline data URL.
async function uploadImage(dataUrl, token) {
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('image must be a png/jpeg/webp data URL');
  const bytes = Buffer.from(m[3], 'base64');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('image too large (20MB max)');

  const ext = m[2].toLowerCase().startsWith('jp') ? 'jpeg' : m[2].toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: m[1] }), `podder.${ext}`);
  const data = await tripo('/upload', token, { method: 'POST', body: form });
  const fileToken = data.image_token || data.file_token || data.token;
  if (!fileToken) throw new Error('Tripo upload returned no file token');
  return { fileToken, ext };
}

const createTask = (body, token) =>
  tripo('/task', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// Normalise Tripo's task payload — output field names have varied across their model versions,
// so probe the handful of shapes rather than trusting one.
function readTask(d) {
  const out = d.output || d.result || {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = out[k];
      if (typeof v === 'string' && v) return v;
      if (v && typeof v === 'object' && typeof v.url === 'string') return v.url;
    }
    return null;
  };
  return {
    status: d.status,                                  // queued | running | success | failed | banned | expired
    progress: typeof d.progress === 'number' ? d.progress : null,
    glb: pick('pbr_model', 'model', 'base_model'),
    stl: pick('stl', 'converted_model', 'model'),
    error: d.status === 'failed' || d.status === 'banned' ? (d.message || 'Tripo task failed') : null,
  };
}

export default async function handler(req, res) {
  const token = (process.env.TRIPO_API_KEY || '').trim();
  if (!token) {
    return res.status(500).json({ error: 'server_not_configured', detail: 'Set TRIPO_API_KEY.' });
  }

  // ---- poll (no side effects, so it is safe to hammer) ----
  if (req.method === 'GET') {
    // Owner-only balance readout, so mesh cost can be measured rather than guessed at from
    // vendor comparison blogs (which disagree wildly). Gated behind the PIN because it exposes
    // account spend.
    if (req.query.balance !== undefined) {
      if (!pinOk(req.headers['x-podder-pin'])) return res.status(401).json({ error: 'owner_only' });
      try {
        return res.status(200).json(await tripo('/user/balance', token));
      } catch (e) {
        return res.status(502).json({ error: 'tripo_failed', detail: String(e.message || e) });
      }
    }

    const id = String(req.query.task || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_task' });
    try {
      return res.status(200).json(readTask(await tripo(`/task/${encodeURIComponent(id)}`, token)));
    } catch (e) {
      return res.status(502).json({ error: 'tripo_failed', detail: String(e.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const owner = pinOk(req.headers['x-podder-pin']);
  let user = null;
  if (!owner) {
    const missing = missingEnv();
    if (missing.length) return res.status(500).json({ error: 'server_not_configured', detail: `Missing: ${missing.join(', ')}` });
    user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'not_signed_in' });
  }

  const { image, convert, refund } = req.body || {};

  try {
    // ---- STL conversion: already paid for as part of the original mesh ----
    if (convert) {
      const d = await createTask({ type: 'convert_model', format: 'STL', original_model_task_id: String(convert) }, token);
      return res.status(200).json({ taskId: d.task_id || d.taskId });
    }

    // ---- refund a failed job; verified against Tripo, idempotent via the ledger ref ----
    if (refund) {
      if (!user) return res.status(200).json({ credits: null });
      const t = readTask(await tripo(`/task/${encodeURIComponent(String(refund))}`, token));
      if (t.status !== 'failed' && t.status !== 'banned' && t.status !== 'expired') {
        return res.status(409).json({ error: 'task_not_failed', status: t.status });
      }
      let balance = null;
      try {
        balance = await credit(user.id, MODEL3D_COST, 'refund:model3d', `refund3d:${refund}`);
      } catch (e) {
        console.error('3d refund failed', { user: user.id, task: refund, error: String(e.message || e) });
      }
      return res.status(200).json({ credits: balance });
    }

    // ---- create the mesh ----
    if (!image) return res.status(400).json({ error: 'missing_image' });

    const { fileToken, ext } = await uploadImage(image, token);

    let balance = null;
    if (user) {
      try {
        // Charged before the task is created. If creation then throws we refund immediately
        // below; if the task itself fails later the client calls { refund }.
        balance = await debit(user.id, MODEL3D_COST, 'model3d', `model3d:${fileToken}`);
      } catch (e) {
        if (isInsufficient(e)) return res.status(402).json({ error: 'insufficient_credits', needed: MODEL3D_COST });
        return res.status(500).json({ error: 'billing_failed', detail: String(e.message || e) });
      }
    }

    try {
      // texture/pbr OFF by default: the deliverable is an STL, and STL stores geometry only —
      // it cannot carry colour or materials, so every credit spent texturing is thrown away at
      // the convert step. Tripo returns the untextured result as base_model instead of
      // pbr_model, which readTask() already handles. Set TRIPO_TEXTURE=1 to turn it back on
      // (only worth it if GLB with materials ever becomes a deliverable in its own right).
      const wantTexture = process.env.TRIPO_TEXTURE === '1';
      const d = await createTask({
        type: 'image_to_model',
        ...(GEN_MODEL && GEN_MODEL !== 'none' ? { model_version: GEN_MODEL } : {}),
        file: { type: ext, file_token: fileToken },
        texture: wantTexture,
        pbr: wantTexture,
      }, token);
      return res.status(200).json({ taskId: d.task_id || d.taskId, credits: balance });
    } catch (e) {
      if (user) {
        try { balance = await credit(user.id, MODEL3D_COST, 'refund:model3d', `refund3d:create:${fileToken}`); } catch {}
      }
      throw e;
    }
  } catch (e) {
    return res.status(502).json({ error: 'tripo_failed', detail: String(e.message || e), refunded: !!user });
  }
}
