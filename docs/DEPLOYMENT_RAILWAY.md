# Deploying ReconcileAI to Railway (independent of Manus)

This is the runbook to move `reconcileai.vip` off the Manus prototype and onto an
independent host (Railway) that auto-deploys from GitHub `main`.

**Stack:** Node 22 · Express + tRPC · Vite/React · Drizzle ORM · MySQL.
**Build:** `pnpm build` → `dist/index.js` (server) + `dist/public/` (static client).
**Start:** `pnpm start` → `node dist/index.js` (reads `PORT` from the environment).

> **Zero-downtime principle:** stand the new host up fully, verify it, **then** flip
> DNS. The live Manus site keeps serving users until the CNAME changes. Because the
> Manus-OAuth → magic-link migration is already merged to `main`, the new auth works
> on the new host and nothing breaks for existing users at cutover.

---

## 0. Prerequisites (accounts you provision)

| Service | Purpose | Notes |
|---|---|---|
| **Railway** | App host (auto-deploy from GitHub) | https://railway.app |
| **TiDB Cloud** | `DATABASE_URL` (main DB) | Keep the existing dev DB — zero migration |
| **Cloudflare R2** | File storage (S3-compatible) | Storage was rewritten off Manus → **R2 is now required** |
| **Resend** | Transactional email (magic links, CFO reports) | Verify the `reconcileai.vip` domain (SPF/DKIM/DMARC) |
| **Anthropic** | Claude LLM | Already verified working this session |
| **Cloudflare DNS** | `reconcileai.vip` zone | For the final CNAME cutover |

---

## 1. Create the Railway project

1. Railway → **New Project → Deploy from GitHub repo** → `Infinity-AI-Africa-Limited/reconcileai`, branch `main`.
2. Railway reads [`railway.json`](../railway.json): Nixpacks build `pnpm build`, start `pnpm start`,
   healthcheck `GET /api/healthz`. Node version comes from [`.nvmrc`](../.nvmrc) (22).
3. **Do not set `PORT`** — Railway injects it; the server already reads `process.env.PORT`.

---

## 2. Set environment variables (Railway → Variables)

```bash
# ── Core ───────────────────────────────────────────────
NODE_ENV=production
DATABASE_URL=mysql://USER:PASS@HOST:4000/reconcileai?ssl={"rejectUnauthorized":true}   # TiDB Cloud
JWT_SECRET=                      # openssl rand -hex 32
APP_URL=https://reconcileai.vip
# PORT — DO NOT SET (Railway injects it)

# ── LLM: Anthropic Claude ──────────────────────────────
DIRECT_LLM_API_KEY=sk-ant-...
DIRECT_LLM_API_URL=https://api.anthropic.com
DIRECT_LLM_MODEL=claude-sonnet-4-5
DIRECT_LLM_PROVIDER=anthropic

# ── Email: Resend ──────────────────────────────────────
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@reconcileai.vip
EMAIL_FROM_NAME=ReconcileAI
OWNER_EMAIL=ops@reconcileai.vip

# ── Storage: Cloudflare R2 (S3-compatible) ─────────────
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=auto
AWS_S3_BUCKET=reconcileai-prod
AWS_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com

# ── Woodcore live tenant (POC live view) ───────────────
WOODCORE_DB_HOST=203.123.87.130
WOODCORE_DB_PORT=3306
WOODCORE_DB_USER=reconcileai
WOODCORE_DB_PASSWORD=...
WOODCORE_DB_NAME=fineract_default

# ── SFTP ingestion (only if used) ──────────────────────
SFTP_ENCRYPTION_KEY=             # openssl rand -hex 32
```

**Do NOT set** these Manus-only vars (their absence is intentional): `BUILT_IN_FORGE_API_KEY`,
`BUILT_IN_FORGE_API_URL`, `VITE_FRONTEND_FORGE_API_KEY`, `VITE_APP_ID`, `OAUTH_SERVER_URL`,
`VITE_OAUTH_PORTAL_URL`.

---

## 3. Database schema (one-time)

You're keeping **TiDB Cloud**, which already has the schema and data, so normally there is
nothing to do. If you point at a fresh DB, sync the schema once:

