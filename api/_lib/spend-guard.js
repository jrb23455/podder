// Spend guard: keeps the provider bill bounded without ever limiting paying customers.
//
// Paying customers' renders are prepaid at more than they cost us, so they are counted but never
// limited. Free credits (signup bonus, anonymous trial) and the owner's unbilled renders are what
// could run up a bill, so each gets a daily budget of ESTIMATED provider spend (cents):
//   FREE_DAILY_BUDGET_CENTS   (default 500  = $5/day across all free users)
//   OWNER_DAILY_BUDGET_CENTS  (default 2000 = $20/day for the owner PIN)
//   SPIKE_RENDERS_PER_HOUR    (default 300; alerts once per hour, never blocks)
// Counters live in spend_counters / spend_hourly (migration 0014). If the counter itself fails,
// the render goes ahead: the guard must never be the reason a customer can't render.
import { rpc, selectOne, alert } from './server.js';

// Estimated provider cost per job, in cents (see generate.js / model3d.js header comments).
export const EST_CENTS = { fast: 1, quality: 4, model3d: 60 };

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };

async function hasPurchase(userId) {
  try {
    const row = await selectOne('credit_ledger', `user_id=eq.${userId}&reason=like.purchase*&select=id&limit=1`);
    return !!row;
  } catch { return false; }
}

// Returns { ok:true, bucket, cents } to go ahead, or { ok:false } when today's free/owner budget is spent.
export async function spendCheck({ owner, userId, kind }) {
  const cents = EST_CENTS[kind] ?? 1;
  const bucket = owner ? 'owner' : (await hasPurchase(userId)) ? 'paid' : 'free';
  const budget = bucket === 'paid' ? null
    : bucket === 'owner' ? num('OWNER_DAILY_BUDGET_CENTS', 2000) : num('FREE_DAILY_BUDGET_CENTS', 500);
  let r;
  try { r = await rpc('spend_add', { p_bucket: bucket, p_cents: cents, p_budget: budget }); }
  catch (e) { console.error('spend guard unavailable', e.message); return { ok: true, bucket: null, cents }; }

  if (!r?.ok) {
    if (!r?.paused_alerted) await alert(`${bucket}_budget_reached`, { budget_cents: budget, spent_cents: r?.total });
    return { ok: false, bucket };
  }
  const spike = num('SPIKE_RENDERS_PER_HOUR', 300);
  if (r.hour_renders > spike && !r.hour_alerted) {
    try { await rpc('spend_mark_spike', {}); } catch {}
    await alert('render_spike', { renders_this_hour: r.hour_renders, threshold: spike });
  }
  return { ok: true, bucket, cents };
}

// Give a failed job's estimate back so errors don't use up the budget.
export async function spendUndo(g) {
  if (!g?.bucket) return;
  try { await rpc('spend_undo', { p_bucket: g.bucket, p_cents: g.cents }); } catch {}
}
