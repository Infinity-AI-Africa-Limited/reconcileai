# External Security Architecture Review — Engagement Brief

*Prepared July 2026 by Claude (acting CTO) for Richard Anwanakak (CEO).
This is the package an external security consultant needs to scope, quote,
and execute an architecture review of ReconcileAI. Richard owns vendor
selection and spend (per the CTO operating model §2).*

## 1. What ReconcileAI is (one paragraph for the consultant)

Multi-tenant SaaS reconciliation platform for Nigerian banks/MFBs: ingests
transactions from core-banking systems (WoodCore/Fineract live; T24, Mambu,
FLEXCUBE profiles) via webhooks, batch API sync, and CSV; matches them against
GL/settlement records; classifies exceptions with an LLM assist; produces
CBN-facing compliance reports. Node 22 / Express / tRPC / Drizzle on
MySQL-compatible TiDB; React 19 SPA; deployed on Railway behind Cloudflare;
also ships an air-gapped on-prem variant with a local LLM.

## 2. Trust boundaries to review

1. **Tenant ↔ tenant** — app-layer scoping (`server/_core/tenancy.ts`), the
   RLS ratchet (`server/rlsAudit.test.ts` + `docs/security/RLS_AUDIT.md`),
   per-tenant envelope encryption (`server/_core/tenantKeys.ts`).
2. **Internet ↔ platform** — auth surfaces: magic-link, Google OAuth2 +
   Entra ID PKCE (`server/_core/sso.ts`), session JWT (HS256 cookie), inbound
   CBS webhooks (HMAC + idempotency + per-tenant rate limits), public POC
   pages (deliberately public, token-gated), public API (API-key auth).
3. **Platform ↔ CBS partners** — outbound connector credentials (per-tenant
   encrypted), egress guard for on-prem (`server/_core/egress.ts`, fail-closed).
4. **Staff ↔ tenants** — super_admin portal context with org override
   (audited via platform_audit_logs); institution roles (admin/cfo/compliance
   read-only guards).
5. **Platform ↔ LLM/email/storage** — Anthropic API, Resend, S3/R2; what
   tenant data leaves, and the anonymized cross-institution pattern pool
   (`exceptionIntelligence`, documented DPIA in docs/).

## 3. Known weaknesses we are disclosing up front

(From `RLS_AUDIT.md` findings F1–F4 plus:) `exceptions` lacks a direct org
column; 39 legacy tables have nullable `organizationId`; S3 keys not
org-prefixed; sessions are long-lived (1y) JWTs with no server-side
revocation list; rate limiting is in-process (single instance) pending the
BullMQ/Redis scale-out; `wc_*` mirror is single-tenant. We expect the review
to validate our remediation priorities, not discover these.

## 4. Proposed scope & deliverables

- **Scope:** threat model + architecture review of §2 boundaries; targeted
  code review of tenancy, auth (SSO/PKCE/JWT), webhook verification, key
  management; a grey-box pentest of a staging tenant pair (tenant-A vs
  tenant-B isolation attempts) is the highest-value optional add-on.
- **Out of scope:** the air-gapped on-prem variant (separate engagement),
  DDoS resilience (Cloudflare-layer), physical security.
- **Deliverables:** findings report with CVSS-ish severity + reproduction
  steps; remediation-priority workshop (1h); re-test of criticals.
- **What we provide:** this brief, repo read access (or code excerpts under
  NDA), a two-tenant staging environment with seeded data, an architecture
  walkthrough call with the CTO.

## 5. Selection criteria & logistics (for Richard)

- Firm has verifiable **fintech/banking** engagements (CBN-regulated clients
  ideal) and can reference OWASP ASVS / SAMM methodology.
- Ask each candidate for: sample (redacted) report, day rate, staffing
  seniority, re-test policy.
- Budget guidance: a 5–8 day boutique review is typical for this scope;
  multi-tenant isolation pentest adds 2–3 days.
- **Timing gate:** schedule after the F1 (exceptions org-column) migration
  lands, so the review validates the fixed state, not a known gap.
