// Served at /api/admin/alerts via a vercel.json rewrite to /api/admin/grant?op=alerts: the Hobby
// plan allows 12 functions, so the two owner endpoints share one.
// GET  /api/admin/alerts            x-podder-pin  -> { alerts: [...], unseen }
// POST /api/admin/alerts {seen:true} x-podder-pin -> { ok }   mark everything seen
//
// Owner-only view of ops_alerts (failed refunds, payments not credited, dropped webhooks).

import { checkOwnerPin, missingEnv } from './server.js';

const URL_ = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const H = () => ({ apikey: KEY(), Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' });

export default async function alertsHandler(req, res) {
  const pin = await checkOwnerPin(req);
  if (pin === 'locked') return res.status(429).json({ error: 'too_many_attempts' });
  if (pin !== 'ok') return res.status(403).json({ error: 'forbidden' });
  if (missingEnv().length) return res.status(500).json({ error: 'server_not_configured' });

  if (req.method === 'POST') {
    if (!req.body?.seen) return res.status(400).json({ error: 'nothing_to_do' });
    const r = await fetch(`${URL_()}/rest/v1/ops_alerts?seen=eq.false`, {
      method: 'PATCH', headers: { ...H(), Prefer: 'return=minimal' }, body: JSON.stringify({ seen: true }),
    });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const r = await fetch(`${URL_()}/rest/v1/ops_alerts?select=id,kind,detail,seen,created_at&order=created_at.desc&limit=50`, { headers: H() });
  const alerts = r.ok ? await r.json() : [];
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ alerts, unseen: alerts.filter(a => !a.seen).length });
}
