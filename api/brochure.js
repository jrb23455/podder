// GET  /api/brochure                         -> { data }   owner edits to the public e-brochure
// POST /api/brochure  { data }  x-podder-pin -> { ok }     replace them (owner only)
//
// The brochure itself is static (brochure.html + brochure/data.json + brochure/img). This only
// stores what the owner changed on top of it: hidden tiles, cover picks and edited text. One row
// in brochure_overrides (0008), reachable only with the service-role key.

import { missingEnv, checkOwnerPin } from './_lib/server.js';

const URL_ = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = () => ({ apikey: KEY(), Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' });

// Keeps a typo'd or hostile payload from bloating the row; the real thing is a few KB.
const MAX_BYTES = 200_000;

function clean(d) {
  const strList = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length < 200).slice(0, 5000) : []);
  const text = {};
  if (d && typeof d.text === 'object' && d.text) {
    for (const [k, v] of Object.entries(d.text)) {
      if (typeof k === 'string' && k.length < 100 && typeof v === 'string') text[k] = v.slice(0, 600);
    }
  }
  return { hidden: strList(d?.hidden), cover: strList(d?.cover).slice(0, 40), text };
}

export default async function handler(req, res) {
  const missing = missingEnv();
  if (missing.length) return res.status(500).json({ error: 'server_not_configured', detail: missing.join(', ') });

  if (req.method === 'GET') {
    const r = await fetch(`${URL_()}/rest/v1/brochure_overrides?id=eq.1&select=data,updated_at`, { headers: H() });
    const rows = r.ok ? await r.json().catch(() => []) : [];
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ data: rows[0]?.data || {}, updated_at: rows[0]?.updated_at || null });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if ((await checkOwnerPin(req)) !== 'ok') return res.status(401).json({ error: 'owner_only' });

  const data = clean(req.body?.data);
  if (JSON.stringify(data).length > MAX_BYTES) return res.status(413).json({ error: 'too_large' });

  const r = await fetch(`${URL_()}/rest/v1/brochure_overrides?id=eq.1`, {
    method: 'PATCH',
    headers: { ...H(), Prefer: 'return=minimal' },
    body: JSON.stringify({ data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) return res.status(502).json({ error: 'save_failed', detail: (await r.text()).slice(0, 200) });
  return res.status(200).json({ ok: true });
}
