# Data Protection Impact Assessment — ReconcileAI Exception Intelligence Layer

**Status:** Living document · **Owner:** Infinity AI Africa Limited · **Last updated:** July 2026 (WS-5 network-deepening audit — §9)
**Frameworks:** Nigeria Data Protection Act 2023 (NDPA) / NDPR, GDPR principles (data minimization, purpose limitation, privacy by design)

## 1. Purpose

The Exception Intelligence Layer lets institutions benefit from how *other* institutions resolve
similar reconciliation exceptions ("the exception one bank resolves becomes the answer another bank
gets tomorrow") **without any transaction data or personal data leaving a deployment**. It is the
mechanism behind the investor "network effect" claim, engineered to coexist with the Premium Trust
Bank on-premise guarantee that "transaction data never leaves your infrastructure."

## 2. What is processed and shared

Only a **pattern signature** — a fixed tuple of coarse, non-personal categorical values:

| Field | Example | Notes |
|---|---|---|
| `exceptionCategory` | `damage_deduction` | enum-like category |
| `amountBucket` | `100k-1m` | coarse band, never a raw amount |
| `counterpartyType` | `distributor` | a TYPE, never a counterparty identity |
| `deductionType` | `damage` | category |
| `resolutionActionClass` | `credit_note` | one of a fixed set; the free-text resolution is mapped to it and never shared |
| `outcome` | `resolved` | enum |

**Never shared:** amounts, transaction references, account numbers, names, descriptions, narrations,
free-text resolution/reasoning, dates, currency-with-amount, IP addresses, user identities.

The contributing organization is represented by a **one-way pseudonym** (`SHA-256(salt:orgId)`); the
pool never receives the organization id or name.

## 3. Why this is not personal data

The shared signatures are aggregate, categorical, and stripped of identifiers and free text. They
cannot, alone or in combination, identify a natural person or a specific transaction. Under NDPA/NDPR
and GDPR, fully anonymized data falls outside the scope of personal data. Two engineered safeguards
keep it that way:

- **Field allowlist + runtime PII-scrub** (`assertNoPII` in `server/exceptionIntelligence.ts`): a
  payload may contain *only* the six allowlisted keys, and every value must be a short categorical
  token. Anything resembling free text, an identifier, an email/path, a long digit run, or a currency
  amount is rejected and never transmitted.
- **k-anonymity gate** (`K_ANON_THRESHOLD = 3`): a pattern is only served once corroborated by at
  least 3 distinct organizations, preventing singling-out of any one contributor.

## 4. Lawful basis & data-subject rights

Because no personal data is shared, no individual lawful basis is engaged for the shared payload. For
the *local* signatures derived from an institution's own resolved exceptions, processing is under the
institution's legitimate interest in reconciliation quality, within its existing controller role.
Rights are preserved: cross-institution sharing is **off by default** — both `shareEnabled` and `consumeEnabled` initialise to `false` in `getSettings`. An institution must explicitly opt in. Once opted in, contribution and consumption are coupled (reciprocity rule: you cannot consume without contributing). Either flag can be disabled at any time via `exceptionIntelligence.updateSettings`, and disabling contribution immediately stops any future sharing.

## 5. Data flows & residency

- **Cloud (multi-tenant):** the pool is computed in-place by aggregating signatures across orgs
  (`aggregateSharedPatterns`). No external network calls.
- **On-premise:** sharing/consuming uses `EXCEPTION_INTEL_ENDPOINT`. This is the **only** egress
  permitted in `DEPLOYMENT_MODE=on_premise`, and only when its host is on `EGRESS_ALLOWLIST`. Every
  outbound payload passes `assertEgressAllowed` (residency guard) **and** `assertNoPII` before send.

## 6. Controls summary

| Risk | Control |
|---|---|
| Re-identification of a transaction | Coarse buckets + categorical-only fields; no raw values |
| Singling out a contributor | k-anonymity (≥3 orgs) before a pattern is served; pseudonymized contributor |
| PII leakage via free text | Free-text resolution mapped to a fixed action class; `assertNoPII` blocks any free-text/identifier value |
| Unwanted egress (on-prem) | Residency egress guard + single allowlisted endpoint |
| Lack of choice | Per-org opt-in for both contribution and consumption; **default-off** (both `shareEnabled` and `consumeEnabled` initialise to `false`); institution must explicitly enable; documented in settings UI |
| Lack of transparency | Settings page lists exactly which fields are shared and the current posture |

## 7. Residual risk

Low. The combination of categorical-only fields, the runtime scrub, and k-anonymity means the shared
data is non-personal and non-identifying. The main residual operational risk is a misconfigured
`EXCEPTION_INTEL_ENDPOINT` in on-prem mode pointing off-box — mitigated by the egress allowlist (it
must be explicitly allowlisted) and the pre-send scrub.

## 8. Review

Re-assess on any change to the shared field set, the k threshold, or the sync transport.

## 9. WS-5 network-deepening audit (July 2026)

Recorded per the gap-closure plan (docs/GAP_CLOSURE_PLAN.md, WS-5 "anonymisation review").
Scope: all write-paths and read-paths of the learning flywheel, plus the new network KPI.

**Write-path audit (every channel verified):**

| Channel | Institution-scoped tier | Anonymised shared tier |
|---|---|---|
| Main app exceptions (`exceptions.resolve`) | `agentMemory` insert | `deriveSignature` → `recordLocalSignature` |
| Super Agent (`superAgent.addMemory`) | `agentMemory` insert | `deriveSignature` → `recordLocalSignature` |
| Woodcore (`wc_exceptions` reviews) | resolution history consumed by Layer 3 (`enrichItemWithInstitutionalMemory`) — wired July 2026 | none (single fixed test tenant, no org id) |
| Generic POC (`poc_exceptions` reviews) | resolution history consumed by Layer 3 (`applyPocInstitutionalLearning`) | none by design — POCs have no organization; pool participation begins at tenant conversion |
| Mobile money (`mm_exceptions` reviews) | resolution history consumed by Layer 3 (`applyInstitutionalLearning`) | none by design (same POC scoping) |

**Read-path audit:** consumers of the shared pool are `superAgent.getSimilarCases` and (new, July
2026) the deferred AI-analysis pass on reconciliation jobs, which folds pool patterns into the LLM
diagnosis prompt via `formatNetworkGuidance`. That guidance string is built exclusively from the
categorical tuple + counts (action class, outcome, contributor count, observation count) and is
covered by a unit test asserting it contains no identifiers, digit runs, currency amounts, or
email-like tokens. Both consumers pass through `getSharedRecommendations`, which enforces the
reciprocity opt-in and the k-anonymity gate server-side.

**Aggregation audit:** `aggregateSharedPatterns` reads `organizationId` solely inside
`count(distinct …)` to compute k; the shared pool table (`shared_exception_patterns`) has no
organization column, so contributor identity is structurally impossible to store, not merely
filtered out.

**New telemetry (July 2026):** per-org `consumeRequests`/`consumeHits` counters on
`exception_intelligence_settings` count pool lookups only — no category, amount, or content is
recorded. They power the super-admin "recommendations informed by cross-institution patterns %"
KPI (`exceptionIntelligence.networkStats`), which reports aggregates only; its per-category
coverage list includes k-anonymous patterns exclusively, so below-threshold (attributable)
patterns never appear even in the internal view.

**Findings:** no anonymisation gaps. One correctness gap was found and fixed — the Woodcore channel
previously recorded reviews without feeding any learning tier (a comment-only integration); it now
consumes its own resolution history. Residual-risk assessment in §7 unchanged.
