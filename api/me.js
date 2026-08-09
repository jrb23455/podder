// GET /api/me   headers: Authorization: Bearer <supabase access token>
//   -> { email, credits, costs, packs, recent: [...] }
//
// The client calls this on load and after every render to keep the credit chip honest.
// It also ships the price list so the buy-credits UI is generated from server config
// rather than hardcoded in the 650KB index.html.

import { getUser, selectOne, missingEnv } from './_lib/server.js';
import { CREDIT_COST, PACKS } from './_lib/config.js';

export default async function handler(req, res) {
  const missing = missingEnv();
  if (missing.length) {
    return res.status(500).json({ error: 'server_not_configured', detail: `Missing: ${missing.join(', ')}` });
  }

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'not_signed_in' });

  const profile = await selectOne('profiles', `id=eq.${user.id}&select=credits`);

  // A profile is created by the on_auth_user_created trigger. If it is somehow absent
  // (trigger not installed yet), report zero rather than 500 — the UI still renders and
  // the buy button still works, which is the more useful failure mode.
  const credits = profile?.credits ?? 0;

  let recent = [];
  try {
    const r = await fetch(
      `${(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/rest/v1/credit_ledger` +
      `?user_id=eq.${user.id}&select=delta,reason,created_at&order=created_at.desc&limit=20`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (r.ok) recent = await r.json();
  } catch { /* the ledger is a nicety; a failure here must not block the balance */ }

  return res.status(200).json({
    email: user.email,
    anonymous: user.anonymous,
    credits,
    costs: CREDIT_COST,
    packs: Object.entries(PACKS).map(([id, p]) => ({
      id, credits: p.credits, amount: p.amount, name: p.name, blurb: p.blurb,
    })),
    recent,
  });
}
