// Single source of truth for what things cost. The client reads this via /api/me so the
// UI and the billing logic can never drift apart — change a number here and both follow.
//
// Underlying cost per ~1 MP render (models switched 2026-10-22, see api/generate.js):
//   fast    FLUX 3 Image Klein, BFL API      ~$0.005 measured (20 renders = 9.9 BFL credits)
//   quality FLUX 3 Image, Replicate          ~$0.04 (owner's figure; confirm on Replicate billing)
// Before: flux-2-klein-4b ~$0.014 (fast), flux-2-pro ~$0.030 (quality).
// A credit nets ~$0.026-0.030 after Stripe (Studio vs Starter). Fast at 1 credit: ~80%+ margin.
// Quality at 4 credits keeps the ~61-67% margin Quality had on Flux 2 pro at 3 credits.
// (The old "5x cost" rule would put Quality at 6-7 credits, which felt too expensive.)

export const CREDIT_COST = {
  fast: 1,
  quality: 4,
};

// What a downloadable 3D mesh costs (api/model3d.js -> Tripo image-to-3D + STL convert).
//
// MEASURED 2026-10-16 against a live Tripo account, balance read before and after:
//   20 credits to generate (texture:false) + 5 to convert to STL = 25 credits = $0.25
//   plus ~$0.014 for the Flux image it is built from  ->  ~$0.264 per mesh
// RE-MEASURED 2026-10-19 after moving to Tripo V3 (V2 retired 2026-10-31): generation is still
// 20 credits but V3's convert is 10, so 30 credits = $0.30 + Flux = ~$0.314 per mesh. At 30
// Podder credits that is ~66% Starter / ~59% Studio after Stripe (the old "25 credits" row
// below). Kept at 30; revisit if Tripo prices move again.
// Still ~19x what a fast render costs, so meshes cannot be priced off render intuition.
//
// It was 35 credits / $0.364 until texturing was switched off in api/model3d.js. STL stores
// geometry only, so the texture pass was discarded at the convert step — 29% of the Tripo bill
// bought nothing. Verified no quality cost: textured 501,766 triangles / 0 boundary edges vs
// untextured 500,996 / 0 boundary edges. Both print.
//
// Margin per mesh, net of Stripe (Starter nets $0.0304/credit, Studio only $0.0257):
//   25 credits -> 65% Starter / 59% Studio
//   30 credits -> 71% Starter / 66% Studio   <- chosen
//   40 credits -> 78% Starter / 74% Studio
// 30 passes the texture saving to the buyer instead of banking it: the margin matches what 40
// earned at the old cost, while a Starter pack now buys 5 printable models instead of 3, and a
// mesh costs the buyer ~$0.91. With no paying users yet, adoption is worth more than the extra
// seven points, and this is easy to raise later if the cost assumptions move.
//
// NOTE the interaction with SIGNUP_BONUS below: at 25 this silently handed every new account
// TWO free meshes ($0.73 of real cost each signup). At 40 it is exactly one. Keeping one free
// mesh is defensible as customer acquisition — the STL download is the moment someone believes
// the product — but it should be a decision, not an accident. Raise this above SIGNUP_BONUS to
// require a purchase before any mesh.
// RE-MEASURED 2026-10-23 on v3.1-20260211 "detailed" (model3d.js): 40 to generate + 10 to convert = 50 Tripo
// credits = $0.50 + Flux ~$0.005 per mesh. At 30 Podder credits that is ~40% Starter / ~35% Studio after
// Stripe; 50 credits restores ~67% Starter / ~61% Studio. Owner raised the price to 50 on 2026-10-23.
// Note: SIGNUP_BONUS (50) still covers exactly one free mesh, which now costs ~$0.50.
export const MODEL3D_COST = 50;

// Stripe Managed Payments is enabled by default on this account and rejects inline
// price_data without a tax code. txcd_10105001 is "AIaaS - Cloud Based - Personal Use":
// access to AI tools (image generators) hosted on the provider's servers, used via a
// browser, for personal rather than commercial use — which is what Podder credits are.
//
// This choice drives how sales tax / VAT is calculated on every sale. If most buyers turn
// out to be businesses reselling prints, txcd_10105002 (Business Use) is the correct code.
// Worth confirming against your own tax situation; full list at docs.stripe.com/tax/tax-codes.
export const TAX_CODE = 'txcd_10105001';

// Stripe charges 2.9% + $0.30, which is 18% of a $2 sale but only 3.6% of a $40 one —
// hence a $5 floor rather than the $2 pack that looked attractive on paper.
export const PACKS = {
  starter:  { credits: 150,  amount: 500,  name: 'Starter pack',  blurb: '150 credits'  },
  standard: { credits: 500,  amount: 1500, name: 'Standard pack', blurb: '500 credits'  },
  studio:   { credits: 1500, amount: 4000, name: 'Studio pack',   blurb: '1,500 credits' },
};

// What a REAL (email-bearing) account is granted. The database actually grants it; this
// constant only advertises it on the sign-up screen, so the two must move together — see
// handle_new_user and handle_user_upgrade, currently set by 0007.
//
// There are two different numbers, deliberately (0007_split_anon_trial_from_signup_bonus):
//   anonymous trial  10 credits  — no email, costs us nothing to create, so it buys a look
//   real signup      50 credits  — this constant, what the gate promises
//   anon -> converts 60 total    — rewards trying first without paying two full bonuses
// Before 0007 every anonymous session was handed the full 50 and then 50 again on conversion,
// so a converting visitor got 100 while the gate said 50, and a visitor who never left an
// email still walked away with 50 free renders.
//
// Sizing: 50 credits is 50 fast renders OR exactly one 3D mesh. Keeping one free mesh is
// deliberate — the STL download is the moment the product becomes believable — but it is the
// single most expensive thing a free account can do (~$0.36 vs ~$0.014 for a render), so check
// MODEL3D_COST above before raising this. Keep it below PACKS.starter.credits or the cheapest
// paid tier becomes unsellable.
export const SIGNUP_BONUS = 50;

export function creditsFor(quality) {
  return CREDIT_COST[quality] ?? CREDIT_COST.fast;
}
