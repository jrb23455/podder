// POST /api/model3d            { image: dataURL }        -> { taskId, credits }   create the mesh
// POST /api/model3d            { convert: taskId }       -> { taskId }            GLB -> STL (reused if already made)
// POST /api/model3d            { refund: taskId }        -> { credits }           refund a failed job
// GET  /api/model3d?task=<id>                            -> { status, progress, glb?, stl?, refunded? }
//
// Turns a Podder render into a downloadable printable mesh via Tripo.
//
// WHY THIS IS SPLIT ACROSS CALLS: Tripo generation takes minutes and Vercel functions cap at
// 60s (see maxDuration in generate.js), so a single request cannot create-and-wait. The client
// creates a task, polls GET until it succeeds, then asks for the STL conversion. Tripo returns
// GLB from every generation endpoint; STL only exists as a separate convert task.
//
// BILLING: same debit-first rule as generate.js — charge on create, refund if the task fails.
// model3d_tasks (0009) records which account paid for each task. Convert and refund are refused
// for tasks the caller did not pay for, and the ledger ref (refund3d:<task>) makes a refund
// apply at most once no matter how many paths try it.

import { getUser, debit, credit, isInsufficient, missingEnv, checkOwnerPin, alert } from './_lib/server.js';
import { spendCheck, spendUndo } from './_lib/spend-guard.js';
import { MODEL3D_COST } from './_lib/config.js';
import { createHash } from 'node:crypto';

export const maxDuration = 60;

// Tripo V3. V2 (api.tripo3d.ai/v2/openapi, one /task endpoint with a `type` field) is retired
// on 2026-10-31. V3 has one endpoint per job, takes every file/task reference as `input`, and
// returns results under output.model_url. Keys and task ids are shared between the two.
const TRIPO_BASE = 'https://openapi.tripo3d.ai/v3';

// Required on V3. Since 2026-10-23: v3.1-20260211 with "detailed" geometry. Same-image A/B on a DMT
// shaman: v2.5-20250123 (standard) smoothed away every surface pattern, v3.1 detailed kept them
// (Podder/_qc_tools/sheets/shaman_tripo_compare.png). Cost 40 Tripo credits to generate + 10 to
// convert = 50 ($0.50) vs 30 before; the STL is ~2M triangles (~100 MB) vs ~0.5M (~25 MB).
// Roll back with TRIPO_MODEL=v2.5-20250123 and TRIPO_QUALITY=standard.
const GEN_MODEL = (process.env.TRIPO_MODEL || 'v3.1-20260211').trim();
const GEN_QUALITY = (process.env.TRIPO_QUALITY || 'detailed').trim();   // "detailed" is v3.x only

// Tripo meshes come out normalised to a ~1-unit cube, which slicers read as 1 mm. Scaling at the
// convert step makes the STL land on the plate at a printable size (longest side, in mm).
const STL_SIZE_MM = Number(process.env.STL_SIZE_MM) || 80;
// Triangle cap for the downloadable STL (0 = Tripo's full mesh). See the convert step.
const STL_FACE_LIMIT = Number(process.env.STL_FACE_LIMIT ?? 500000);

// Each STL conversion is its own paid Tripo task (~$0.05), so a mesh gets a fixed number.
const MAX_CONVERTS = 3;

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

// ---- who paid for which task (model3d_tasks, service role only) ----
const SB = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SK = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const sbH = extra => ({ apikey: SK(), Authorization: `Bearer ${SK()}`, 'Content-Type': 'application/json', ...(extra || {}) });

