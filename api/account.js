// DELETE /api/account   headers: Authorization: Bearer <supabase access token>   -> { ok }
//
// Lets a person delete their own account. Removing the auth user cascades to profiles,
// credit_ledger and model3d_tasks (all reference auth.users on delete cascade). Stripe keeps its
// own payment records, which is required for tax and refunds; nothing here touches them.
// Images were never stored server-side, so there is nothing else to erase.

import { getUser, missingEnv, alert } from './_lib/server.js';

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'method_not_allowed' });

  const missing = missingEnv();
  if (missing.length) return res.status(500).json({ error: 'server_not_configured' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'not_signed_in' });

  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const r = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 200);
    await alert('account_delete_failed', { user: user.id, status: r.status, detail });
    return res.status(502).json({ error: 'delete_failed' });
  }
  return res.status(200).json({ ok: true });
}
