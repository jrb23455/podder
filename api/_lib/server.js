// Server-side helpers: Supabase auth + RPC, and Stripe, over plain fetch.
//
// Deliberately dependency-free. Podder has no node_modules and no build step; pulling in
// @supabase/supabase-js and stripe just to make three HTTP calls and verify one HMAC would
// change that for no real gain. Everything here is the documented REST surface.
//
// Anything under api/_lib is ignored by Vercel's function builder (leading underscore),
// so this file is importable but never routable.

const SUPABASE_URL = () => (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY  = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Reports env vars that are absent OR obviously wrong. The "obviously wrong" half exists
// because pasting a variable's NAME into its VALUE box is an easy slip that otherwise
// sails through every presence check and only surfaces as a confusing 401 much later.
export function missingEnv() {
  const bad = [];
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!url) bad.push('SUPABASE_URL');
  else if (!/^https:\/\/[^\s/]+\.supabase\.(co|in)$/.test(url.replace(/\/+$/, ''))) {
    bad.push('SUPABASE_URL (not a valid Supabase URL — expected https://<ref>.supabase.co)');
  }

  if (!key) bad.push('SUPABASE_SERVICE_ROLE_KEY');
  else if (!key.startsWith('eyJ') && !key.startsWith('sb_secret_')) {
    bad.push('SUPABASE_SERVICE_ROLE_KEY (does not look like a service-role key)');
  }

  return bad;
}

// ---------------------------------------------------------------------------
// Auth: resolve the caller from their Supabase access token.
// Returns { id, email } or null. Never throws on a bad token — a malformed or
// expired JWT is an ordinary 401, not a server error.
// ---------------------------------------------------------------------------
export async function getUser(req) {
  const hdr = req.headers.authorization || req.headers.Authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!token) return null;

  try {
    const r = await fetch(`${SUPABASE_URL()}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SERVICE_KEY() },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { id: u.id, email: u.email || null } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Supabase RPC with the service-role key (bypasses RLS — never expose this path
// to unvalidated input; every caller below resolves the user id server-side first).
// ---------------------------------------------------------------------------
export async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = data?.message || data?.error || text || `rpc ${fn} failed`;
    const err = new Error(String(msg));
    err.status = r.status;
    err.code = data?.code || null;
    throw err;
  }
  return data;
}

export async function selectOne(table, query) {
  const r = await fetch(`${SUPABASE_URL()}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      Accept: 'application/vnd.pgrst.object+json',
    },
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

export const debit  = (userId, amount, reason, ref = null) =>
  rpc('debit_credits',  { p_user: userId, p_amount: amount, p_reason: reason, p_ref: ref });

export const credit = (userId, amount, reason, ref) =>
  rpc('credit_credits', { p_user: userId, p_amount: amount, p_reason: reason, p_ref: ref });

export const isInsufficient = e =>
  /insufficient_credits/i.test(String(e?.message || '')) || e?.code === 'P0001';

// ---------------------------------------------------------------------------
// Stripe over fetch. The API is form-encoded; nested params use bracket notation.
// ---------------------------------------------------------------------------
export function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) formEncode(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) =>
      typeof item === 'object'
        ? formEncode(item, `${key}[${i}]`, out)
        : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

export async function stripe(path, params) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formEncode(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Stripe ${r.status}`);
  return j;
}

// Read a resource straight from Stripe. This is the trust anchor for fulfillment:
// rather than believing a webhook payload, we ask Stripe what actually happened.
export async function stripeGet(path) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j?.error?.message || `Stripe ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return j;
}

// Shared fulfillment. Both the webhook and the post-checkout claim call this, and both
// are safe to run concurrently or repeatedly: the session is re-verified against Stripe
// every time, and credit_credits() is idempotent on the session id.
//
// Returns { ok, balance, reason }.
export async function fulfillSession(sessionId, expectUserId = null) {
  if (!sessionId || typeof sessionId !== 'string') return { ok: false, reason: 'no_session' };

  let session;
  try {
    session = await stripeGet(`checkout/sessions/${encodeURIComponent(sessionId)}`);
  } catch (e) {
    // A session id Stripe has never heard of is a forgery, not a transient fault.
    return { ok: false, reason: e.status === 404 ? 'unknown_session' : 'stripe_unreachable', retry: e.status !== 404 };
  }

  if (session.payment_status !== 'paid') return { ok: false, reason: 'unpaid' };

  const userId = session.metadata?.user_id || session.client_reference_id;
  const packId = session.metadata?.pack;
  const credits = Number(session.metadata?.credits);

  if (!userId || !packId || !Number.isInteger(credits) || credits <= 0) {
    return { ok: false, reason: 'unusable_metadata' };
  }
  // A signed-in user may only claim their own session.
  if (expectUserId && expectUserId !== userId) return { ok: false, reason: 'not_your_session' };

  try {
    const balance = await credit(userId, credits, `purchase:${packId}`, `stripe:${session.id}`);
    return { ok: true, balance, credits, userId };
  } catch (e) {
    // The customer has paid but we could not record it. Retryable by definition — the
    // idempotency key guarantees the eventual retry credits exactly once.
    return { ok: false, reason: 'credit_failed', retry: true, detail: String(e.message || e) };
  }
}

// Verify a Stripe webhook signature (scheme v1: HMAC-SHA256 over "timestamp.rawBody").
// Constant-time compare, and a 5-minute freshness window to blunt replay.
export async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!rawBody || !sigHeader || !secret) return false;

  const parts = Object.fromEntries(
    String(sigHeader).split(',').map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const ts = parts.t;
  const given = parts.v1;
  if (!ts || !given) return false;

  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}.${rawBody}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

// Best-effort raw body.
//
// Whether `export const config = { api: { bodyParser: false } }` is honoured for plain
// /api/*.js functions is not something Vercel documents clearly, so this must not assume
// either behaviour. If the runtime already parsed and drained the stream, waiting on
// 'end' would hang the function until it times out — so bail out immediately in that
// case and return null. Callers treat null as "signature unverifiable" and fall back to
// verifying the event against Stripe's API instead, which is the real trust anchor.
export function readRawBody(req, timeoutMs = 2000) {
  if (req.readableEnded || req.body !== undefined || req.readable === false) {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    let data = '';
    const done = v => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    req.on('data', c => { data += c; });
    req.on('end', () => done(data));
    req.on('error', () => done(null));
  });
}
