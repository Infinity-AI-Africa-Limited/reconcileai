/**
 * The §2.4 diagnosis pipeline, end to end.
 *
 * Eleven rounds of review hardened this path and every one of them was checked
 * by a unit test of a single function. Nothing exercised the CHAIN —
 * candidate pool → `selectCounterpartLegs` → `determinateCandidates` →
 * `diagnoseException` → shortfall — and a measurement against production found
 * out why that mattered: on the only tenant with data, the pipeline returns "no
 * comparable candidate" for 100% of open transactions. Correctly, as it turns
 * out (those rows genuinely have no counterpart on the paired feed), but it
 * means no production dataset can demonstrate that the shortfall path works at
 * all. The Corporate B2B tenant it was built for holds zero transactions.
 *
 * So the proof is here instead, on fixtures shaped like the ones
 * `demoSeedEngine` writes for BrightGoods: a source row (`credit`) and its
 * target row (`debit`) for the same distributor, with a deliberate difference.
 *
 * These are the assertions the earlier unit tests could not make:
 *   - the shortfall is COMPUTED and NUMERICALLY correct, not merely non-null;
 *   - `bank_fee_deduction` and `fx_variance`, which were unreachable at the
 *     only call site before §2.4, are reachable;
 *   - the chain still refuses when the evidence is indeterminate, rather than
 *     the refusal only being provable one function at a time.
 *
 * The model is mocked: `getLLMDiagnosis` only rewrites the narrative prose and
 * falls back to the rule result on failure, so the numbers asserted here are
 * the deterministic classifier's, which is what gets persisted onto the draft.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Resolves with an empty narrative so `getLLMDiagnosis` keeps the rule result's
// prose. The NUMBERS asserted below are the deterministic classifier's either
// way — the model only rewrites wording — and resolving avoids an unhandled
// rejection masking the assertion that actually failed.
const invokeLLM = vi.fn(async () => ({
  choices: [{ message: { content: JSON.stringify({ headline: "", rootCause: "", recommendedAction: "" }) } }],
}));
vi.mock("./_core/llm", () => ({ invokeLLM: (...a: unknown[]) => invokeLLM(...(a as [])) }));

import type { SATransaction } from "./superAgentEngine";

const {
  selectCounterpartLegs,
  determinateCandidates,
  directionIsTrustworthy,
  diagnoseException,
} = await import("./superAgentEngine");

const CONFIG = { amountTolerance: 0.015, dateWindowDays: 7 };
const DISTRIBUTOR = "Kano Trade Distributors Ltd";

let nextId = 1;
/** A distributor receipt on the bank feed — `credit`, as demoSeedEngine writes it. */
function receipt(amount: number, ref: string, description: string): SATransaction {
  return {
    id: nextId++, transactionRef: ref, description, counterparty: DISTRIBUTOR,
    amount: amount.toFixed(2), currency: "NGN", transactionDate: new Date("2026-08-14T09:00:00Z"),
    channelId: 1, debitCredit: "credit", isReversal: false, originalTransactionRef: null,
  } as SATransaction;
}
/** Its counterpart on the ERP/AR feed — `debit`, on the paired channel. */
function invoice(amount: number, ref: string, overrides: Partial<SATransaction> = {}): SATransaction {
  return {
    id: nextId++, transactionRef: ref, description: `Invoice ${ref}`, counterparty: DISTRIBUTOR,
    amount: amount.toFixed(2), currency: "NGN", transactionDate: new Date("2026-08-13T09:00:00Z"),
    channelId: 2, debitCredit: "debit", isReversal: false, originalTransactionRef: null,
    ...overrides,
  } as SATransaction;
}

/** The whole chain, exactly as `superAgent.diagnose` composes it. */
async function diagnose(txn: SATransaction, pool: SATransaction[]) {
  const { legs, directionSignal } = selectCounterpartLegs(txn, pool);
  const candidates = determinateCandidates(txn, legs, {
    directionTrusted: directionIsTrustworthy(directionSignal),
  });
  // A real Corporate B2B pilot tenant, so the segment-scoped taxonomy and the
  // country-specific regulatory frame are exercised too rather than defaulted.
  const diagnosis = await diagnoseException(txn, candidates, CONFIG, "", {
    segment: "corporate_b2b", bankingModel: null, country: "nigeria",
  });
  return { diagnosis, directionSignal, candidateCount: candidates.length };
}

