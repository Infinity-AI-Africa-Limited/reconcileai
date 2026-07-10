/**
 * Retail taxonomy integrity + intelligence-moat wiring.
 *
 * The retail taxonomy is only a moat if it is (a) internally consistent,
 * (b) every key is a valid resolution_templates.category, and (c) reachable
 * from the cross-vertical registry the read-path uses. These tests lock all
 * three — the gap the hardening pass closed was retail being defined but
 * orphaned from EXCEPTION_REGISTRY.
 */
import { describe, expect, it } from "vitest";
import {
  RETAIL_COMMERCE_EXCEPTIONS,
  RETAIL_COMMERCE_EXCEPTION_KEYS,
  getRetailException,
  retailExceptionFor,
  retailExceptionsTaxonomyPromptBlock,
} from "./retail-commerce";
import { EXCEPTION_REGISTRY, ALL_EXCEPTIONS } from "./index";
import { RESOLUTION_TEMPLATE_CATEGORIES } from "../../drizzle/schema";

describe("retail taxonomy — internal integrity", () => {
  it("defines the full retail catalogue: 14 roadmap + 11 research-round-2 categories", () => {
    expect(RETAIL_COMMERCE_EXCEPTIONS).toHaveLength(25);
  });

  it("research round 2 covers the five missing exception surfaces", () => {
    const keys = new Set(RETAIL_COMMERCE_EXCEPTION_KEYS);
    // order↔payment integrity
    expect(keys.has("retail_order_payment_amount_mismatch")).toBe(true);
    expect(keys.has("retail_gift_card_split_mismatch")).toBe(true);
    // COD (SEA lifeline channel)
    expect(keys.has("retail_cod_remittance_variance")).toBe(true);
    // dispute lifecycle beyond the chargeback itself
    expect(keys.has("retail_refund_duplicate")).toBe(true);
    expect(keys.has("retail_dispute_won_not_credited")).toBe(true);
    expect(keys.has("retail_dispute_fee_error")).toBe(true);
    // payout↔bank third leg
    expect(keys.has("retail_payout_bank_variance")).toBe(true);
    // platform economics
    expect(keys.has("retail_tax_deduction_variance")).toBe(true);
    expect(keys.has("retail_platform_commission_variance")).toBe(true);
    // settlement batch integrity
    expect(keys.has("retail_settlement_duplicate")).toBe(true);
    expect(keys.has("retail_settlement_batch_missing")).toBe(true);
  });

  it("has unique keys", () => {
    const keys = RETAIL_COMMERCE_EXCEPTIONS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every exception carries the full moat metadata (context/resolution/AI hint)", () => {
    for (const e of RETAIL_COMMERCE_EXCEPTIONS) {
      expect(e.regulatoryContext.length, `${e.key} regulatoryContext`).toBeGreaterThan(40);
      expect(e.recommendedResolution.length, `${e.key} recommendedResolution`).toBeGreaterThan(40);
      expect(e.aiDiagnosisHint.length, `${e.key} aiDiagnosisHint`).toBeGreaterThan(40);
      expect(["critical", "high", "medium", "low"]).toContain(e.severity);
      expect(e.slaHours).toBeGreaterThan(0);
      expect(e.sources === "all" || Array.isArray(e.sources)).toBe(true);
    }
  });

  it("critical exceptions carry a same-day (≤24h) SLA", () => {
    for (const e of RETAIL_COMMERCE_EXCEPTIONS.filter((x) => x.severity === "critical")) {
      expect(e.slaHours, `${e.key}`).toBeLessThanOrEqual(24);
    }
  });
});

describe("retail taxonomy — resolution_templates.category enum coverage", () => {
  it("every retail key is a valid resolution_templates.category (seeding cannot fail)", () => {
    const enumSet = new Set<string>(RESOLUTION_TEMPLATE_CATEGORIES as readonly string[]);
    const missing = RETAIL_COMMERCE_EXCEPTION_KEYS.filter((k) => !enumSet.has(k));
    expect(missing, `keys absent from RESOLUTION_TEMPLATE_CATEGORIES: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("retail taxonomy — cross-vertical registry wiring", () => {
  it("every retail key resolves through the shared EXCEPTION_REGISTRY", () => {
    for (const e of RETAIL_COMMERCE_EXCEPTIONS) {
      const found = EXCEPTION_REGISTRY.get(e.key);
      expect(found, `EXCEPTION_REGISTRY missing ${e.key}`).toBeDefined();
      expect(found!.aiDiagnosisHint).toBe(e.aiDiagnosisHint);
    }
  });

  it("ALL_EXCEPTIONS spans both verticals (retail included)", () => {
    const keys = new Set(ALL_EXCEPTIONS.map((e) => e.key));
    for (const k of RETAIL_COMMERCE_EXCEPTION_KEYS) expect(keys.has(k)).toBe(true);
    // and still contains Nigerian keys
    expect(keys.has("retail_chargeback_not_posted")).toBe(true);
    expect(keys.size).toBeGreaterThan(RETAIL_COMMERCE_EXCEPTION_KEYS.length);
  });

  it("retail keys do not collide with Nigerian keys", () => {
    const nigerianCount = ALL_EXCEPTIONS.length - RETAIL_COMMERCE_EXCEPTIONS.length;
    // Registry size == unique union; a collision would shrink it below the sum.
    expect(EXCEPTION_REGISTRY.size).toBe(nigerianCount + RETAIL_COMMERCE_EXCEPTIONS.length);
  });
});

describe("retail taxonomy — read-path helpers", () => {
  it("getRetailException / retailExceptionFor resolve known keys and reject unknown", () => {
    expect(getRetailException("retail_settlement_shortfall")?.severity).toBe("critical");
    expect(retailExceptionFor("retail_settlement_shortfall")?.severity).toBe("critical");
    expect(retailExceptionFor("not_a_key")).toBeNull();
  });

  it("the AI prompt block lists every retail exception with key/severity/SLA/hint", () => {
    const block = retailExceptionsTaxonomyPromptBlock();
    for (const e of RETAIL_COMMERCE_EXCEPTIONS) {
      expect(block).toContain(e.key);
    }
    expect(block.split("\n")).toHaveLength(RETAIL_COMMERCE_EXCEPTIONS.length);
  });
});
