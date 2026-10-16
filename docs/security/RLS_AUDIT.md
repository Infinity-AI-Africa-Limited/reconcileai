# Row-Level Security Audit — Multi-Tenant Data Isolation

> **Enforcement companion:** [`server/rlsAudit.test.ts`](../../server/rlsAudit.test.ts) —
> a CI ratchet that enumerates every table in every drizzle schema file and fails
> the build if a table is unclassified or its classification contradicts its actual
> columns. This document is the human-readable half; the test is the enforced half.
> **Both must be updated together when a table is added.**

*Audited: 14 October 2026 · 117 tables across 7 schema files · Validator: CI tenant-isolation ratchet*

## 1. Isolation model

MySQL/TiDB has no Postgres-style row-level-security policies, so isolation is
enforced at three layers:

| Layer | Mechanism |
|---|---|
| **Application (primary)** | Every org-scoped tRPC procedure resolves its tenant through `server/_core/tenancy.ts` (`resolveOrgScope` / `assertSameOrg`); regular users are hard-locked to their own `organizationId`, super admins pass an explicit override. |
| **Session** | Login paths (magic link, Google, Microsoft) refuse to mint sessions for deactivated organizations (`isOrgLoginAllowed`, fails closed on unknown org ids). |
| **Cryptographic (defense-in-depth)** | Tenant secrets are encrypted under **per-tenant DEKs** (`server/_core/tenantKeys.ts`); a ciphertext leaked across a scoping bug is undecryptable by any other tenant, and `decryptForTenant` refuses cross-tenant ciphertexts before any key lookup. |

## 2. Classification summary (see the test for the per-table list)

Measured by `server/rlsAudit.test.ts` on 2026-10-14 (117 tables).

| Class | Count | Meaning | Posture |
|---|---|---|---|
| `tenant_required` | 35 | `organizationId NOT NULL` | **The standard for all new tables.** |
| `tenant_nullable` | 45 | has `organizationId`, nullable | Legacy prototype tables (userId-fallback era). Queries must scope by org *and* treat NULL org rows as legacy-private. |
| `derived` | 4 | scoped via parent FK (job, config…) | Acceptable; queries must join to the org-carrying parent. `webhook_deliveries` (WS-4, July 2026) joins through `webhookId → webhooks.organizationId`. |
| `poc_scoped` | 7 | public demo surface, per-POC tokens | Isolated from tenant data by design. |
| `mirror_single_tenant` | 13 | `wc_*` Fineract mirror (Woodcore POC) | **Known caveat** — see finding F2. |
| `global` | 9 | reference data, platform ops, anonymized pool | Intentionally cross-tenant. |
| `token` | 4 | random-secret keyed | Entropy-gated, not org-gated. |

## 3. Findings & remediation plan

**F1 — `exceptions` (and `matches`) had no `organizationId` column — ✅ CLOSED (migration 0078).**
Both tables now carry a nullable `organizationId`, backfilled from the parent
reconciliation job. New writes set it directly: the reconciliation runner reads
the job's org once per run, and the SHOPLINE sync path — which uses a synthetic
`jobId: 0` and so had no parent to derive from at all — sets it from the store's
organization.

The backfill ran in the migration rather than a quiet window: `matches` holds
~16k rows and `exceptions` ~742, so it is milliseconds, not an online schema
change. It is idempotent (`WHERE organizationId IS NULL`).

Nullable, not `NOT NULL`: ~2,000 matches and ~42 exceptions reference a `jobId`
with no surviving job, so no owner can be derived. NULL there means
"legacy / underivable" — the same meaning it carries on `transactions` — and is
matched by `orgFilter()` rather than being silently invisible.

What this unlocked: `getExceptions` is now scoped like every other reader (its
exemption in `readScopeRatchet.test.ts` is deleted), `updateMatchStatus` and
`updateException` take a required `organizationId` and their two entries in
`tenancyRatchet.test.ts` are gone, and `getPendingReviewMatches` — which
accepted `userId`/`isAdmin` and ignored both, returning every tenant's review
queue — is scoped. Classification moved `derived` → `tenant_nullable`.

