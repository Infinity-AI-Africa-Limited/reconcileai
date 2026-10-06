# Deploying ReconcileAI to Railway

**Status (2026-10-06):** production already runs on Railway at
`https://www.reconcileaiafrica.com`, auto-deploying from `main`. This runbook is the
reference for that service. `reconcileai.vip` is historical; do not configure it.

> ⚠️ **This runbook describes the production service only.** Do not copy its values into a
> second Railway service (staging, a disaster-recovery copy). A second service needs its own
> database, storage bucket, Redis, `APP_URL` and domain, and **no** SHOPLINE or Shopify
> credentials unless it has its own registered app: the App Store callbacks and webhooks
> point at the production domain, so a copy would share production data while connector
> traffic keeps reaching production.

**Stack:** Node 22 · Express + tRPC · Vite/React · Drizzle ORM · MySQL (TiDB Cloud).
**Build:** `pnpm build` → `dist/index.js` (server) + `dist/public/` (static client).
**Start:** `pnpm start` → `node dist/index.js` (reads `PORT` from the environment).

---

## 0. Prerequisites (accounts you provision)

| Service | Purpose | Notes |
|---|---|---|
| **Railway** | App host (auto-deploy from GitHub) | https://railway.app |
| **TiDB Cloud** | `DATABASE_URL` (main DB) | MySQL-compatible |
| **Railway Redis** | `REDIS_URL` (durable job queue) | **Required before any Shopify merchant installs** (see §2) |
| **Cloudflare R2** | File storage (S3-compatible) | Required; storage has no local fallback |
| **Resend** | Transactional email (magic links, CFO reports) | Domain `reconcileaiafrica.com` (SPF/DKIM/DMARC) |
| **Anthropic** | Claude LLM | |
| **Cloudflare DNS** | `reconcileaiafrica.com` zone | Proxied, SSL mode Full (strict) |

---

## 1. Create the Railway service

1. Railway → **New Project → Deploy from GitHub repo** → `Infinity-AI-Africa-Limited/reconcileai`, branch `main`.
2. Railway reads [`railway.json`](../railway.json): Nixpacks build `pnpm build`, pre-deploy
   `pnpm db:migrate`, start `pnpm start`, healthcheck `GET /api/healthz` (120 s timeout),
   restart on failure up to 10 times. Node comes from [`.nvmrc`](../.nvmrc) (22) and pnpm
   from `packageManager` in `package.json`.
3. **Do not set `PORT`** — Railway injects it; the server already reads `process.env.PORT`.
4. Add a **Redis** service to the same project and reference its URL as `REDIS_URL`
   (Variables → Add Reference → `${{Redis.REDIS_URL}}`).

---

## 2. Set environment variables (Railway → Variables)

Generate every secret **in the Railway dashboard** and never transcribe it into chat,
a document or a tracked file (CLAUDE.md §18). Full annotations for each variable are in
[`env.example.md`](env.example.md); this section is the Railway checklist.

### 2a. Required — the app does not work without these

```bash
NODE_ENV=production
DATABASE_URL=mysql://USER:PASS@HOST:4000/reconcileai?ssl={"rejectUnauthorized":true}
JWT_SECRET=                      # 64+ random chars; see the key-derivation warning in 2d
APP_URL=https://www.reconcileaiafrica.com

DIRECT_LLM_API_KEY=sk-ant-...
DIRECT_LLM_API_URL=https://api.anthropic.com
DIRECT_LLM_MODEL=claude-sonnet-5
DIRECT_LLM_PROVIDER=anthropic
# DIRECT_LLM_MODEL_AGENT=claude-opus-4-8   # optional: stronger model for the Super Agent only

RESEND_API_KEY=re_...
EMAIL_FROM=noreply@reconcileaiafrica.com
EMAIL_FROM_NAME=ReconcileAI
OWNER_EMAIL=ops@reconcileaiafrica.com

AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=auto
AWS_S3_BUCKET=reconcileai-prod                                  # AWS_BUCKET_NAME also accepted
AWS_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com  # AWS_ENDPOINT_URL also accepted

REDIS_URL=${{Redis.REDIS_URL}}
```

> ⚠️ **`REDIS_URL` is not optional while the Shopify connector is live.** Shopify order
> sync, manual sync and privacy (GDPR) webhooks create their queues with
> `requireDurable: true` (`server/connectors/shopify/syncQueue.ts`, `privacyQueue.ts`) and
> refuse to run without Redis. Order webhooks degrade to the 15-minute backstop; privacy
> requests are acknowledged to Shopify and parked in a retryable outbox, so they are
> **not actioned until Redis is provisioned** — the 30-day obligation keeps running meanwhile. Verify with the boot
> log line `[boot] Shopify durable queues confirmed` (see §6), not by webhooks returning 200.
> See CLAUDE.md §10.

