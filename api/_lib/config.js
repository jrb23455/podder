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

// What a downloadable 3D mesh costs (api/model3d.js -> Tripo image-to-3D + STL convert).
//
// MEASURED 2026-10-16 against a live Tripo account, balance read before and after:
//   20 credits to generate (texture:false) + 5 to convert to STL = 25 credits = $0.25
//   plus ~$0.014 for the Flux image it is built from  ->  ~$0.264 per mesh
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
export const MODEL3D_COST = 30;

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
