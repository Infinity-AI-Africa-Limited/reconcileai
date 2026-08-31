# ReconcileAI — Investor Video Script

**Duration:** 2:55 · **Narration:** ~430 words at ~150 wpm
**Capture source:** live product, three tenants, real seeded data
**Status of every figure below:** on screen in the referenced shot. Nothing is asserted that the frame does not show.

---

## The claim this video makes

One reconciliation engine, one codebase, three industries — each with its own
exception taxonomy, its own regulatory frame, and its own hero screen. And an
intelligence layer that gets better the more institutions use it.

That is the whole argument. Every shot exists to evidence one clause of it.

---

## 0:00 — 0:22 · The problem

> **VO:** Every bank, distributor and merchant in Africa runs the same broken
> process. Money moves across a dozen rails. Someone exports spreadsheets and
> matches them by hand. What doesn't match gets investigated days later — if
> anyone gets to it at all.
>
> ReconcileAI does that automatically, and explains what it found.

**On screen:** Title card → cut to Financial Services **Dashboard** loading.

---

## 0:22 — 1:12 · Financial Services

> **VO:** This is a Nigerian bank's operation. Six hundred and forty transaction
> legs, across eight payment rails — NIP, direct debit, USSD, mobile, POS, card
> scheme, agent banking, and the core banking ledger they all reconcile against.
>
> Ninety-five percent matched automatically, in a single run.
>
> The five percent that didn't is the product. Sixteen cases, each classified by
> cause — a duplicate NIP retry, a direct debit returned unpaid, a POS reversal
> the customer hasn't been credited for. Not "unmatched". *Why* it's unmatched,
> and what to do about it.

**Shots**
| Time | Screen | What must be legible |
|---|---|---|
| 0:22 | `SHOT-01` Dashboard | 640 · 95.0% · 10 open · 16 unmatched |
| 0:38 | `SHOT-02` Multi-Channel | Per-rail cards, each with its own match rate |
| 0:55 | `SHOT-03` Exceptions (Last 7 days) | Category, severity, description, suggested resolution |

> ⚠️ **Set the Exceptions filter to "Last 7 days" before recording.** It defaults
> to Today and the seeded cases are aged 0–23 days, so the default view is empty.

---

## 1:12 — 1:48 · Corporate B2B

> **VO:** Same engine, different industry. This is an FMCG supplier reconciling
> two thousand distributor payments against ERP orders.
>
> The exceptions are different because the business is different — partial
> payments, promotional deductions, one payment covering three invoices. And
> underneath it, a distributor identity registry: fifteen trading names, their
> aliases, and the bank accounts they actually pay from. That registry is what
> makes the matching work when a distributor pays under a slightly different
> name every time.

**Shots**
| Time | Screen | What must be legible |
|---|---|---|
| 1:12 | `SHOT-04` B2B Dashboard | 2,000 · 95.0% · ERP Orders + Bank Statement |
| 1:30 | `SHOT-05` Distributor Registry | 15 distributors, aliases, zones, banks |

> **Note the sidebar in both shots.** Financial Services shows CBN Reports;
> Corporate B2B shows Distributor Registry instead. Same codebase, different
> product per vertical — worth a beat of narration if the cut allows.

---

## 1:48 — 2:18 · Retail Commerce

> **VO:** And the third: e-commerce. We're an installable app on SHOPLINE, a
> platform with over six hundred thousand merchants. A merchant connects their
> store, and orders and settlements flow in over a live API connection —
> reconciled the same way, against the same engine.

**Shots**
| Time | Screen | What must be legible |
|---|---|---|
| 1:48 | `SHOT-06` Settlement Monitor | Connected store, status **active**, last sync |
| 2:05 | `SHOT-07` Exception Resolution Intelligence panel | Retail categories: chargeback, gateway fee, FX, payout variance |

> ⚠️ **Read §"Retail before you film" in `README.md` first.** This tenant is a
> live dev store with six transactions. Lead on the *connection* and the retail
> taxonomy — do not put its match rate or settlement totals on screen. They are
> artefacts of test orders, and a 66.7% rate invites the wrong question.

---

## 2:18 — 2:45 · The moat

> **VO:** Here's what compounds. Every exception your team resolves teaches the
> system how your institution handles that situation. And a privacy-preserving
> layer shares the *pattern* — never the data — across institutions.
>
> So a bank that joins next year inherits what the network already learned. The
> catalogue behind it runs to a hundred and thirty exception types across
> eighteen payment channels, each with its regulatory context and a recommended
> action.
>
> That is not a feature a competitor ships in a quarter.

**Shots**
| Time | Screen | What must be legible |
|---|---|---|
| 2:18 | `SHOT-08` Exception Intelligence | Per-institution flywheel: patterns learned, categories |
| 2:32 | `SHOT-09` Same page, scrolled | "Cross-institution intelligence (privacy-first)" — anonymised signatures only |

---

## 2:45 — 2:55 · Close

> **VO:** One engine. Three industries. Live in production today.
>
> ReconcileAI.

**On screen:** Logo, `reconcileaiafrica.com`.

---

## Claims deliberately NOT made

The script avoids these, and re-inserting any of them would make it false:

| Not claimed | Why |
|---|---|
| Named customers or logos | The tenants shown are demo tenants |
| Transaction volumes at scale | The datasets are control datasets, not production traffic |
| "Production-ready for banks" | An independent readiness assessment lists open P0 gates |
| Any certification (PCI, ISO, CBN approval) | None held |
| Cost, headcount or ROI figures | Not evidenced by anything on screen |

If an investor asks "is this real data?" the honest answer is: it is a real
product running against real infrastructure, on demonstration datasets. Every
number shown is computed live by the engine from those datasets — none is typed
into a slide.