beforeEach(() => invokeLLM.mockClear());

describe("a distributor receipt with a trade deduction", () => {
  it("should quantify a promotional deduction to the naira", async () => {
    // 1,000,000 invoiced, 950,000 received, "less promo" in the narration.
    // The number a financial controller acts on is 50,000 — before §2.4 this
    // was structurally null and the narrative said "approximately NGN unknown".
    const txn = receipt(950_000, "INV-2847", "MOMO COLLECTION INV-2847 less promo allowance");
    const { diagnosis, candidateCount } = await diagnose(txn, [invoice(1_000_000, "INV-2847")]);

    expect(candidateCount).toBe(1);
    expect(diagnosis.category).toBe("promotional_deduction");
    expect(diagnosis.shortfall).toBeCloseTo(50_000, 2);
    expect(diagnosis.deductionType).toBe("promotional");
    // A deduction is proposed for human approval, never posted (gate B4).
    expect(diagnosis.autoResolvable).toBe(false);
  });

  it("should quantify a damage deduction and route it to a credit note", async () => {
    const txn = receipt(880_000, "INV-3100", "PAYMENT INV-3100 less dmg claim");
    const { diagnosis } = await diagnose(txn, [invoice(1_000_000, "INV-3100")]);

    expect(diagnosis.category).toBe("damage_deduction");
    expect(diagnosis.shortfall).toBeCloseTo(120_000, 2);
    // The taxonomy is explicit that a damage claim is settled by credit note,
    // not by an unevidenced write-off.
    expect(diagnosis.suggestedActionType).toBe("credit_note_request");
  });
});

describe("categories that were unreachable before the candidate pool existed", () => {
  // Both are decided by COMPARING against a candidate, so with the empty list
  // the previous call site passed they could never be reached at all.
  it("should reach bank_fee_deduction on a flat NIP transfer charge", async () => {
    // ₦1,000 is one of the recognised flat NGN transfer fees. The invoice is
    // ₦200,000 rather than ₦1,000,000 on purpose: checkFXVariance tests the
    // 0.1% rounding band FIRST, and ₦1,000 on ₦1,000,000 is exactly 0.1%, so it
    // would be reported as fx_rounding. Same variance amount and same
    // recommended action either way, but this fixture exercises the flat-fee
    // branch it is named for.
    const txn = receipt(199_000, "INV-4001", "TRANSFER INV-4001 less bank charge");
    const { diagnosis } = await diagnose(txn, [invoice(200_000, "INV-4001")]);

    expect(diagnosis.category).toBe("bank_fee_deduction");
    expect(diagnosis.shortfall).toBeCloseTo(1_000, 2);
    expect(diagnosis.fxVariance?.varianceType).toBe("bank_fee_flat");
  });

  it("should reach fx_variance with no deduction keyword present at all", async () => {
    // 0.05% apart — inside the FX rounding band, and the narration says nothing.
    const txn = receipt(999_500, "INV-5001", "SETTLEMENT INV-5001");
    const { diagnosis } = await diagnose(txn, [invoice(1_000_000, "INV-5001")]);

    expect(diagnosis.category).toBe("fx_variance");
    expect(diagnosis.shortfall).toBeCloseTo(500, 2);
    expect(diagnosis.fxVariance?.varianceType).toBe("fx_rounding");
  });
});