async function getTaskRow(taskId) {
  const r = await fetch(`${SB()}/rest/v1/model3d_tasks?task_id=eq.${encodeURIComponent(taskId)}&select=*`, { headers: sbH() });
  if (!r.ok) throw new Error('task lookup failed');
  return (await r.json())[0] || null;
}
async function insertTaskRow(row) {
  const r = await fetch(`${SB()}/rest/v1/model3d_tasks`, {
    method: 'POST', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error('task record failed');
}
async function patchTaskRow(taskId, patch) {
  await fetch(`${SB()}/rest/v1/model3d_tasks?task_id=eq.${encodeURIComponent(taskId)}`, {
    method: 'PATCH', headers: sbH({ Prefer: 'return=minimal' }), body: JSON.stringify(patch),
  });
}

// Refund a failed paid task. Safe to call from every path (poll, client, /api/me): the ledger ref
// makes the credit idempotent. Returns the new balance, or null when nothing was refunded.
async function refundFailedTask(row) {
  if (!row || !row.user_id || row.refunded) return null;
  try {
    const balance = await credit(row.user_id, MODEL3D_COST, 'refund:model3d', `refund3d:${row.task_id}`);
    await patchTaskRow(row.task_id, { refunded: true });
    return balance;
  } catch (e) {
    await alert('model3d_refund_failed', { user: row.user_id, task: row.task_id, error: String(e.message || e) });
    return null;
  }
}

const isDead = s => s === 'failed' || s === 'cancelled' || s === 'banned' || s === 'expired';

// Used by /api/me: settle a user's paid tasks that failed while nobody was watching (tab
// closed, session expired mid-job). Only a handful of older, unsettled tasks per call.
export async function settleStaleTasks(userId) {
  const token = (process.env.TRIPO_API_KEY || '').trim();
  if (!token || !userId) return;
  const before = new Date(Date.now() - 10 * 60_000).toISOString();
  const r = await fetch(`${SB()}/rest/v1/model3d_tasks?user_id=eq.${userId}&refunded=eq.false&stl_task_id=is.null` +
    `&created_at=lt.${before}&order=created_at.desc&limit=5&select=*`, { headers: sbH() });
  if (!r.ok) return;
  for (const row of await r.json()) {
    try {
      const t = readTask(await tripo(`/tasks/${encodeURIComponent(row.task_id)}`, token));
      if (isDead(t.status)) await refundFailedTask(row);
    } catch { /* try again next time */ }
  }
}

// Tripo wants an uploaded file token rather than an inline data URL.
async function uploadImage(dataUrl, token) {
  // V3 /files takes PNG and JPEG only (V2 also took WebP).
  const m = /^data:(image\/(png|jpe?g));base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('image must be a png/jpeg data URL');
  const bytes = Buffer.from(m[3], 'base64');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('image too large (20MB max)');

  const ext = m[2].toLowerCase().startsWith('jp') ? 'jpeg' : m[2].toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: m[1] }), `podder.${ext}`);
  const data = await tripo('/files', token, { method: 'POST', body: form });
  const fileToken = data.image_token || data.file_token || data.token;
  if (!fileToken) throw new Error('Tripo upload returned no file token');
  return { fileToken };
}

const createTask = (path, body, token) =>
  tripo(path, token, {
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
    status: d.status,                                  // queued | running | success | failed | cancelled
    progress: typeof d.progress === 'number' ? d.progress : null,
    glb: pick('model_url', 'pbr_model', 'model', 'base_model'),
    stl: pick('model_url', 'stl', 'converted_model', 'model'),
    error: d.status === 'failed' || d.status === 'banned' ? (d.error_message || d.message || 'Tripo task failed') : null,
  };
}

