// POST /api/auth  { pin: "1234" }  ->  { ok: true }
// The PIN lives in the PODDER_PIN environment variable (set it in Vercel's project settings).
// It is the owner's key: the client keeps the verified PIN and sends it as an x-podder-pin
// header, which every billed endpoint re-checks through checkOwnerPin (with a per-IP lockout).

import { checkOwnerPin, pinMatches } from './_lib/server.js';

// Kept for callers that only need a yes/no and have already been rate-limited.
export const pinOk = pinMatches;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.PODDER_PIN) return res.status(500).json({ error: 'server_missing_pin', detail: 'Set the PODDER_PIN environment variable.' });
  const pin = String((req.body || {}).pin || '');
  const r = await checkOwnerPin(req, pin);
  if (r === 'locked') return res.status(429).json({ error: 'too_many_attempts', detail: 'Too many wrong PINs — try again in an hour.' });
  if (r !== 'ok') return res.status(401).json({ error: 'bad_pin' });
  return res.status(200).json({ ok: true });
}
