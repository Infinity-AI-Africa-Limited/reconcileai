# Data Protection Impact Assessment — ReconcileAI Exception Intelligence Layer

**Status:** Living document · **Owner:** Infinity AI Africa Limited · **Last updated:** June 2026
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
Rights are preserved: an institution can disable contribution and/or consumption at any time
(`exceptionIntelligence.updateSettings`), and disabling contribution stops any future sharing.

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
| Lack of choice | Per-org opt-out for both contribution and consumption; default-on, documented |
| Lack of transparency | Settings page lists exactly which fields are shared and the current posture |

## 7. Residual risk

Low. The combination of categorical-only fields, the runtime scrub, and k-anonymity means the shared
data is non-personal and non-identifying. The main residual operational risk is a misconfigured
`EXCEPTION_INTEL_ENDPOINT` in on-prem mode pointing off-box — mitigated by the egress allowlist (it
must be explicitly allowlisted) and the pre-send scrub.

## 8. Review

Re-assess on any change to the shared field set, the k threshold, or the sync transport.