```bash
DATABASE_URL="mysql://..." pnpm db:migrate
```

> ⚠️ **Never run `pnpm db:push` against production.** It is
> `drizzle-kit generate && drizzle-kit migrate` — the `generate` half writes a NEW
> migration from whatever `schema.ts` is in your working tree, then applies it.
> Run it with an unmerged branch checked out and that branch's schema lands in the
> live database, which is how migrations 0084, 0085 and 0090 reached production
> before their pull requests merged and left deploys failing on
> `ER_TABLE_EXISTS` / `ER_DUP_KEYNAME`.
>
> Use **`pnpm db:migrate`** — it applies committed migrations and generates
> nothing. Railway already runs it as `preDeployCommand`, so a manual run should
> be rare.

---

## 4. First deploy + verify

Railway builds and deploys automatically. Then:

```bash
# Liveness (Railway's healthcheck target) — should be 200 immediately
curl https://<railway-subdomain>.up.railway.app/api/healthz

# Deep readiness — checks DB + storage + LLM. Aim for "healthy".
curl https://<railway-subdomain>.up.railway.app/api/health
```

`/api/health` returns `degraded` (503) if **any** of DB / storage / LLM is misconfigured —
use its JSON `checks` to fix the offending one. (Railway healthchecks `/api/healthz`, not
`/api/health`, so a single degraded dependency won't loop-restart the deploy.)

---

## 5. Custom domain + DNS cutover (Cloudflare)

1. Railway → service → **Settings → Networking → Custom Domain** → add `reconcileai.vip`.
   Railway shows a target like `xxxx.up.railway.app`.
2. Cloudflare DNS for `reconcileai.vip`:
   - Update the apex/root record to **CNAME → `xxxx.up.railway.app`** (Cloudflare supports CNAME
     flattening at the apex). Update `www` the same way.
   - Proxy status: **Proxied** (orange cloud). SSL/TLS mode: **Full (strict)**.
   - Lower TTL to 300s shortly before cutover for a fast switch/rollback.
3. Verify `https://reconcileai.vip/api/healthz` resolves to Railway, then restore normal TTL.

---

## 6. Post-cutover smoke test

- **Magic-link auth:** open `/login`, request a link, confirm the Resend email arrives and login lands on `/dashboard`.
- **Woodcore POC:** open `/woodcore-poc` — the "Live Woodcore Test Tenant" cards + GL/Savings/Loan
  reconciliation tabs should populate (proves `WOODCORE_DB_*` + outbound `:3306` work). The default
  14-day GL window surfaces the ₦4.64M imbalance on 2026-05-22.
- **LLM:** trigger an exception classification or the Super Agent; confirm a Claude response.
- **Storage:** generate/share a report; confirm upload + download via R2.

---

## 7. CI/CD (autonomous deploy on push)

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs **typecheck + build** on every PR
  and push to `main` (plus a best-effort test job against a throwaway MySQL).
- Railway redeploys automatically on every push to `main`.
- **Recommended:** in GitHub → Settings → Branches, protect `main` and require the **"Typecheck &
  Build"** check; in Railway enable **"Wait for CI"** so a red build never deploys.

---

## 8. Rollback

- **App:** Railway → Deployments → pick the previous green deploy → **Redeploy** (instant).
- **DNS:** repoint the Cloudflare CNAME back to the Manus target (kept at TTL 300 during cutover).

---

## Notes / known follow-ups

- **Storage was migrated off Manus** to S3/R2 in `server/storage.ts` (+ `storageProxy.ts`). It needs
  the `AWS_*` vars above; without them, storage calls and `/api/health` report an error.
- **Full Layer 1–3 Woodcore engine** (Claude exception analysis, persisted runs) additionally needs
  the `wc_*` tables loaded into `DATABASE_URL`. The live POC view does not.
- **Analytics:** the Manus umami snippet was removed from `client/index.html`; add PostHog/Plausible
  there if you want product analytics (see `docs/CONTEXT_HANDOFF.md` §3.6).
- **Large client bundle** (~2.6 MB) — consider route-level code-splitting later; non-blocking.
