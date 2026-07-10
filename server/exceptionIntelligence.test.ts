import { describe, it, expect } from "vitest";
import {
  classifyResolutionAction,
  amountBucketOf,
  counterpartyTypeOf,
  deriveSignature,
  signatureHashOf,
  assertNoPII,
  buildSharePayload,
  meetsKAnonymity,
  contributorPseudonymFor,
  K_ANON_THRESHOLD,
  ALLOWED_SIGNATURE_KEYS,
} from "./exceptionIntelligence";

describe("resolution action classification", () => {
  it("maps free text to fixed action classes", () => {
    expect(classifyResolutionAction("Issued a credit note to the distributor")).toBe("credit_note");
    expect(classifyResolutionAction("Posted a GL journal entry to correct it")).toBe("journal_entry");
    expect(classifyResolutionAction("Emailed the vendor to confirm the deduction")).toBe("vendor_email");
    expect(classifyResolutionAction("Allocated the payment to the open invoice")).toBe("payment_allocation");
    expect(classifyResolutionAction("Wrote off the shortfall")).toBe("write_off");
    expect(classifyResolutionAction("Reversed the duplicate posting")).toBe("reversal");
    expect(classifyResolutionAction("Escalated to the finance controller")).toBe("escalate");
    expect(classifyResolutionAction("")).toBe("no_action");
    expect(classifyResolutionAction("did something unusual")).toBe("other");
  });
});

describe("coarse normalizers", () => {
  it("buckets amounts", () => {
    expect(amountBucketOf(50_000)).toBe("0-100k");
    expect(amountBucketOf(250_000)).toBe("100k-1m");
    expect(amountBucketOf(5_000_000)).toBe("1m+");
    expect(amountBucketOf("-2000000")).toBe("1m+");
  });
  it("reduces counterparties to a TYPE, never identity", () => {
    expect(counterpartyTypeOf("First Bank PLC")).toBe("bank");
    expect(counterpartyTypeOf("BrightGoods Distributor Ltd")).toBe("distributor");
    expect(counterpartyTypeOf("Paystack")).toBe("fintech");
    expect(counterpartyTypeOf("John Doe")).toBe("unknown");
  });
});

describe("signature derivation", () => {
  it("is deterministic and identity-free", () => {
    const a = deriveSignature({
      exceptionCategory: "damage_deduction",
      amount: 500_000,
      counterparty: "ACME Distributors Ltd",
      deductionType: "damage",
      resolution: "Issued a credit note",
      outcome: "resolved",
    });
    const b = deriveSignature({
      exceptionCategory: "damage_deduction",
      amount: 750_000, // same bucket -> same signature
      counterparty: "Totally Different Distributor Inc",
      deductionType: "damage",
      resolution: "credit note issued",
      outcome: "resolved",
    });
    expect(a.signatureHash).toBe(b.signatureHash);
    expect(a.amountBucket).toBe("100k-1m");
    expect(a.counterpartyType).toBe("distributor");
    expect(a.resolutionActionClass).toBe("credit_note");
    // No raw identity anywhere in the signature.
    expect(JSON.stringify(a)).not.toMatch(/ACME|Distributors Ltd/i);
  });

  it("signatureHashOf matches deriveSignature", () => {
    const s = deriveSignature({ exceptionCategory: "x", amount: 1, resolution: "escalate", outcome: "escalated" });
    expect(signatureHashOf(s)).toBe(s.signatureHash);
  });
});

describe("PII-scrub assertion (last line of defense)", () => {
  it("accepts a clean categorical payload", () => {
    const clean = buildSharePayload({
      exceptionCategory: "short_payment",
      amountBucket: "1m+",
      counterpartyType: "bank",
      deductionType: "fee",
      resolutionActionClass: "journal_entry",
      outcome: "resolved",
    });
    expect(() => assertNoPII(clean)).not.toThrow();
    expect(Object.keys(clean).sort()).toEqual([...ALLOWED_SIGNATURE_KEYS].sort());
  });

  it("rejects disallowed fields", () => {
    expect(() => assertNoPII({ exceptionCategory: "x", transactionRef: "TXN-123" } as any)).toThrow(/disallowed field/i);
  });

  it("rejects free text / identifiers / amounts hiding in a value", () => {
    expect(() => assertNoPII({ exceptionCategory: "Customer John Doe complained about the fee" } as any)).toThrow();
    expect(() => assertNoPII({ counterpartyType: "acct 1234567890" } as any)).toThrow();
    expect(() => assertNoPII({ deductionType: "name@example.com" } as any)).toThrow();
    expect(() => assertNoPII({ resolutionActionClass: "₦5,000,000 written off" } as any)).toThrow();
  });
});

describe("k-anonymity + pseudonym", () => {
  it("gates on the distinct-contributor threshold", () => {
    expect(meetsKAnonymity(K_ANON_THRESHOLD - 1)).toBe(false);
    expect(meetsKAnonymity(K_ANON_THRESHOLD)).toBe(true);
    expect(K_ANON_THRESHOLD).toBeGreaterThanOrEqual(3);
  });

  it("produces a stable, non-reversible contributor pseudonym", () => {
    const p1 = contributorPseudonymFor(42, "salt");
    const p2 = contributorPseudonymFor(42, "salt");
    expect(p1).toBe(p2);
    expect(p1).not.toContain("42");
    expect(contributorPseudonymFor(43, "salt")).not.toBe(p1);
  });
});

describe("retraction signature recomputation (write-path audit, July 2026)", () => {
  it("a signature rebuilt from stored agentMemory fields matches the capture-time hash", () => {
    // Capture time (exceptions.resolve / captureExceptionOutcome): derive from
    // raw transaction values.
    const captured = deriveSignature({
      exceptionCategory: "amount_mismatch",
      amount: 245_000,
      counterparty: "First Bank of Nigeria",
      resolution: "Fee variance posted to charges GL journal entry",
      outcome: "resolved",
    });

    // What agentMemory stores: the already-normalized coarse fields.
    const stored = {
      exceptionCategory: "amount_mismatch",
      amountRange: amountBucketOf(245_000),
      counterpartyType: counterpartyTypeOf("First Bank of Nigeria"),
      deductionType: null,
      resolution: "Fee variance posted to charges GL journal entry",
      outcome: "resolved" as const,
    };

    // Retraction time (retractResolutionLearning): rebuild from stored fields —
    // relies on counterpartyTypeOf being idempotent over its own outputs and
    // the amount bucket being overridden from the stored range.
    const rebuilt = deriveSignature({
      exceptionCategory: stored.exceptionCategory,
      amount: 0,
      counterpartyType: stored.counterpartyType,
      deductionType: stored.deductionType,
      resolution: stored.resolution,
      outcome: stored.outcome,
    });
    rebuilt.amountBucket = stored.amountRange;
    rebuilt.signatureHash = signatureHashOf(rebuilt);

    expect(rebuilt.signatureHash).toBe(captured.signatureHash);
  });

  it("counterpartyTypeOf is idempotent over every type token it can emit", () => {
    for (const raw of ["Access Bank", "Mega Distributor Ltd", "Flutterwave", "Shoprite Retail", "???"]) {
      const once = counterpartyTypeOf(raw);
      expect(counterpartyTypeOf(once)).toBe(once);
    }
  });
});
