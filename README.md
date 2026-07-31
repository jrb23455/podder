# Podder (Web)

Far-out, **always-3D-printable** design generator. Picks an object (vase, planter, birdhouse, 35 in all), layers on trippy style DNA (sacred geometry, drippy, voronoi, …), and renders it in the cloud with Flux — single isolated object, one solid printable form, clean studio background, ready for image-to-3D (e.g. meshy.ai) and printing.

The app is a single static page plus two serverless functions. No build step, no npm dependencies.

```
index.html        the whole app (UI + prompt engine)
api/auth.js       POST {pin} — access gate
api/generate.js   POST {prompt, aspect, image?, strength?} — Flux via Replicate
dev-server.mjs    local preview only (mimics Vercel routing)
```

## Deploy (GitHub → Vercel)

1. Push this folder to a GitHub repo.
2. In [Vercel](https://vercel.com): **Add New → Project**, import the repo. Framework preset: **Other**. No build command, no output directory — deploy as-is.
3. In the Vercel project → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `PODDER_PIN` | The access PIN you give people (e.g. `4821`) |
| `REPLICATE_API_TOKEN` | From [replicate.com/account/api-tokens](https://replicate.com/account/api-tokens) |
| `REPLICATE_MODEL` | *(optional)* defaults to `black-forest-labs/flux-dev` |

4. Redeploy. Done — share the URL + PIN.

Without `REPLICATE_API_TOKEN`, the app still works end-to-end but returns labeled **mock images** — useful for previewing the UI at zero cost.

## Costs

Renders run on your Replicate account: roughly **$0.025–0.03 per image** on `flux-dev`, or ~$0.003 on `black-forest-labs/flux-schnell` (faster, lower fidelity — set it via `REPLICATE_MODEL`). The PIN is the only thing standing between the internet and your Replicate bill — treat it accordingly, and rotate it in Vercel whenever you want to cut someone off.

## Local preview

```
node dev-server.mjs
```

→ http://localhost:8299 — PIN defaults to `2323` in dev, renders are mocks unless `REPLICATE_API_TOKEN` is set in the environment.

## How it works

- The browser never sees your Replicate token — `api/generate.js` runs the model server-side and streams the finished image back as a data URL.
- Rendered images are stored in the **browser's IndexedDB**; favorites/history/rerolls reference them by key. Nothing is stored server-side, so hosting is free-tier friendly.
- ✎ Edit re-runs Flux in img2img mode anchored to the current picture (strength = how far it may drift).
- The PIN gates every API call (`x-podder-pin` header, timing-safe compare server-side). A wrong/blank PIN re-locks the UI.

## Roadmap to paid

- Swap the PIN for real auth + Stripe (the `x-podder-pin` header check in `api/*.js` is the single choke point to replace).
- Optional: persist images to Vercel Blob/S3 so a user's gallery follows them across devices.