### 2b. Required for a connector that is live

```bash
# Scheduler auth (Woodcore mirror + SHOPLINE sync). OIDC is preferred; the secret is
# the fallback for Railway Cron. Unset GITHUB_OIDC_REPOSITORIES disables OIDC.
GITHUB_OIDC_AUDIENCE=https://www.reconcileaiafrica.com   # must match OIDC_AUDIENCE in the workflows
GITHUB_OIDC_REPOSITORIES=Infinity-AI-Africa-Limited/reconcileai
GITHUB_OIDC_REFS=refs/heads/main
CRON_SECRET=                     # dedicated value; unset falls back to JWT_SECRET
# CRON_SECRET must ALSO exist as a GitHub Actions secret of the same name, with the same
# value. Both scheduler workflows send it alongside the OIDC token, and exit before
# syncing if they have neither. On rotation, change Railway and GitHub together, then
# delete the legacy SHOPLINE_SYNC_SECRET / WOODCORE_SYNC_SECRET (CLAUDE.md §18).

# SHOPLINE App Store (CLAUDE.md §2B.9). Missing secret = every install, webhook and
# GDPR delivery fails signature checks.
SHOPLINE_APP_KEY=...
SHOPLINE_APP_SECRET=...
SHOPLINE_WEBHOOK_SECRET=...      # same value as SHOPLINE_APP_SECRET

# Shopify App Store
SHOPIFY_CLIENT_ID=...
SHOPIFY_CLIENT_SECRET=...
SHOPIFY_WEBHOOK_DIGEST_KEY=      # 64 hex chars (openssl rand -hex 32 equivalent)
SHOPIFY_PRIVACY_SUPPRESSION_KEYS=v1:<64 hex>   # keep old keys on rotation: v1:...,v2:...

# Woodcore live tenant (POC live view)
WOODCORE_DB_HOST=203.123.87.130
WOODCORE_DB_PORT=3306
WOODCORE_DB_USER=reconcileai
WOODCORE_DB_PASSWORD=...
WOODCORE_DB_NAME=fineract_default
```

### 2c. Optional

| Variable | Effect when set |
|---|---|
| `CLOUDFLARE_ORIGIN_SECRET` | Origin trusts forwarded client IPs only on requests carrying the Cloudflare-injected header; see `env.example.md` for the Transform Rule |
| `TRUSTED_PROXY_HOPS` | Override the proxy-hop default (2 in cloud production) |
| `SESSION_TTL_MINUTES` | Session lifetime, 15–1440 (default 480) |
| `RESEND_WEBHOOK_SECRET`, `EMAIL_INBOUND_DOMAIN` | Email-forward ingestion; inert until Resend receiving is enabled (CLAUDE.md §19.4) |
| `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET/TENANT_ID` | Per-org SSO buttons on `/login` |
| `CBN_SIGNING_PRIVATE_KEY` | Stable Ed25519 key for signed CBN reports (unset = ephemeral per process) |
| `SFTP_ENCRYPTION_KEY` | Only if SFTP ingestion is used |
| `SHOPLINE_SIG_DEBUG=true` | Redacted OAuth signature diagnostics |

