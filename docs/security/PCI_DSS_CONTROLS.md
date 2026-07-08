# PCI DSS Engineering Controls — ReconcileAI

> **Gap-closure plan WS-2 (Gap 5 / CI Rec 2).** The engineering half of the PCI DSS
> track: scope analysis, the implemented-control matrix (with file references, so the
> QSA can verify claims in code), verification status for infrastructure controls, and
> the items owned by the process track. Companion documents:
> `docs/security/RLS_AUDIT.md` (tenant isolation), `docs/exception-intelligence-dpia.md`
> (data protection). July 2026.

## 1. Scope analysis (to be confirmed in the QSA scoping workshop)

ReconcileAI reconciles **settlement and transaction reference data** — references,
amounts, dates, channels, masked card identifiers as they appear in settlement files.
The platform does **not** process authorizations, store full PANs, track data, CVV, or
PIN blocks, and never initiates card transactions.

- **Working hypothesis:** SAQ A-EP or SAQ D (service provider) — per the gap-closure
  plan, "most reconciliation platforms that handle transaction reference data (not full
  PANs) qualify for SAQ A-EP or SAQ D."
- **Scope risk to raise with the QSA:** settlement files uploaded by card-issuing
  clients (e.g. LAPO Interswitch settlement exports) could contain truncated or, in a
  misconfigured export, full PANs. Mitigations: uploads are org-scoped, encrypted at
  rest, access-controlled (§3.2), and the engineering backlog includes a PAN-pattern
  scrubber on ingest if the QSA requires it.
- **Process owner:** CTO. Timeline per plan — M1 scoping workshop → M1–2 gap
  assessment → M2–4 remediation → M4–6 SAQ + AOC published on the website.
  Budget ₦2.3M–₦4.5M one-time; ₦1.5M–₦2.5M/yr maintenance.

## 2. Remediation package status (plan items 1–6)

| # | Plan item | Status |
|---|---|---|
| 1 | Rate limiting on all public API endpoints | **DONE** — see §3.1 |
| 2 | Owner-based ACL on storage access | **DONE** — see §3.2 |
| 3 | Encryption-at-rest + TLS verification | **VERIFICATION DOCUMENTED** — see §4 (infra checks for the CTO/QSA) |
| 4 | Audit-logging completeness | **CORE PATHS DONE, matrix below** — see §3.3 |
| 5 | Vulnerability scanning + remediation cycle | **BASELINE DONE + policy** — see §5 |
| 6 | On-prem control set documented | **DONE** — see §6 |

## 3. Implemented controls (verifiable in code)

### 3.1 Access throttling (PCI DSS Req. 8.3.4 / 6.4.2 spirit)

| Surface | Limit | Where |
|---|---|---|
| REST Developer API (`/api/v1/*`) | 60 req/min per API key (IP fallback), applied **before** key validation so key brute-forcing is throttled | `server/api/gateway.ts` |
| tRPC public API (`publicApi.*`) | 60 req/min per key | `server/publicApiRouter.ts` |
| Sandbox | 30 req/min per IP | `server/api/gateway.ts` |
| Magic-link request (`auth.requestMagicLink`) | per-email 60s cooldown **plus** 10 req/15min per IP; response always generic (no enumeration/throttle signal) | `server/routers.ts` |
| Magic-link consume (`GET /api/magic-login`) | 20 req/15min per IP | `server/_core/index.ts` |
| Inbound CBS webhooks | HMAC-verified against raw body; idempotent on event id | `server/_core/index.ts` + `server/connectors/woodcore/webhooks.ts` |
| Scheduled endpoints (`/api/scheduled/*`, `/api/woodcore/sync`) | shared-secret header (`x-sync-secret`) | `server/_core/index.ts` |

Limiter implementation: `server/rateLimiter.ts` (fixed-window, in-process — correct for
the single-instance deployment; moves to Redis with the queue when horizontally scaled).

### 3.2 Storage access control (Req. 7 — restrict access by business need-to-know)

- The storage proxy (`/manus-storage/<key>`, `server/_core/storageProxy.ts`) previously
  served any object to any key-string holder. It now requires an authenticated
  session, enforces the **org-scoped key convention** (`org/<organizationId>/…`,
  helpers `orgScopedKey`/`orgIdFromKey` in `server/storage.ts`), and denies
  cross-organization access (super admins excepted).
- **Documented caveat:** legacy keys written before the convention have no owner
  prefix — they are served to authenticated users only (never anonymously). New
  org-owned writes must use `orgScopedKey`. Backfill/migration of historical objects
  is a QSA-visible open item.
- Presigned URLs expire (6-day SigV4 TTL); the proxy re-presigns per request with
  `Cache-Control: no-store`.

### 3.3 Audit logging (Req. 10 — log and monitor all access)

| Path | What is logged | Where |
|---|---|---|
| tRPC mutations (75+ call sites) | actor, action, entity, details, IP, user-agent → `audit_logs` | `logAudit` in `server/routers/shared.ts` |
| Storage access | actor, key, allow/deny decision, IP → `audit_logs` (`storage_access` / `storage_access_denied`) | `server/_core/storageProxy.ts` |
| REST API requests | org, API key, endpoint, method, status, latency → `api_ingestion_logs` | `server/api/gateway.ts` |
| Webhook deliveries | per-attempt status, response code, error → `webhook_deliveries` | `server/webhookDelivery.ts` |
| Compliance actions | dedicated `cbn_audit_log` + `platform_audit_logs` | CBN module / super-admin routers |
| Reconciliation lifecycle | job completion audit entries incl. engine stats | `server/routers.ts` (`complete_reconciliation`) |

