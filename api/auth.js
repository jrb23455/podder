// POST /api/auth  { pin: "1234" }  ->  { ok: true }
// The PIN lives in the PODDER_PIN environment variable (set it in Vercel's project settings).
// This is a simple access gate for the pre-payments era — the client keeps the verified PIN
// and sends it as an x-podder-pin header on every generate call, which the server re-checks.

import { timingSafeEqual } from 'node:crypto';

export function pinOk(candidate) {
  const real = process.env.PODDER_PIN || '';
  if (!real || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate.padEnd(64).slice(0, 64));
  const b = Buffer.from(real.padEnd(64).slice(0, 64));
  return candidate.length === real.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const { pin } = req.body || {};
  if (!process.env.PODDER_PIN) return res.status(500).json({ error: 'server_missing_pin', detail: 'Set the PODDER_PIN environment variable.' });
  if (!pinOk(pin)) return res.status(401).json({ error: 'bad_pin' });
  return res.status(200).json({ ok: true });
}