**F2 — `wc_*` mirror tables are single-tenant (LOW today, HIGH at 2+ Woodcore DB-mirror tenants).**
The Fineract mirror serves the Woodcore POC only and carries no org column.
Multi-tenant Woodcore clients already ingest via the connector into
`transactions` (org-scoped), so the mirror must **never** be used for a second
institution. *Remediation:* retire the mirror path after the POC converts, or
add `organizationId` to all `wc_*` tables if mirror-mode is ever sold.

**F3 — 39 legacy tables have nullable `organizationId` (LOW, chronic).**
Prototype-era rows carry `organizationId = NULL` and are effectively scoped by
`userId`. *Remediation:* opportunistic backfill + `NOT NULL` tightening,
table-by-table, starting with `transactions` and `reconciliation_jobs`. The F1
backfill has now proven the pattern (parent-derived, idempotent, nullable where
no parent survives) — though note `transactions` carries ~35M orgless rows, so
that one needs the online schema-change treatment F1 did not.

**F4 — S3 object keys are not org-partitioned (LOW; pre-existing tech-debt item).**
File keys are access-controlled by signed URLs but not prefixed per tenant.
*Remediation:* prefix new uploads with `org/<id>/` and add an ownership check
in `storageGet` (tracked in CLAUDE.md tech-debt table).

**F5 — Outbound webhooks fanned every tenant's events to every tenant — ✅ CLOSED (2026-10-14).**
`webhooks` was classified `tenant_nullable`, but nothing read it by tenant:
`dispatchWebhookEvent` selected `WHERE isActive = true` and no caller named a
tenant, so `reconciliation.completed` (job id, match rate, counts),
`exception.created/resolved/escalated/in_review`, `upload.completed`,
`reconciliation.failed` and `kpi.threshold.breached` from tenant A went to any
tenant's webhook subscribed to that event or to `"*"`. `webhooks.create` never
set `organizationId`, so such rows could not be listed or deleted by tenant
either.

*Measured exposure (read-only, production, 2026-10-14):* 0 webhooks, 0
deliveries — no event has crossed a tenant boundary. The leak was also latent
for a second reason: `webhooks.create` stored `events` as a JSON *string*,
which dispatch reads as no subscriptions, so no API-created webhook ever fired.
Fixing that encoding without the tenant scope would have made the leak live.

*Remediation:* dispatch takes a required tenant id (`isTenantId`) and reads only
that tenant's active webhooks (`activeWebhooksOfTenant`), with an in-memory
second barrier; every caller passes the tenant of the job, batch or exception
the event is about (an exception event only after the change committed inside
that tenant — `updateException` matched a row, or a closure through
`afterExceptionClosed`, whose two paths lock the case by tenant and id); `webhooks.create` records the creator's organisation and
refuses an account with none; `webhooks.list` is per organisation and never
returns the signing secret; upload batches now record their organisation. Rows
with `organizationId` NULL fail closed (they receive nothing). Enforced by
`server/webhookDelivery.tenancy.test.ts` (structural: every `webhooks` read
names `webhooks.organizationId`; every dispatch names a tenant), the callers'
tenants by `server/webhookTenancy.callers.test.ts`, and on a real database over
real HTTP by `server/webhookTenancy.db.test.ts`.

