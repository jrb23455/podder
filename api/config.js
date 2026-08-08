// GET /api/config  -> { supabaseUrl, anonKey, costs, packs, signupBonus, ready }
//
// Public by design: the anon key is a publishable client credential (RLS is what protects
// the data, and 0001_credits.sql locks both tables to owner-reads). Serving it from here
// instead of hardcoding it keeps environment config out of the 650KB static index.html,
// so preview and production deploys point at different projects without a code change.

import { CREDIT_COST, PACKS, SIGNUP_BONUS } from './_lib/config.js';

export default function handler(req, res) {
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY || '';

  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    supabaseUrl,
    anonKey,
    ready: !!(supabaseUrl && anonKey),
    signupBonus: SIGNUP_BONUS,
    costs: CREDIT_COST,
    packs: Object.entries(PACKS).map(([id, p]) => ({
      id, credits: p.credits, amount: p.amount, name: p.name, blurb: p.blurb,
    })),
  });
}