describe("the chain still refuses when the evidence is indeterminate", () => {
  it("should quantify nothing when several invoices are open and none is named", async () => {
    const txn = receipt(950_000, null as unknown as string, "MOMO COLLECTION KANO");
    const { diagnosis, candidateCount } = await diagnose(txn, [
      invoice(1_000_000, "INV-7001"),
      invoice(955_000, "INV-7002"),
    ]);

    expect(candidateCount).toBe(0);
    // Not a wrong number: no number. The taxonomy's answer here is to obtain
    // the remittance advice.
    expect(diagnosis.shortfall).toBeNull();
  });

  it("should quantify nothing against another payment on the same side", async () => {
    // The sole-target case: one candidate, but it is a receipt not an invoice,
    // and direction cannot be trusted to say so.
    const txn = receipt(950_000, null as unknown as string, "MOMO COLLECTION KANO");
    const strayReceipt = invoice(980_000, "RCT-9", { debitCredit: "credit" });
    const { diagnosis, candidateCount } = await diagnose(txn, [strayReceipt]);

    expect(candidateCount).toBe(0);
    expect(diagnosis.shortfall).toBeNull();
  });

  it("should quantify nothing for a split remittance naming two invoices", async () => {
    // Allocation is runM2MMatching's job; a shortfall against one leg would be
    // the size of the other.
    const txn = receipt(1_500_000, "INV-8001 and 8002", "remittance INV-8001 and 8002");
    const { diagnosis, candidateCount } = await diagnose(txn, [
      invoice(1_000_000, "INV-8001"),
      invoice(500_000, "INV-8002"),
    ]);

    expect(candidateCount).toBe(0);
    expect(diagnosis.shortfall).toBeNull();
  });
});

describe("a feed that never recorded a direction", () => {
  it("should still quantify the shortfall when the reference names the invoice", async () => {
    // apiIngestionService defaults a missing direction to "debit", so both legs
    // arrive on the same side. The reference is what identifies the leg, and
    // the shortfall survives — this is the case that silently produced nothing
    // when direction was applied unconditionally.
    const txn = receipt(950_000, "INV-9001", "COLLECTION INV-9001 less promo");
    txn.debitCredit = "debit";
    const { diagnosis, directionSignal, candidateCount } = await diagnose(txn, [
      invoice(1_000_000, "INV-9001"),
    ]);

    expect(directionSignal).toBe("uninformative");
    expect(candidateCount).toBe(1);
    expect(diagnosis.shortfall).toBeCloseTo(50_000, 2);
  });
});

/**
 * The defect the end-to-end chain surfaced, pinned at its source.
 *
 * `DEDUCTION_PATTERNS` is ordered most-specific first, but the loop reassigned
 * `deductionType` on EVERY match, so the generic `discount` pattern — "less",
 * "minus", "net of" — overwrote whatever specific type had already matched.
 * `ruleBasedClassify` has no `discount` branch, so those all fell through to
 * `unmatched` with a null shortfall.
 *
 * That is the FMCG deduction interpretation the go-live plan cites as an
 * evidenced capability, unreachable for the phrasing the module's own docstring
 * uses as its example. Eleven rounds of single-function unit tests never saw
 * it; the first end-to-end assertion did.
 */
describe("a deduction stated the way remittances actually state it", () => {
  it.each([
    ["INV-2847 less promo allowance", "promotional"],
    ["PAYMENT INV-3100 less dmg claim", "damage"],
    ["TRANSFER INV-4001 less bank charge", "bank_fee"],
    ["INV-5001 less WHT deducted at source", "tax"],
  ])("should classify %s as %s, not as a generic discount", async (narration, expected) => {
    const { parseReference } = await import("./superAgentEngine");
    expect(parseReference(narration, null).deductionType).toBe(expected);
  });

  it("should still fall back to a generic discount when no specific reason is given", async () => {
    // The control: specificity must not become "never generic". A bare "less
    // 5,000" names no reason, and `discount` is the honest classification.
    const { parseReference } = await import("./superAgentEngine");
    expect(parseReference("INV-6001 less 5,000", null).deductionType).toBe("discount");
  });

  it("should keep reporting every keyword it matched, not only the winning one", async () => {
    // The keywords were always right — "promo,deduction" — which is how the
    // overwrite was diagnosed. Only the TYPE is decided by specificity.
    const { parseReference } = await import("./superAgentEngine");
    const parsed = parseReference("INV-2847 less promo allowance", null);
    expect(parsed.deductionKeywords).toContain("promo");
    expect(parsed.deductionKeywords).toContain("deduction");
  });
});

