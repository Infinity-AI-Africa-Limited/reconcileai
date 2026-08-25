# Deployment Runbook — Phases 1–3 (reconcileai.vip)

This release ships the PTB-critical + investor work across phases 1–3. The DB
changes are **purely additive** (migration `drizzle/0041_late_microbe.sql` — 3 new
tables, ADD COLUMN, one safe `varchar` widening; no drops/renames).

> **Order matters.** Run the migration **before** the new code goes live, so the
> new features don't read columns that don't exist yet. Old features keep working
> either way (additive schema), but the new ones need the columns present.

## 0. Pre-flight

- Build is green: `pnpm build` (frontend → `dist/public`, server → `dist/index.js`).
- Tests: `pnpm test` (the only failures are env-dependent `documentation`/`modules` suites that need a DB + guide files in CI).
- Engine validated: 500k benchmark ≈ 36s, 99.5% match, no crash.

## 1. Set / confirm environment variables on the host

Existing (must already be set): `DATABASE_URL`, `JWT_SECRET`, `DIRECT_LLM_API_KEY`,
`DIRECT_LLM_API_URL`, `DIRECT_LLM_MODEL`, `RESEND_API_KEY`, `EMAIL_FROM`, AWS/R2 keys, `APP_URL`.

New in this release (all optional — sensible defaults if unset):

```bash
# CBN report signing (Ed25519). Without it, an ephemeral key is used (signatures
# won't verify across restarts). Generate once and store as a secret:
#   openssl genpkey -algorithm ed25519 -out cbn_signing.pem
CBN_SIGNING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# Exception Intelligence pool (leave UNSET for cloud — it aggregates in-place):
# EXCEPTION_INTEL_ENDPOINT=https://intel.reconcileai.vip

# On-premise customers (e.g. PTB) ONLY — enforce data residency:
# DEPLOYMENT_MODE=on_premise
# EGRESS_ALLOWLIST=llm.internal,intel.reconcileai.vip   # in-VPC hosts allowed out
# (and point DIRECT_LLM_API_URL at an in-VPC LLM; unset BUILT_IN_FORGE_API_KEY)
```

For the standard cloud deployment of reconcileai.vip, only `CBN_SIGNING_PRIVATE_KEY`
is worth setting now; everything else defaults correctly.

## 2. Database migration — no longer a manual step

> ⚠️ **Superseded.** `railway.json` now carries
> `preDeployCommand: pnpm db:migrate`, so deploying `main` migrates the
> production schema before the new code starts. **There is nothing to run by
> hand here.** This section is kept as the record of how release `0041` was
> applied, back when release did not migrate.
>
> If a deploy fails during its pre-deploy step, run `pnpm db:drift` to see which
> statement will collide, fix the migration, and redeploy. Do not reach for a
> manual production migration — that is how migrations 0084, 0085 and 0090 ended
> up in the live database ahead of their pull requests, each leaving the next
> deploy to fail on `ER_TABLE_EXISTS` / `ER_DUP_KEYNAME`.
>
> **Never run `pnpm db:push` against production** in any case. It is
> `drizzle-kit generate && drizzle-kit migrate`, and the `generate` half writes a
> NEW migration from whatever `schema.ts` is in your working tree, then applies
> it — so an unmerged branch's schema lands in production.

<details>
<summary>Historical record — how release 0041 was applied</summary>

The original warning read:

> Railway auto-deploys from `main`. Because `railway.json` does **not** run
> migrations on release, pushing this release builds and starts the new code
> while the prod schema is still on the old version. The change is
> **additive**, so reads and audit-logged writes keep working (`logAudit`
> swallows errors), but the new-column **write** paths (upload
> `detectedFormat`, CBN signing, audit chain, `multiRunId`) will error until
> the migration runs. **Apply it now.**

and the migration was applied from a local shell with the Railway CLI injecting
the production `DATABASE_URL`:

```bash
railway link                  # select the reconcileai project/service (once)
railway run pnpm db:migrate   # applies committed migrations only
```

Applying migration `0041` (3 new tables + ADD COLUMN + a safe `varchar`
widening) — additive only, so it was safe on the live database.

</details>


## 3. Deploy the application code

Merge the release to `main` (the deploy branch) and let the host build, or trigger
a manual deploy:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start         # node dist/index.js  (host injects PORT)
```

## 4. Post-deploy smoke checks

- `GET /api/healthz` → 200; `GET /api/health` → DB + LLM provider reported.
- Upload a sample NIBSS/Interswitch CSV → "Detected: …" badge appears.
- Create a multi-channel reconciliation run → one aggregated report.
- Approve a CBN submission → signature block present; `compliance.verifySubmission` returns valid.
- Audit Trail → "Verify Integrity" → chain intact.
- Exception Intelligence settings page loads; toggles persist.
- (Optional, at volume) run the real 500k smoke against the deployed URL:
  ```bash
  SMOKE_BASE_URL="https://reconcileai.vip" SMOKE_COOKIE="app_session_id=<jwt>" \
    node --max-old-space-size=4096 --import tsx scripts/smoke-500k.ts
  ```
  Asserts completion + match rate + engine time budget; writes `bench-results.json`.

## 5. On-premise (PTB) extras

- Set `DEPLOYMENT_MODE=on_premise` + `EGRESS_ALLOWLIST`; the server **refuses to
  start** on a leaky config and logs the enforced posture.
- Confirm the in-app header shows **"On-Premise · Egress Blocked"** and
  `system.residencyStatus` reports `enforced: true`.

## Rollback

Code: redeploy the previous commit. Schema: the migration is additive, so a code
rollback needs no DB rollback (new columns/tables are simply unused).
