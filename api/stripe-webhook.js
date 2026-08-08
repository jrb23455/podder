// POST /api/stripe-webhook   (called by Stripe, not by the browser)
//
// One of two paths that can fulfill a purchase; /api/claim is the other. Both funnel into
// fulfillSession(), which re-reads the session from Stripe's API and credits idempotently,
// so they can race, repeat, or both fire without ever double-crediting.
//
// Trust model — deliberately NOT "the signature is the only gate":
//   * If the raw body is available, the signature is verified strictly and a bad one is
//     rejected outright.
//   * If the platform already parsed the body (so the exact signed bytes are gone), we do
//     not guess. We take only the session id from the payload and ask Stripe directly what
//     that session is. A forged id 404s; a replayed real id is already fulfilled.
// The upshot is that a runtime that ignores `bodyParser: false` degrades to a slower check
// rather than to either a security hole or silently broken payments.

import { fulfillSession, verifyStripeSignature, readRawBody, missingEnv } from './_lib/server.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const missing = missingEnv();
  if (missing.length) return res.status(500).json({ error: 'server_not_configured' });

  const raw = await readRawBody(req);
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  let event = null;
  let signatureChecked = false;

  if (raw !== null) {
    if (secret) {
      const ok = await verifyStripeSignature(raw, req.headers['stripe-signature'], secret);
      if (!ok) return res.status(400).json({ error: 'bad_signature' });
      signatureChecked = true;
    }
    try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: 'bad_json' }); }
  } else {
    event = req.body || null;
  }

  if (!event || typeof event !== 'object') return res.status(400).json({ error: 'bad_payload' });

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ ignored: event.type });   // ack so Stripe stops retrying
  }

  const sessionId = event.data?.object?.id;
  const result = await fulfillSession(sessionId);

  if (result.ok) {
    return res.status(200).json({ ok: true, balance: result.balance, signatureChecked });
  }

  // Retryable (Stripe unreachable, or our DB threw): 500 makes Stripe try again, and
  // idempotency means a later success still lands exactly once.
  if (result.retry) {
    console.error('stripe-webhook: retryable failure', sessionId, result.reason);
    return res.status(500).json({ error: result.reason });
  }

  // Terminal (unknown session, unpaid, unusable metadata): 200 so Stripe stops hammering
  // a request that will never succeed. Logged for reconciliation.
  console.error('stripe-webhook: dropped', sessionId, result.reason);
  return res.status(200).json({ ok: false, reason: result.reason });
}
