# Row-Level Security Audit — Multi-Tenant Data Isolation

> **Enforcement companion:** [`server/rlsAudit.test.ts`](../../server/rlsAudit.test.ts) —
> a CI ratchet that enumerates every table in every drizzle schema file and fails
> the build if a table is unclassified or its classification contradicts its actual
> columns. This document is the human-readable half; the test is the enforced half.
> **Both must be updated together when a table is added.**

*Audited: July 2026 · 84 tables across 6 schema files · Auditor: Claude (acting CTO)*

## 1. Isolation model

MySQL/TiDB has no Postgres-style row-level-security policies, so isolation is
enforced at three layers:

| Layer | Mechanism |
|---|---|
| **Application (primary)** | Every org-scoped tRPC procedure resolves its tenant through `server/_core/tenancy.ts` (`resolveOrgScope` / `assertSameOrg`); regular users are hard-locked to their own `organizationId`, super admins pass an explicit override. |
| **Session** | Login paths (magic link, Google, Microsoft) refuse to mint sessions for deactivated organizations (`isOrgLoginAllowed`, fails closed on unknown org ids). |
| **Cryptographic (defense-in-depth)** | Tenant secrets are encrypted under **per-tenant DEKs** (`server/_core/tenantKeys.ts`); a ciphertext leaked across a scoping bug is undecryptable by any other tenant, and `decryptForTenant` refuses cross-tenant ciphertexts before any key lookup. |

## 2. Classification summary (see the test for the per-table list)

| Class | Count | Meaning | Posture |
|---|---|---|---|
| `tenant_required` | 12 | `organizationId NOT NULL` | **The standard for all new tables.** |
| `tenant_nullable` | 39 | has `organizationId`, nullable | Legacy prototype tables (userId-fallback era). Queries must scope by org *and* treat NULL org rows as legacy-private. |
| `derived` | 5 | scoped via parent FK (job, config…) | Acceptable; queries must join to the org-carrying parent. |
| `poc_scoped` | 7 | public demo surface, per-POC tokens | Isolated from tenant data by design. |
| `mirror_single_tenant` | 13 | `wc_*` Fineract mirror (Woodcore POC) | **Known caveat** — see finding F2. |
| `global` | 7 | reference data, platform ops, anonymized pool | Intentionally cross-tenant. |
| `token` | 4 | random-secret keyed | Entropy-gated, not org-gated. |

## 3. Findings & remediation plan

**F1 — `exceptions` has no `organizationId` column (MEDIUM).**
Exceptions are scoped only through `reconciliation_jobs`/`transactions`. Any
query that filters exceptions without joining through the parent risks
cross-tenant reads. *Remediation:* add nullable `organizationId`, backfill from
parent jobs, flip new writes, then tighten queries — scheduled as its own
migration (backfill on a hot table; do it in a quiet window). *Until then:*
the ratchet test documents the constraint; all exception queries must join
through their parent.

**F2 — `wc_*` mirror tables are single-tenant (LOW today, HIGH at 2+ Woodcore DB-mirror tenants).**
The Fineract mirror serves the Woodcore POC only and carries no org column.
Multi-tenant Woodcore clients already ingest via the connector into
`transactions` (org-scoped), so the mirror must **never** be used for a second
institution. *Remediation:* retire the mirror path after the POC converts, or
add `organizationId` to all `wc_*` tables if mirror-mode is ever sold.

**F3 — 39 legacy tables have nullable `organizationId` (LOW, chronic).**
Prototype-era rows carry `organizationId = NULL` and are effectively scoped by
`userId`. *Remediation:* opportunistic backfill + `NOT NULL` tightening,
table-by-table, starting with `transactions` and `reconciliation_jobs` once
the exceptions backfill (F1) proves the pattern.

**F4 — S3 object keys are not org-partitioned (LOW; pre-existing tech-debt item).**
File keys are access-controlled by signed URLs but not prefixed per tenant.
*Remediation:* prefix new uploads with `org/<id>/` and add an ownership check
in `storageGet` (tracked in CLAUDE.md tech-debt table).

## 4. The ratchet rule (for every future PR)

Adding a table? The build fails until it is classified in
`server/rlsAudit.test.ts`. New tenant-data tables **must** be
`tenant_required` (`organizationId NOT NULL` + index). Anything else needs a
justification comment in the classification map and a row in §2/§3 here.