**Do not set** on Railway: the Manus-only `BUILT_IN_FORGE_API_KEY`, `BUILT_IN_FORGE_API_URL`,
`VITE_FRONTEND_FORGE_API_KEY`, `VITE_APP_ID`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`; and
the on-premise-only `DEPLOYMENT_MODE=on_premise`, `EGRESS_ALLOWLIST`, `AUDIT_IMMUTABILITY_MODE`,
`RECONCILIATION_REQUIRE_DURABLE_QUEUE` (see `docs/on-prem/`).

### 2d. ⚠️ `JWT_SECRET` is the root of four other keys

When their dedicated variable is unset, these keys are **derived from `JWT_SECRET`**:

| Key | Dedicated variable | Protects |
|---|---|---|
| Tenant master key (`server/_core/tenantKeys.ts`) | `TENANT_MASTER_KEY` | Every tenant's wrapped data key, Shopify tokens and privacy selectors |
| Connector secret key (`server/connectors/woodcore/secrets.ts`) | `CONNECTOR_ENCRYPTION_KEY` | Stored CBS connector credentials |
| SHOPLINE token key (`server/connectors/shopline/tokenStore.ts`) | none | Stored SHOPLINE OAuth tokens |
| Cron secret | `CRON_SECRET` | Scheduler endpoints |

So rotating `JWT_SECRET` does not only sign everyone out: it makes everything in that
table that was encrypted under the derived key **undecryptable**. Setting a fresh random
`TENANT_MASTER_KEY` or `CONNECTOR_ENCRYPTION_KEY` today has the same effect.

**Before the first `JWT_SECRET` rotation** (CLAUDE.md §19.1), pin the current derived keys
as their own variables so the rotation leaves them alone. Compute them in a Railway shell
so no value leaves Railway:

```bash
node -e 'const c=require("crypto"),s=process.env.JWT_SECRET;
console.log("TENANT_MASTER_KEY="+c.createHash("sha256").update(s+":tenant-master").digest("hex"));
console.log("CONNECTOR_ENCRYPTION_KEY="+c.createHash("sha256").update(s+":wc-connector").digest("hex"))'
```

Set both, redeploy, confirm a Woodcore connector and a Shopify store still sync, and only
then rotate `JWT_SECRET`. SHOPLINE tokens have no dedicated key and must be reconnected
after rotation either way.

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

1. Railway → service → **Settings → Networking → Custom Domain** → add `www.reconcileaiafrica.com`
   (and the apex `reconcileaiafrica.com`).
   Railway shows a target like `xxxx.up.railway.app`.
2. Cloudflare DNS for `reconcileaiafrica.com`:
   - Update the apex/root record to **CNAME → `xxxx.up.railway.app`** (Cloudflare supports CNAME
     flattening at the apex). Update `www` the same way.
   - Proxy status: **Proxied** (orange cloud). SSL/TLS mode: **Full (strict)**.
   - Lower TTL to 300s shortly before cutover for a fast switch/rollback.
3. Verify `https://www.reconcileaiafrica.com/api/healthz` resolves to Railway, then restore normal TTL.

---

## 6. Post-cutover smoke test

- **Magic-link auth:** open `/login`, request a link, confirm the Resend email arrives and login lands on `/dashboard`.
- **Woodcore POC:** open `/woodcore-poc` — the "Live Woodcore Test Tenant" cards + GL/Savings/Loan
  reconciliation tabs should populate (proves `WOODCORE_DB_*` + outbound `:3306` work). The default
  14-day GL window surfaces the ₦4.64M imbalance on 2026-05-22.
- **LLM:** trigger an exception classification or the Super Agent; confirm a Claude response.
- **Storage:** generate/share a report; confirm upload + download via R2.
- **Queue:** the boot log must show `[boot] Shopify durable queues confirmed`, and
  `GET /api/health` must report `checks.queue.durable: true`. Both come from an actual count
  read against Redis. Do **not** rely on `[queue:…] BullMQ backend active`: it prints when the
  queue object is built, before Redis has answered, so it appears even when Redis is
  unreachable. Failure looks like `[boot] Shopify durable queues unavailable` with reason
  `queue_timeout` (Redis set but unreachable) or `queue_unavailable`. With `REDIS_URL`
  unset the boot probe prints nothing at all, so a missing "confirmed" line is itself the
  signal.

---

## 7. CI/CD (autonomous deploy on push)

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs **Typecheck & Build** (typecheck,
  test typecheck, lint, build) and **Tests** (full suite against a throwaway MySQL; blocking)
  on every PR and push to `main`.
- Railway redeploys automatically on every push to `main`.
- `main` is protected: 1 approving review plus the **`Tests`** check, admins included
  (CLAUDE.md §15). In Railway, enable **"Wait for CI"** on the service so a red commit on
  `main` never deploys.

---

## 8. Rollback

- **App:** Railway → Deployments → pick the previous green deploy → **Redeploy** (instant).
- **Migrations do not roll back.** A redeploy of an older build runs `pnpm db:migrate`
  again, which is a no-op for already-applied migrations; the schema stays at the newer
  version. Migrations are append-only, so older code must tolerate newer columns.

---

## Notes / known follow-ups

- **Storage was migrated off Manus** to S3/R2 in `server/storage.ts` (+ `storageProxy.ts`). It needs
  the `AWS_*` vars above; without them, storage calls and `/api/health` report an error.
- **Full Layer 1–3 Woodcore engine** (Claude exception analysis, persisted runs) additionally needs
  the `wc_*` tables loaded into `DATABASE_URL`. The live POC view does not.
- **Analytics:** the Manus umami snippet was removed from `client/index.html`; add PostHog/Plausible
  there if you want product analytics (see `docs/CONTEXT_HANDOFF.md` §3.6).
- **Large client bundle** (~2.6 MB) — consider route-level code-splitting later; non-blocking.
