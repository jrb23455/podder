// POST /api/checkout  { pack: "starter" | "standard" | "studio" }
//   headers: Authorization: Bearer <supabase access token>
//   -> { url }   (redirect the browser here)
//
// Prices come from api/_lib/config.js, not from the request — the client picks a pack id
// and nothing else, so a tampered payload can't buy 700 credits for $5. Stripe products
// are created inline via price_data, so there is nothing to keep in sync in the dashboard.

import { getUser, stripe, missingEnv } from './_lib/server.js';
import { PACKS, TAX_CODE } from './_lib/config.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const missing = missingEnv();
  if (missing.length) return res.status(500).json({ error: 'server_not_configured', detail: `Missing: ${missing.join(', ')}` });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'stripe_not_configured' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'not_signed_in' });

  const packId = String(req.body?.pack || '');
  const pack = PACKS[packId];
  if (!pack) return res.status(400).json({ error: 'unknown_pack' });

  const origin =
    process.env.PUBLIC_ORIGIN ||
    (req.headers.origin) ||
    (req.headers.host ? `https://${req.headers.host}` : '');

  try {
    const session = await stripe('checkout/sessions', {
      mode: 'payment',
      // Binds the payment to the account. The webhook reads these back — never trust
      // a user id supplied by the browser at fulfillment time.
      client_reference_id: user.id,
      metadata: { user_id: user.id, pack: packId, credits: String(pack.credits) },
      payment_intent_data: { metadata: { user_id: user.id, pack: packId, credits: String(pack.credits) } },
      customer_email: user.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: pack.amount,
          // tax_code is mandatory here: Managed Payments is on by default for this
          // account and rejects inline products without one.
          product_data: { name: `Podder — ${pack.name}`, description: pack.blurb, tax_code: TAX_CODE },
        },
      }],
      // Stripe substitutes the real id here. The client posts it to /api/claim on return,
      // so credits land immediately even if the webhook is slow or never configured.
      success_url: `${origin}/?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?purchase=cancelled`,
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(502).json({ error: 'checkout_failed', detail: String(e.message || e) });
  }
}
