// POST /api/admin/grant  { email, credits, reason }
//   headers: x-podder-pin: <owner pin>
//   -> { ok, balance, email, credits }
//
// Owner-only. Grants (positive) or deducts (negative) credits to an account by email.
// No idempotency ref — this is a manual action and each call is intentional.

import { credit, debit, isInsufficient, missingEnv, checkOwnerPin, selectOne } from '../_lib/server.js';
import alertsHandler from '../_lib/admin-alerts.js';

export default async function handler(req, res) {
  if (req.query?.op === 'alerts') return alertsHandler(req, res);   // /api/admin/alerts (rewrite)
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const pin = await checkOwnerPin(req);
  if (pin === 'locked') return res.status(429).json({ error: 'too_many_attempts' });
  if (pin !== 'ok') return res.status(403).json({ error: 'forbidden' });

  const missing = missingEnv();
  if (missing.length) return res.status(500).json({ error: 'server_not_configured', detail: `Missing: ${missing.join(', ')}` });

  const rawCredits = Number(req.body?.credits);
  const email      = String(req.body?.email  || '').trim().toLowerCase();
  const reason     = String(req.body?.reason || 'admin_grant').trim().slice(0, 60) || 'admin_grant';

  if (!email) return res.status(400).json({ error: 'email_required' });
  if (!Number.isInteger(rawCredits) || rawCredits === 0) {
    return res.status(400).json({ error: 'credits must be a non-zero integer' });
  }

  // profiles carries every account's email (backfilled on sign-up and on anonymous upgrade),
  // so look the account up there. The GoTrue admin list endpoint ignores an email filter and
  // just returns the first page of users, which is why the old lookup missed most accounts.
  const profile = await selectOne('profiles', `email=ilike.${encodeURIComponent(email.replace(/[\%_*]/g, c => "\\" + c))}&select=id,email`);
  if (!profile?.id) return res.status(404).json({ error: 'user_not_found', email });

  try {
    const balance = rawCredits > 0
      ? await credit(profile.id, rawCredits, reason, null)
      : await debit(profile.id, -rawCredits, reason, null);   // guarded: never below zero
    return res.status(200).json({ ok: true, balance, email, credits: rawCredits });
  } catch (e) {
    if (isInsufficient(e)) return res.status(400).json({ error: 'not_enough_credits_to_remove' });
    return res.status(500).json({ error: 'grant_failed', detail: String(e.message || e) });
  }
}
