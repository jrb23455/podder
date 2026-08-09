// GET /api/config  -> { supabaseUrl, anonKey, costs, packs, signupBonus, ready }
//
// Public by design: the anon key is a publishable client credential (RLS is what protects
// the data, and 0001_credits.sql locks both tables to owner-reads). Serving it from here
// instead of hardcoding it keeps environment config out of the 650KB static index.html,
// so preview and production deploys point at different projects without a code change.

import { CREDIT_COST, PACKS, SIGNUP_BONUS } from './_lib/config.js';
import { missingEnv, selectOne } from './_lib/server.js';

export default async function handler(req, res) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || '';

  // `ready` gates the sign-in UI. A merely non-empty value is not enough — if the URL is
  // malformed or the anon key isn't a real key, showing a sign-in form just produces a
  // form that silently cannot work. Better to fall back to the PIN gate and say why.
  const problems = missingEnv();
  if (!anonKey) problems.push('SUPABASE_ANON_KEY');
  else if (!anonKey.startsWith('eyJ') && !anonKey.startsWith('sb_publishable_')) {
    problems.push('SUPABASE_ANON_KEY (does not look like an anon/publishable key)');
  }

  // Launch promo counter, for the scarcity line on the sign-up screen. Best-effort: if the
  // table is missing or unreachable the page still renders, it just doesn't advertise it.
  let promo = null;
  if (problems.length === 0) {
    try {
      const row = await selectOne('promos', 'name=eq.launch&select=credits,remaining');
      if (row && row.remaining > 0) promo = { credits: row.credits, remaining: row.remaining };
    } catch { /* counter is decoration, never a blocker */ }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    supabaseUrl,
    anonKey,
    ready: problems.length === 0,
    problems,
    promo,
    signupBonus: SIGNUP_BONUS,
    costs: CREDIT_COST,
    packs: Object.entries(PACKS).map(([id, p]) => ({
      id, credits: p.credits, amount: p.amount, name: p.name, blurb: p.blurb,
    })),
  });
}
