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
// MEASURED 2026-10-16 against a live Tripo account: 30 credits to generate + 5 to convert to
// STL = 35 Tripo credits at $0.01 each = $0.35, plus ~$0.014 for the Flux image the mesh is
// built from. Call it $0.364 of hard cost per mesh — roughly 26x what a fast image costs, so
// meshes cannot be priced off the same intuition as renders.
//
// Margin per mesh, net of Stripe (Starter nets $0.0304/credit, Studio only $0.0257):
//   25 credits -> 52% Starter / 43% Studio   (too thin on the big pack)
//   40 credits -> 70% Starter / 65% Studio   <- chosen
//   50 credits -> 76% Starter / 72% Studio
// 40 keeps the buyer around $1.20 for a bespoke printable STL, which is still far below the
// alternatives (commissioning a modeller, or a $20/mo Tripo seat).
//
// NOTE the interaction with SIGNUP_BONUS below: at 25 this silently handed every new account
// TWO free meshes ($0.73 of real cost each signup). At 40 it is exactly one. Keeping one free
// mesh is defensible as customer acquisition — the STL download is the moment someone believes
// the product — but it should be a decision, not an accident. Raise this above SIGNUP_BONUS to
// require a purchase before any mesh.
export const MODEL3D_COST = 40;

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

// Mirrors handle_new_user() — currently set by 0005_signup_bonus_50.sql. The database
// grants the credits; this constant only advertises them, so the two must move together.
// Keep it below PACKS.starter.credits or the cheapest paid tier becomes unsellable.
export const SIGNUP_BONUS = 50;

export function creditsFor(quality) {
  return CREDIT_COST[quality] ?? CREDIT_COST.fast;
}