export default async function handler(req, res) {
  const token = (process.env.TRIPO_API_KEY || '').trim();
  if (!token) {
    return res.status(500).json({ error: 'server_not_configured', detail: 'Set TRIPO_API_KEY.' });
  }

  // ---- poll ----
  if (req.method === 'GET') {
    // Owner-only balance readout, so mesh cost can be measured rather than guessed at.
    // Gated behind the PIN because it exposes account spend.
    if (req.query.balance !== undefined) {
      if ((await checkOwnerPin(req)) !== 'ok') return res.status(401).json({ error: 'owner_only' });
      try {
        return res.status(200).json(await tripo('/account/balance', token));
      } catch (e) {
        return res.status(502).json({ error: 'tripo_failed', detail: String(e.message || e) });
      }
    }

    const id = String(req.query.task || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_task' });
    try {
      const t = readTask(await tripo(`/tasks/${encodeURIComponent(id)}`, token));
      if (isDead(t.status)) {
        // A failed paid mesh is refunded here, by whoever polls it, so the refund does not
        // depend on the buyer's tab staying open or their session staying fresh.
        try { t.refunded = (await refundFailedTask(await getTaskRow(id))) !== null; } catch { /* /api/me retries */ }
      }
      return res.status(200).json(t);
    } catch (e) {
      return res.status(502).json({ error: 'tripo_failed', detail: String(e.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

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

  const { image, convert, refund } = req.body || {};

  try {
    // ---- STL conversion: included in the mesh price, limited per mesh ----
    if (convert) {
      const id = String(convert);
      const row = await getTaskRow(id);
      if (!owner && (!row || row.user_id !== user.id)) return res.status(403).json({ error: 'not_your_model' });
      // An STL already made for this mesh is reused; polling it hands back a fresh link.
      if (row?.stl_task_id && !req.body?.fresh) return res.status(200).json({ taskId: row.stl_task_id, reused: true });
      if (!owner && row.converts >= MAX_CONVERTS) return res.status(429).json({ error: 'convert_limit' });
      // v3.1 "detailed" meshes are ~2M triangles (~100 MB): slicers like Flash Studio freeze loading them.
      // Capped at the convert step; 500k keeps the visible detail at 80 mm (shaman test 2026-10-23).
      const base = { input: id, format: 'STL', scale_factor: STL_SIZE_MM, pivot_to_center_bottom: true };
      let d;
      try {
        d = await createTask('/models/convert', { ...base, ...(STL_FACE_LIMIT ? { face_limit: STL_FACE_LIMIT } : {}) }, token);
      } catch (e) {
        // face_limit on convert was never confirmed against Tripo's API; if it is refused, still hand over the full mesh.
        if (!STL_FACE_LIMIT) throw e;
        console.warn('convert with face_limit refused, retrying without:', String(e.message || e));
        d = await createTask('/models/convert', base, token);
      }
      const stlId = d.task_id || d.taskId;
      if (row) await patchTaskRow(id, { converts: row.converts + 1, stl_task_id: stlId });
      return res.status(200).json({ taskId: stlId });
    }

    // ---- refund a failed job: only the buyer, only once, verified against Tripo ----
    if (refund) {
      if (!user) return res.status(200).json({ credits: null });
      const row = await getTaskRow(String(refund));
      if (!row || row.user_id !== user.id) return res.status(403).json({ error: 'not_your_model' });
      const t = readTask(await tripo(`/tasks/${encodeURIComponent(String(refund))}`, token));
      if (!isDead(t.status)) return res.status(409).json({ error: 'task_not_failed', status: t.status });
      return res.status(200).json({ credits: await refundFailedTask(row) });
    }

    // ---- create the mesh ----
    if (!image) return res.status(400).json({ error: 'missing_image' });

    // A render refunded through "Report a bad render" cannot be turned into a model.
    {
      const b64 = /^data:image\/[a-z]+;base64,(.+)$/i.exec(String(image));
      if (b64) {
        const sha = createHash('sha256').update(Buffer.from(b64[1], 'base64')).digest('hex');
        const rr = await fetch(`${SB()}/rest/v1/renders?image_sha=eq.${sha}&refunded=eq.true&select=id&limit=1`, { headers: sbH() });
        if (rr.ok && (await rr.json()).length) {
          return res.status(403).json({ error: 'render_refunded', detail: 'This render was refunded, so it cannot be made into a 3D model.' });
        }
      }
    }

    // Daily budget for free-credit and owner models; paying customers are never limited.
    const guard = await spendCheck({ owner, userId: user?.id, kind: 'model3d' });
    if (!guard.ok) return res.status(429).json({ error: 'free_budget_paused', detail: 'Free renders are paused for today. Buy credits to keep going, or come back tomorrow.' });

    const { fileToken } = await uploadImage(image, token);

    let balance = null;
    if (user) {
      try {
        // Charged before the task is created. If creation then throws we refund immediately
        // below; if the task itself fails later, the poll or /api/me refunds it.
        balance = await debit(user.id, MODEL3D_COST, 'model3d', `model3d:${fileToken}`);
      } catch (e) {
        if (isInsufficient(e)) return res.status(402).json({ error: 'insufficient_credits', needed: MODEL3D_COST });
        return res.status(500).json({ error: 'billing_failed', detail: String(e.message || e) });
      }
    }

    let taskId;
    try {
      // texture/pbr OFF by default: the deliverable is an STL, and STL stores geometry only —
      // it cannot carry colour or materials, so every credit spent texturing is thrown away at
      // the convert step. V3 defaults both to true, so they are always sent.
      // Set TRIPO_TEXTURE=1 to turn them back on.
      const wantTexture = process.env.TRIPO_TEXTURE === '1';
      const d = await createTask('/generation/image-to-model', {
        input: fileToken,
        model: GEN_MODEL,
        texture: wantTexture,
        pbr: wantTexture,
        ...(GEN_QUALITY === 'detailed' && GEN_MODEL.startsWith('v3') ? { geometry_quality: 'detailed' } : {}),
      }, token);
      taskId = d.task_id || d.taskId;
    } catch (e) {
      await spendUndo(guard);
      if (user) {
        try { balance = await credit(user.id, MODEL3D_COST, 'refund:model3d', `refund3d:create:${fileToken}`); }
        catch (re) { await alert('model3d_refund_failed', { user: user.id, stage: 'create', error: String(re.message || re) }); }
      }
      throw e;
    }

    try { await insertTaskRow({ task_id: taskId, user_id: user ? user.id : null }); }
    catch (e) { await alert('model3d_task_unrecorded', { taskId, user: user ? user.id : null, error: String(e.message || e) }); }
    return res.status(200).json({ taskId, credits: balance });
  } catch (e) {
    return res.status(502).json({ error: 'tripo_failed', detail: String(e.message || e), refunded: !!user && !convert && !refund });
  }
}