*Lesson for the ratchets:* `readScopeRatchet` accepted the dispatcher because
it checks that a select on a tenant table HAS a where clause, and scans only
`db.ts`. A where clause is not a tenant predicate, and tenant tables are read
outside `db.ts`. The first version of the new ratchet repeated the mistake one
level down (Greptile, #196): it accepted `webhooks.organizationId` anywhere in
the query, so a column merely selected passed. It now accepts only shapes that
provably restrict rows — `eq(webhooks.organizationId, x)`, alone or as a term
of `and(...)` — and its own tests feed it the shapes that look scoped and are
not (`or`, `not`, `ne`, a tautology, a variable, a selected column).

**F5a — Server-side request forgery through webhook destinations — ✅ CLOSED (2026-10-14).**
Fixing the events encoding made webhooks fire, and cloud mode checked no
destination: an admin could register a loopback, private or metadata address
and have the delivery worker POST to it. Every destination now passes
`server/outboundDestination.ts` at registration, at dispatch and at the socket
(see CLAUDE.md §9C). **Open in the same class:** the SFTP credential host, the
bucket-ingestion endpoint and the WoodCore connector base URL are
tenant-configured and unguarded.

## 4. SHOPLINE connector tables (Phase 1, July 2026)

Three new tables added in the SHOPLINE Phase 1 connector. All three are
classified `tenant_required` — `organizationId NOT NULL` with an index,
following the post-hardening standard for all connector tables.

| Table | Class | Notes |
|---|---|---|
| `sl_connector_stores` | `tenant_required` | One row per SHOPLINE merchant store, scoped to the org that installed the connector. |
| `sl_connector_tokens` | `tenant_required` | Encrypted OAuth access/refresh tokens; FK to `sl_connector_stores` which is itself org-scoped. |
| `sl_connector_webhook_events` | `tenant_required` | Idempotent webhook event log; scoped to the org that owns the store. |

## 5. The ratchet rule (for every future PR)

Adding a table? The build fails until it is classified in
`server/rlsAudit.test.ts`. New tenant-data tables **must** be
`tenant_required` (`organizationId NOT NULL` + index). Anything else needs a
justification comment in the classification map and a row in §2/§3 here.

## 6. Corporate B2B controlled-pilot tables (August 2026)

| Table | Class | Notes |
|---|---|---|
| `corporate_b2b_pilot_configs` | `tenant_required` | One auditable policy/evidence register per Corporate B2B customer. It records only the customer’s declared no-write scope, source-contract readiness, recovery posture and approval references; it never stores payment authority. |
| `corporate_b2b_pilot_sources` | `tenant_required` | Metadata-only evidence-source registry. Provider credentials and source-file contents stay in the approved customer-owned ingestion route, never in this table. |

## 7. Governed-control evidence tables (October 2026)

| Table | Class | Notes |
|---|---|---|
| `control_source_contracts` | `tenant_required` | Versioned customer control-input contract: source role, delivery route, local cut-off, schema version, control-total requirement, owner and approval reference. It contains no source credential or source-file payload. |
| `control_batch_manifests` | `tenant_required` | Per-delivery control evidence bound to one source-contract version: expected and received count/value evidence, mapping/policy versions, schema state and duplicate-delivery result. Monetary totals are stored as exact decimal strings; the record is not a transaction ledger. |
| `control_policies` | `tenant_required` | Immutable tenant-scoped mapping and reconciliation policy registry. It stores a bounded configuration definition, digest, lifecycle state, approval/retirement references, and actor/timestamp evidence; it does not store credentials, raw source rows, or customer identities. |
| `exception_workflows` | `tenant_required` | Governed material-exception workflow: assigned owner, due date, escalation, bounded decision rationale and approved evidence locator, distinct approval evidence, and closure outcome. It never stores raw source payloads or credentials. |
| `exception_workflow_events` | `tenant_required` | Append-only history of every governed workflow step (start, reassignment, escalation, decision and its revisions, approval, closure) with its actor, time and narrative, so a revised decision or superseded approval is never lost. Rows are only inserted; reads are scoped to the tenant and workflow. No raw source payloads or credentials. |

## 8. Shopify public-app connector tables (September 2026, PR #134)

Defined in `drizzle/shopify_schema.ts`, initially in migration `0095` and extended
for data-request completion in migration `0099`. These tables reached a
green suite **unaudited** on the PR's first revision: `server/rlsAudit.test.ts`
read a hand-maintained list of schema modules, and `shopify_schema.ts` was not on
it, so none of its tables was ever collected — and therefore never reported as
unclassified. The ratchet now also asserts that every schema file listed in
`drizzle.config.ts` is audited, so a new schema file cannot repeat this.

| Table | Class | Notes |
|---|---|---|
| `shopify_connector_stores` | `tenant_required` | One row per installed Shopify store, owned by the merchant workspace created at install. `statusReason` records why a store left `active` (ownership unverified, refresh rejected, token write failed, uninstalled). |
| `shopify_connector_tokens` | `tenant_required` | Expiring offline access + refresh tokens, encrypted under the tenant's envelope key. Every write after a refresh is fenced on the row id and `rotationVersion`. |
| `shopify_sync_cursors` | `tenant_required` | Order-sync watermark and latest outcome per store, written by every sync cycle; also the store's manual-request counter (`syncRequestCount`). |
| `shopify_sync_requests` | `tenant_required` | One row per manual "refresh now" request (migration `0097`): status, the failure code and times only. Every read and write carries `storeId` and `organizationId`. |
| `shopify_webhook_events` | `tenant_nullable` | Digest-only delivery ledger. A verified delivery for a shop with no store record is acknowledged and recorded without inventing a tenant. |
| `shopify_privacy_requests` | `tenant_nullable` | Hashed evidence for Shopify's mandatory compliance topics; same reasoning as `sl_connector_gdpr_requests`. |
| `shopify_privacy_request_selectors` | `tenant_required` | Minimal child records for future customer-topic fulfilment. Provider IDs are tenant-encrypted and tenant-keyed blind-indexed; lookups include `organizationId`, and no raw payload or direct identity field is retained. |
| `shopify_privacy_data_request_jobs` | `tenant_required` | Durable, leased execution state for `customers/data_request`. Carries only internal scope and bounded status/failure codes; authoritative selectors stay in the encrypted child table. |
| `shopify_privacy_customer_redaction_jobs` | `tenant_required` | Durable, leased execution state for `customers/redact`. It retains only internal scope, bounded failure/checkpoint codes and aggregate deletion evidence; encrypted selectors are destroyed only after the transaction’s postcondition passes. |
| `shopify_order_redaction_tombstones` | `tenant_required` | Permanent re-import barrier for an exact Shopify order. It contains only tenant/store-scoped versioned HMAC digests—not a provider order ID, selector ciphertext or payload—and is checked under the store write lock before sync persists any order. |
| `shopify_privacy_queue_outbox` | `derived` | Transactional dispatch intent keyed only by internal job id and kind. It deliberately contains no organization/store/provider identifiers, selector values, hashes, domains, URLs, or customer data; tenant scope is loaded from the job after dequeue. |
| `shopify_privacy_artifacts` | `tenant_required` | Metadata for a private org-scoped data-request object: key, digest, size, expiry and delivery evidence. It never persists a presigned URL or selector. Download additionally requires the active store-claiming tenant admin. |
| `shopify_shop_redaction_jobs` | `tenant_required` | Leased work record for a verified `shop/redact` request (`server/connectors/shopify/shopRedaction.ts`). The worker erases only a FENCED tenant (`deletionState = redacting`; a live organisation goes to `manual_review`), refuses (also to `manual_review`) while a bucket-ingestion source reads from the platform's own bucket, waits out the tenant-upload deadline from its first claim and any data-request export still holding a lease, deletes every stored object first — rows' keys plus everything listed under `org/<id>/` and the tenant users' pre-prefix export folders — then, under the organisation lock and after proving no file appeared since, erases every tenant table in one transaction. The erasure is tenant-wide, so every shop/redact job of the tenant is settled with its own receipt and removed with it. |
| `shopify_shop_redaction_receipts` | `global` | The only record a completed `shop/redact` leaves: run id, keyed request digest, manifest version, fixed numeric counters and completion time. No organisation, store, domain, webhook id or payload, so it outlives the tenant without identifying it. |
| `shopify_install_leases` | `global` | Pre-tenant platform lock serialising installations per shop domain (one token exchange in flight at a time; the authorization-code path is retired). Lease id and expiry only; no tenant data. |