/**
 * Every deduction reason the parser can return must produce a quantified
 * diagnosis, not fall through to `unmatched`.
 *
 * `tax_deduction` was a DECLARED `ExceptionCategory` that nothing produced: the
 * type asserted the platform classifies withholding tax while every "less WHT"
 * remittance fell through with a null shortfall. The generic `discount` reason
 * had no branch either. Both matter for an FMCG pilot — WHT is one of the
 * commonest deductions in both launch geographies, and it is the one whose
 * shortfall is NOT collectible from the distributor.
 */
describe("every deduction reason produces a quantified diagnosis", () => {
  it.each([
    ["less dmg claim", "damage", "damage_deduction"],
    ["less promo allowance", "promotional", "promotional_deduction"],
    ["less WHT deducted at source", "tax", "tax_deduction"],
    ["less 5,000", "discount", "unspecified_deduction"],
  ])("%s (%s) should be classified as %s with the shortfall quantified", async (narration, reason, category) => {
    const txn = receipt(950_000, "INV-2847", `PAYMENT INV-2847 ${narration}`);
    const { diagnosis } = await diagnose(txn, [invoice(1_000_000, "INV-2847")]);

    expect(diagnosis.category).toBe(category);
    expect(diagnosis.deductionType).toBe(reason);
    expect(diagnosis.shortfall).toBeCloseTo(50_000, 2);
    // None of these may be closed by the agent: a deduction is a proposal for a
    // named human until its evidence exists (gate B4).
    expect(diagnosis.autoResolvable).toBe(false);
  });

  it("should treat an unevidenced withholding-tax deduction as high severity", async () => {
    // Not a filing nicety: without the certificate the amount is neither
    // recoverable from the payer nor claimable against the tax liability, so it
    // is a real loss sitting in receivables.
    const txn = receipt(950_000, "INV-2847", "PAYMENT INV-2847 less WHT");
    const { diagnosis } = await diagnose(txn, [invoice(1_000_000, "INV-2847")]);
    expect(diagnosis.severity).toBe("high");
    expect(diagnosis.recommendedAction).toMatch(/certificate|credit note/i);
  });

  it("should not invent a reason for a deduction that gave none", async () => {
    // The reason decides whether it is approved trade spend or an unauthorised
    // shortfall. Guessing one is the fabrication this module keeps refusing.
    const txn = receipt(950_000, "INV-2847", "PAYMENT INV-2847 less 5,000");
    const { diagnosis } = await diagnose(txn, [invoice(1_000_000, "INV-2847")]);
    expect(diagnosis.category).toBe("unspecified_deduction");
    expect(diagnosis.recommendedAction).toMatch(/reason/i);
  });
});

/**
 * Which categories the rule-based classifier can actually produce.
 *
 * Recorded rather than implied, because `ExceptionCategory` declares fifteen and
 * a third of them were reachable from nowhere. `tax_deduction` is fixed above;
 * the rest are pinned here so the gap is a stated open item instead of a type
 * that quietly overstates what the platform does.
 */
describe("the declared category union versus what is produced", () => {
  it("should record the categories no code path produces", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("./superAgentEngine.ts", import.meta.url), "utf8");
    const produced = new Set([...src.matchAll(/category: "([a-z_]+)"/g)].map((m) => m[1]));

    // Declared, produced by NOTHING anywhere in the server. Each needs a
    // classifier branch or removal from the union — a product decision, not a
    // hardening one. `timing_difference` and `currency_mismatch` are produced
    // elsewhere in the platform and are deliberately absent from this list.
    for (const key of ["split_payment", "duplicate_invoice", "contra_entry", "unmatched_reversal"]) {
      expect(produced.has(key), `${key} is newly produced — remove it from the orphaned list`).toBe(false);
    }
    // The two the fix above added must now be produced, or this test is stale.
    expect(produced.has("tax_deduction")).toBe(true);
    expect(produced.has("unspecified_deduction")).toBe(true);
  });
});
