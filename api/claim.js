// POST /api/claim  { session_id }
//   headers: Authorization: Bearer <supabase access token>
//   -> { ok, credits }
//
// The browser calls this the moment it lands back on the success URL. It exists so a
// purchase is not hostage to webhook delivery: if Stripe's webhook is slow, misconfigured,
// or the endpoint was never registered, the customer still gets their credits the instant
// they return from checkout.
//
// Safe to run alongside the webhook — fulfillSession() re-verifies against Stripe and
// credit_credits() is idempotent on the session id, so whichever arrives second is a no-op.
// A user can only claim a session whose metadata names them.

import { getUser, fulfillSession, selectOne, missingEnv } from './_lib/server.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const missing = missingEnv();
  if (missing.length) return res.status(500).json({ error: 'server_not_configured' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'stripe_not_configured' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'not_signed_in' });

  const sessionId = String(req.body?.session_id || '');
  if (!sessionId) return res.status(400).json({ error: 'missing_session_id' });

  const result = await fulfillSession(sessionId, user.id);

  if (result.ok) return res.status(200).json({ ok: true, credits: result.balance });

  // Not an error worth alarming the user about: the webhook may simply have won the race,
  // in which case the balance is already correct. Report the current balance either way.
  const profile = await selectOne('profiles', `id=eq.${user.id}&select=credits`);
  return res.status(result.retry ? 503 : 200).json({
    ok: false,
    reason: result.reason,
    credits: profile?.credits ?? null,
  });
}
