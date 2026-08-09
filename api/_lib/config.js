// Single source of truth for what things cost. The client reads this via /api/me so the
// UI and the billing logic can never drift apart — change a number here and both follow.
//
// Underlying Replicate cost per 1024×1024 render (checked 2026-08-07):
//   flux-2-klein-4b  ~$0.014            -> "fast"
//   flux-2-pro        $0.015 + $0.015/MP -> ~$0.030 txt2img, ~$0.045 img2img (input MP billed too)
// Credits are priced at roughly 5× cost, which absorbs Stripe fees, Vercel, and Supabase
// while staying cheap enough that a hobbyist doesn't count renders.

export const CREDIT_COST = {
  fast: 1,
  quality: 3,
};

// Stripe charges 2.9% + $0.30, which is 18% of a $2 sale but only 3.6% of a $40 one —
// hence a $5 floor rather than the $2 pack that looked attractive on paper.
export const PACKS = {
  starter:  { credits: 60,  amount: 500,  name: 'Starter pack',  blurb: '60 credits'  },
  standard: { credits: 220, amount: 1500, name: 'Standard pack', blurb: '220 credits' },
  studio:   { credits: 700, amount: 4000, name: 'Studio pack',   blurb: '700 credits' },
};

// Mirrors handle_new_user() — currently set by 0002_signup_bonus_25.sql. The database
// grants the credits; this constant only advertises them, so the two must move together.
// Keep it below PACKS.starter.credits or the cheapest paid tier becomes unsellable.
export const SIGNUP_BONUS = 25;

export function creditsFor(quality) {
  return CREDIT_COST[quality] ?? CREDIT_COST.fast;
}