**Completeness posture:** every *mutating* procedure in the sensitive domains
(reconciliation, exceptions, users, webhooks, API keys, templates, compliance) logs via
`logAudit`. High-volume *read* procedures log selectively (e.g. `reconciliation.get`
logs data access; list endpoints do not). The QSA gap assessment decides whether
read-path logging must widen; the `logAudit` helper makes each addition a one-liner.

### 3.4 Authentication & session controls (Req. 8)

- Passwordless magic-link sign-in: single-use, 72h expiry, high-entropy tokens
  (`server/magicLinkService.ts`); consume endpoint throttled (§3.1).
- Sessions: JWT HS256 (`jose`), `app_session_id` cookie; `JWT_SECRET` from env.
- SSO (Google OAuth2 / Microsoft Entra ID) is per-org opt-in; super admins are
  excluded from SSO by policy (see `rule-sso-policy` / auth routers).
- API keys: SHA-256 hashed at rest (`api_keys.keyHash`) — plaintext never stored;
  shown once at creation; expiry + active flags enforced in `validateApiKey`
  (`server/apiIngestionService.ts`). Requests act as the key owner (role guards apply).
- Webhook secrets: 32-byte random, HMAC-SHA256 signatures on every delivery.

### 3.5 Tenant isolation (Req. 7)

Application-layer row scoping with a **mechanical ratchet**: every table in every
schema must be classified or CI fails (`server/rlsAudit.test.ts`; prose in
`docs/security/RLS_AUDIT.md`). Per-tenant envelope encryption keys and tenant rate
limits landed with the tenancy hardening track.

## 4. Infrastructure verification (item 3 — for the CTO to confirm, QSA to evidence)

| Control | Expected state | How to verify |
|---|---|---|
| DB encryption at rest | TiDB Cloud/Railway MySQL encrypt storage by default | Provider console → cluster security settings; capture screenshot for QSA evidence pack |
| Object storage encryption at rest | Cloudflare R2 encrypts all objects at rest (AES-256, provider-managed keys) | R2 documentation reference + bucket settings screenshot |
| TLS in transit — public edge | Cloudflare proxy, SSL mode **Full (strict)** | Cloudflare dashboard → SSL/TLS; `curl -sI https://www.reconcileaiafrica.com` |
| TLS — app → DB | `DATABASE_URL` must carry TLS params (TiDB requires TLS) | inspect Railway env; connection string `ssl` flags |
| TLS — app → R2/LLM/Resend | HTTPS endpoints only; on-prem egress guard blocks non-allowlisted hosts | `server/_core/egress.ts` |
| Secrets management | env-injected (Railway variables); no secrets in repo | repo scan (see §5); `docs/env.example.md` documents every variable |

## 5. Vulnerability management (item 5)

- **Baseline pass (July 2026):** `pnpm audit` 138 → **94** findings; criticals 3 → **1**.
  Fixed: `jspdf` → ^4.2.1 (HTML injection), `fast-xml-parser` forced ≥5.3.5 (entity
  encoding bypass), `dompurify` forced ≥3.4.9 (both advisories) — via `pnpm.overrides`.
- **Accepted risk (documented):** the remaining critical is Vitest's UI-server advisory
  — dev-dependency only; the UI server never runs in CI or production. Clears with the
  planned Vitest v3 major upgrade.
- **Policy:** criticals fixed immediately; highs triaged each release; `pnpm audit` run
  quarterly at minimum and before every QSA assessment. Quarterly ASV scans and the
  annual penetration test are procured through the QSA engagement (process track).

## 6. On-premise control set (item 6 — sales asset in the assessment)

The on-prem deployment (`deploy/on-prem`, Option 3 in the deployment-modes doctrine)
implements several PCI controls **by design**, strengthening the assessment story for
card-issuing clients:

- **Network segmentation by construction:** the entire platform runs inside the bank's
  network; `DEPLOYMENT_MODE=on_premise` activates the egress guard — outbound calls
  only to `EGRESS_ALLOWLIST` hosts, enforced at every call site (`server/_core/egress.ts`),
  with a startup assertion that fails fast on misconfiguration.
- **No third-party data processors:** local LLM (train-once-on-GPU / run-on-CPU
  doctrine) — no transaction data leaves the building, including for AI diagnosis.
- **Same auth/audit/ACL surface:** the controls in §3 are deployment-mode independent.
- **Cross-institution intelligence:** only the anonymised categorical tuple
  (k-anonymity ≥3, `assertNoPII` scrub) may sync out, and only to an allowlisted
  endpoint — see the DPIA.

## 7. Open items for the QSA engagement

1. Confirm SAQ level (A-EP vs D service-provider) in the scoping workshop.
2. Decide on ingest-time PAN-pattern scrubbing for client settlement uploads.
3. Legacy storage-key backfill to the org-scoped convention.
4. Read-path audit-logging breadth (per gap assessment).
5. ASV scan vendor + pen-test scheduling (budget line already approved in the plan).

*Success criteria (plan): scoping M1 · gap report M2 · critical controls M4 (engineering
package: done ahead of schedule) · AOC published M6 · zero PCI objections in sales.*
