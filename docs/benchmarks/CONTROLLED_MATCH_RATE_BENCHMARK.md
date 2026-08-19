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

### What the engine earned, and what the fixture chose

These are different things, and the distinction decides how the figure may be used.

**98.5% is a property of the fixture, not a limit the engine reached.** Six of the
400 legs cannot match by construction, so the arithmetic yields 98.5% before the
engine runs. Build the same benchmark with 198 pairs and four unmatchable legs and
the identical engine "achieves" 99%.

**What the engine earned is stronger:** it matched every pair that had a
counterpart and forced nothing that did not — complete recall with no false
positives on this fixture. Had it matched only 190 of the 197, the test would
fail; that is the assertion doing real work.

So the honest reading is: *under clean, fully-referenced conditions the engine
matched everything matchable, and the 98.5% reflects the 1.5% of legs the fixture
deliberately made unmatchable.*

### What this benchmark does not establish

- **Precision under ambiguity.** Every reference and amount in the fixture is
  unique, so there is nothing tempting to mis-pair. Precision is covered
  separately in `reconciliationEngine.controlledBenchmark.test.ts`, which asserts
  that weaker pairings are labelled `date_window` or `fuzzy` rather than `exact`,
  and that a duplicate candidate cannot consume the same leg twice.
- **Any real-data rate.** Reference quality, timing, partial settlements and
  genuine exceptions all move the number, and none of them appear here.
- **That its fixture is contract-checked by CI.** `tsconfig.json` excludes
  `**/*.test.ts`, so `pnpm check` does not typecheck this or any other test
  file. The fixture is annotated against the real `Transaction` row rather than
  cast, which the editor and review enforce, but a schema change will not fail
  the build here until that exclude is lifted.

## Marketing-safe usage

This result can be described only with its conditions, for example:

> “In a deterministic synthetic clean-data benchmark, ReconcileAI’s matching engine
> achieved 98.5% matched transaction-leg coverage, while retaining six intentional
> exception legs for review.”

It must not be shortened to an unconditional “98.5% accuracy” statement. Production
results depend on source completeness, reference quality, timing, settlement-feed
availability, matching policies, and the true exception rate.

**A caution specific to this number.** Because the denominator was chosen, 98.5%
will not withstand a technical reader asking how the fixture was built — they will
find that six legs were made unmatchable on purpose. The claim that does withstand
it is the one about behaviour:

> “On a clean, fully-referenced synthetic set, the engine matched every pair that
> had a counterpart and force-matched nothing that did not.”

That is what the test actually proves, it is a stronger statement, and it does not
invite the follow-up question.
