# Podder (Web)

**Design generator for 3D printing.** Pick an object (123 across home goods, figurines, spiritual, jewelry and geometry), layer on a style, and render it in the cloud with Flux. Turn a render into a printable STL with Tripo. Live at [podder.dev](https://www.podder.dev).

The app is a single static page plus a handful of serverless functions. No build step, no npm dependencies.

```
index.html            the whole app (UI + prompt engine)
brochure.html         the public design book (/brochure), data in brochure/
terms.html            /terms    privacy.html  /privacy
api/generate.js       renders (Replicate Flux), debit first, refund on failure
api/model3d.js        image -> STL (Tripo); tasks tied to the account that paid
api/checkout.js       Stripe checkout   api/claim.js + api/stripe-webhook.js  fulfil purchases
api/me.js             balance + ledger; also settles failed 3D jobs
api/config.js         public client config (Supabase URL + anon key, prices)
api/account.js        DELETE: user deletes their own account
api/auth.js           owner PIN check (per-IP lockout after 10 wrong tries an hour)
api/admin/grant.js    owner: grant or remove credits by email
api/brochure.js       owner edits to the design book
supabase/migrations   schema; apply in order
scripts/preflight.mjs runs as Vercel's build step and blocks a broken catalog
```

## Environment variables (Vercel)

| Variable | What |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | accounts and credits |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | payments |
| `REPLICATE_API_TOKEN` | renders (without it, renders are free labeled mocks) |
| `TRIPO_API_KEY` | 3D models (the button only appears when set) |
| `RENDER_REVIEW_KEY` | Anthropic API key for "Report bad render" (the button stays hidden without it) |
| `ALERT_WEBHOOK_URL` | optional Discord/Slack webhook for error alerts |
| `PODDER_PIN` | owner access: unlimited, unbilled. Use a long random value. |
| `PUBLIC_ORIGIN` | optional, e.g. `https://www.podder.dev`, for Stripe return URLs |

Prices, packs and the signup bonus live in `api/_lib/config.js`; the bonus amounts themselves are granted by the database triggers (see the migrations).

## Security notes

- Only the server (service-role key) can move credits. The credit functions are not callable with the public anon key (migration 0009).
- Every billed endpoint debits before calling the vendor and refunds on failure.
- The owner PIN bypasses billing, so it is rate-limited per IP and should be long.

## Local preview

```
node dev-server.mjs
```

Opens http://localhost:8299. Renders are mocks unless `REPLICATE_API_TOKEN` is set.

## Storage

Rendered images, favorites and history live in the browser (IndexedDB + localStorage), not on the server. Saved STLs are remembered by Tripo task id and re-fetched on demand, since Tripo's file links expire.
