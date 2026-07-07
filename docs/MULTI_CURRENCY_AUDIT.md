# Multi-Currency Audit — NGN Assumptions (Gap-Closure Plan WS-6, M6)

> Sweep of every place the platform assumes Naira, per WS-6 step 1. Each finding is
> marked **FIXED** (in the WS-6 build), **SAFE** (already currency-aware), or
> **DEFERRED** (out of WS-6 scope, with reason). July 2026.

## Groundwork that already existed

- `transactions.currency` varchar(3) default NGN — every transaction row carries its currency. **SAFE**
- `SUPPORTED_CURRENCIES` (drizzle/schema.ts): 15 currencies — 12 African + USD/EUR/GBP for correspondent settlements. **SAFE**
- `organizations.baseCurrency`, `channels.defaultCurrency` — per-tenant / per-channel defaults. **SAFE**
- Mobile money module: fully currency-aware since the Uganda build (`fmtMoney`, currency-scaled priorities, `mm_runs.currencyCode`). **SAFE**
- `categorizeException` already skipped cross-currency pairs in its amount-mismatch and timing checks, and emitted `currency_mismatch` for same-ref/different-currency. **SAFE** (extended by the FX work below)
- `getAIAnalysis` prompt already prints `${transaction.currency} ${amount}`. **SAFE**

## Findings

### server/reconciliationEngine.ts — the matching engine (CRITICAL)

| # | Finding | Status |
|---|---|---|
| 1 | **Pass 1 (exact ref)** matched on ref + numeric amount with no currency check — `REF123 / 500.00 USD` matched `REF123 / 500.00 NGN` silently | **FIXED** — same-currency required; cross-currency same-ref pairs now fall through to FX analysis |
| 2 | **Pass 2 (amount tolerance + date window)** bucketed targets purely by amount+date — a USD leg could tolerance-match an NGN leg on the same day | **FIXED** — cross-currency candidates skipped in the scan |
| 3 | **Pass 3 (fuzzy)** compared amounts/descriptions with no currency guard | **FIXED** — cross-currency candidates skipped |
| 4 | **detectDuplicates** key = `ref\|amount\|date\|channel` — same numeric amount in two currencies flagged as duplicates | **FIXED** — currency added to the key |
| 5 | **detectReversals** indexed candidates by amount only — a reversal could pair with an original in a different currency | **FIXED** — currency added to the amount index key |
| 6 | No FX category: a matched-reference pair whose amounts differ because of exchange-rate movement between transaction date and settlement date had no name — it fell into `currency_mismatch` regardless of whether it was a rate variance or a booking error | **FIXED** — new `fx_rate_variance` category with implied-rate computation and date-gap narrative (see below) |

### Schema

| # | Finding | Status |
|---|---|---|
| 7 | `reconciliation_jobs` had no currency column — a job's reports could not state what currency they were denominated in | **FIXED** — `currency` varchar(3) default NGN, set to the job's dominant transaction currency at completion |
| 8 | `exceptions` had no currency column — amount context required a join to `transactions`, and API/UI consumers assumed ₦ | **FIXED** — `currency` varchar(3) default NGN, denormalized from the transaction at insert |

### server/poc-engine.ts

| # | Finding | Status |
|---|---|---|
| 9 | `runFullPoc` hardcoded `const currency = "NGN"` even though `extractTransactions` detects the statement currency — the detected value was returned to the client at upload and then **dropped** (never stored) | **FIXED** — `poc_uploads.currency` column added; ingest stores the detected currency; `runFullPoc` uses statement→ledger→NGN precedence |
| 10 | `fmt()` hardcoded ₦ and `priorityFor()` used NGN thresholds in Layer-3 explanations | **FIXED** — both currency-aware (same thresholds table as the mobile money engine) |

### server/woodcore-engine.ts

| # | Finding | Status |
|---|---|---|
| 11 | Layer-3 explanations hardcode ₦ formatting; `getPriorityLevel` uses NGN thresholds | **DEFERRED** — the Woodcore module reads a single Fineract test tenant whose GL is NGN-denominated (`ReconciliationConfig.currencyCode` is already plumbed for the queries); localise display when a non-NGN CBS tenant exists |

### KPI amount buckets

| # | Finding | Status |
|---|---|---|
| 12 | `exceptionIntelligence.AMOUNT_BUCKETS` ("0-100k / 100k-1m / 1m+") are NGN-denominated and feed the anonymised pattern-pool tuple | **DEFERRED** — changing the bucket definition alters the shared-signature identity (`signatureHash`) and the DPIA-reviewed field set; cross-currency normalisation needs an FX-rate source. Revisit when the first non-NGN tenant contributes patterns. Buckets remain coarse and categorical, so no correctness risk — only cross-currency comparability. |

### UI

| # | Finding | Status |
|---|---|---|
| 13 | `AgeTracker` money formatter hardcoded ₦ for exception amounts | **FIXED** — formats with the exception's currency |
| 14 | Exceptions page category filter had no FX option | **FIXED** — `fx_rate_variance` in filters + labels |
| 15 | Marketing/POC pages (Home, landings, LAPO/Salad/Woodcore POC, CBN module) hardcode ₦ in copy and demos | **DEFERRED** — deliberate: these are Nigeria-market pages; the multi-currency capability statement was added to the platform feature copy instead |

## fx_rate_variance — detection rule (Moat Gate compliance)

Same normalized reference on both legs, different currencies:
- amounts **equal** → `currency_mismatch` (a currency-code booking error, not a rate issue)
- amounts **differ** → `fx_rate_variance`: the implied rate (larger ÷ smaller) is computed and
  cited, the transaction-date vs settlement-date gap is named as the likely driver, and the
  diagnosis prompt instructs the AI to reference the applicable rate source (CBN/NAFEM for NGN
  legs, ECB for EUR, etc.), verify the contract/deal-slip rate for both dates, and post the
  confirmed difference to the FX revaluation GL.

Ships with: category in the exceptions enum + resolution-template categories, two seeded
resolution templates, an FX-specific AI diagnosis prompt block, and Vitest coverage — never
matching-only, per CLAUDE.md §9A.

*Prepared July 2026 as the WS-6 M6 deliverable (docs/GAP_CLOSURE_PLAN.md).*
