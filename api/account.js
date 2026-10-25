// DELETE /api/account   headers: Authorization: Bearer <supabase access token>   -> { ok }
// PUT    /api/account   { avatar: "data:image/jpeg;base64,..." | null }             -> { ok, avatar }
//
// Lets a person delete their own account. Removing the auth user cascades to profiles,
// credit_ledger and model3d_tasks (all reference auth.users on delete cascade). Stripe keeps its
// own payment records, which is required for tax and refunds; nothing here touches them.
// Images were never stored server-side, so there is nothing else to erase.
//
// PUT sets or clears the profile picture shown on the top-right profile button. The client resizes
// it to 128x128 before upload; the size and type are re-checked here and by a column constraint
// (migration 0011). Lives in this file because the Vercel Hobby plan caps the project at 12 functions.

import { getUser, missingEnv, alert } from './_lib/server.js';

const AVATAR_MAX = 60000;   // characters of data URL; a 128px JPEG is ~5-15 KB
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

async function setAvatar(req, res, user) {
  if (user.anonymous) return res.status(403).json({ error: 'trial_account', detail: 'Create an account to add a profile picture.' });
  const avatar = (req.body || {}).avatar ?? null;
  if (avatar !== null && (typeof avatar !== 'string' || avatar.length > AVATAR_MAX || !AVATAR_RE.test(avatar))) {
    return res.status(400).json({ error: 'bad_avatar', detail: 'Use a JPEG, PNG or WebP image.' });
  }
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const r = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ avatar }),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 200);
    return res.status(502).json({ error: 'save_failed', detail });
  }
  return res.status(200).json({ ok: true, avatar });
}

export default async function handler(req, res) {
  if (req.method !== 'DELETE' && req.method !== 'PUT') return res.status(405).json({ error: 'method_not_allowed' });

  const missing = missingEnv();
  if (missing.length) return res.status(500).json({ error: 'server_not_configured' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'not_signed_in' });
  if (req.method === 'PUT') return setAvatar(req, res, user);

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
