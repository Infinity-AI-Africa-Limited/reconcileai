# Controlled Reconciliation Match-Rate Benchmark

## Purpose

This record describes a deterministic, synthetic-only benchmark for ReconcileAI’s
real three-pass reconciliation engine. It is designed to test **clean-data matching
coverage** under defined conditions. It is not a production forecast, a merchant
performance claim, or evidence of a generalisable customer result.

## Test construction

| Dimension | Controlled condition |
| --- | --- |
| Engine | `runMatchingEngine` — the production reconciliation engine |
| Data | Synthetic-only; no customer, payment-provider, bank, or merchant data |
| Source legs | 200 |
| Target legs | 200 |
| Exact pairs | 197, using matching reference, amount, currency, and date |
| Intentional exception legs | 3 source-only and 3 target-only legs |
| Amount tolerance | ±0.5% |
| Date window | 3 days |

## Result and calculation

The benchmark returns **197 exact pairs**, equivalent to **394 matched transaction
legs out of 400 total legs**. Its matched-leg rate is therefore **98.5%**:

> `197 × 2 ÷ 400 × 100 = 98.5%`

The remaining six legs are intentional, distinct, unmatched exceptions. They are not
silently removed, force-matched, or excluded from the calculation.

## Marketing-safe usage

This result can be described only with its conditions, for example:

> “In a deterministic synthetic clean-data benchmark, ReconcileAI’s matching engine
> achieved 98.5% matched transaction-leg coverage, while retaining six intentional
> exception legs for review.”

It must not be shortened to an unconditional “98.5% accuracy” statement. Production
results depend on source completeness, reference quality, timing, settlement-feed
availability, matching policies, and the true exception rate.
