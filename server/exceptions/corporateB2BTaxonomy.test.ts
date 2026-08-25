/**
 * Corporate B2B / FMCG distributor taxonomy.
 *
 * CLAUDE.md §9A: a vertical that ships matching without its own exception
 * taxonomy, resolution procedures, regulatory context and diagnosis guidance is
 * breadth without depth. Corporate B2B shipped that way — its exceptions were
 * diagnosed under a Nigerian-bank persona with the NIP/POS/ATM catalogue.
 *
 * These tests assert the taxonomy's shape and, more importantly, that it is
 * selected BY SEGMENT and replaces rather than supplements the bank catalogue.
 */
import { describe, it, expect } from "vitest";
import {
  CORPORATE_B2B_EXCEPTIONS,
  CORPORATE_B2B_EXCEPTION_KEYS,
  corporateB2BExceptionFor,
  corporateB2BExceptionsTaxonomyPromptBlock,
  corporateB2BRegulatoryFrame,
} from "./corporate-b2b";
import { ALL_EXCEPTIONS, EXCEPTION_REGISTRY, CHANNEL_EXCEPTION_GROUPS } from "./index";

describe("the Corporate B2B exception catalogue", () => {
  it("should cover the FMCG receipt-to-allocation lifecycle, not just unmatched rows", () => {
    // The pilot's stated workflow is "distributor receipt to invoice
    // allocation". Each of these is a distinct decision a controller has to
    // make, with a different owner and a different accounting treatment.
    for (const key of [
      "b2b_unallocated_receipt",
      "b2b_partial_payment",
      "b2b_split_payment_across_invoices",
      "b2b_promotional_deduction_unapproved",
      "b2b_damage_claim_deduction",
      "b2b_returns_deduction_no_credit_note",
      "b2b_withholding_tax_deduction",
      "b2b_mobile_money_settlement_delay",
      "b2b_unknown_distributor",
      "b2b_duplicate_receipt_ingested",
      "b2b_source_control_total_mismatch",
    ]) {
      expect(CORPORATE_B2B_EXCEPTION_KEYS, `${key} must be catalogued`).toContain(key);
    }
  });

  it("should give every entry the four things that make a taxonomy an asset", () => {
    for (const entry of CORPORATE_B2B_EXCEPTIONS) {
      expect(entry.key, "key must be prefixed so it cannot collide across verticals").toMatch(/^b2b_/);
      expect(entry.label.length).toBeGreaterThan(8);
      expect(entry.regulatoryContext.length, `${entry.key} regulatoryContext`).toBeGreaterThan(80);
      expect(entry.recommendedResolution.length, `${entry.key} recommendedResolution`).toBeGreaterThan(80);
      expect(entry.aiDiagnosisHint.length, `${entry.key} aiDiagnosisHint`).toBeGreaterThan(60);
      expect(entry.slaHours).toBeGreaterThan(0);
    }
  });

  it("should have unique keys, and none that collide with another vertical", () => {
    expect(new Set(CORPORATE_B2B_EXCEPTION_KEYS).size).toBe(CORPORATE_B2B_EXCEPTION_KEYS.length);
    // EXCEPTION_REGISTRY is keyed by string across every vertical; a collision
    // would silently overwrite one taxonomy's entry with another's.
    expect(new Set(ALL_EXCEPTIONS.map((e) => e.key)).size).toBe(ALL_EXCEPTIONS.length);
  });

  it("should be reachable through the cross-vertical registry", () => {
    for (const entry of CORPORATE_B2B_EXCEPTIONS) {
      expect(EXCEPTION_REGISTRY.get(entry.key), `${entry.key} orphaned from the registry`).toBeDefined();
    }
    expect(corporateB2BExceptionFor("b2b_partial_payment")?.severity).toBe("medium");
    expect(corporateB2BExceptionFor("not_a_real_key")).toBeNull();
  });

  it("should NOT be a channel group", () => {
    // It belongs to an institution, not a rail — the same asymmetry as the
    // non-interest taxonomy. In the channel map it would be injected on the
    // strength of a channelType, for tenants it does not describe.
    const channelKeys = Object.values(CHANNEL_EXCEPTION_GROUPS).flat().map((e) => e.key);
    for (const key of CORPORATE_B2B_EXCEPTION_KEYS) {
      expect(channelKeys).not.toContain(key);
    }
  });

  it("should not frame a manufacturer as a supervised bank", () => {
    // A distributor receivable is governed by the trade agreement, IFRS 15 and
    // the revenue authority — not by central-bank prudential circulars.
    const context = CORPORATE_B2B_EXCEPTIONS.map((e) => e.regulatoryContext).join(" ");
    expect(context).not.toMatch(/\bCBN\b/);
    expect(context).not.toMatch(/prudential/i);
  });
});

describe("selecting the taxonomy by segment", () => {
  it("should inject the catalogue for a corporate_b2b tenant", () => {
    const block = corporateB2BExceptionsTaxonomyPromptBlock("corporate_b2b");
    expect(block.split("\n")).toHaveLength(CORPORATE_B2B_EXCEPTIONS.length);
    for (const entry of CORPORATE_B2B_EXCEPTIONS) expect(block).toContain(entry.key);
  });

  it.each(["financial_services", "retail_commerce", "super_admin", null, undefined])(
    "should inject nothing for %p — no tokens spent on a taxonomy that does not apply",
    (segment) => {
      expect(corporateB2BExceptionsTaxonomyPromptBlock(segment)).toBe("");
    },
  );
});

describe("the regulatory frame follows the pilot country", () => {
  // The go-live plan's FIRST launch geography is Uganda. The Super Agent's
  // default instruction is to cite CBN circulars and NIBSS rules, which for a
  // Ugandan distributor is not a harmless default but a wrong citation.
  it("should name URA and the Bank of Uganda NPS regime for a Uganda pilot", () => {
    const frame = corporateB2BRegulatoryFrame("uganda");
    expect(frame).toMatch(/Uganda Revenue Authority/);
    expect(frame).toMatch(/Bank of Uganda/);
    expect(frame).not.toMatch(/FIRS/);
    expect(frame).not.toMatch(/NIBSS/);
  });

  it("should name FIRS for a Nigeria pilot", () => {
    const frame = corporateB2BRegulatoryFrame("nigeria");
    expect(frame).toMatch(/Federal Inland Revenue Service/);
    expect(frame).not.toMatch(/Uganda Revenue Authority/);
  });

  it("should stay generic when the pilot country is unknown, rather than guessing one", () => {
    const frame = corporateB2BRegulatoryFrame(null);
    expect(frame).toMatch(/applicable national revenue authority/);
    expect(frame).not.toMatch(/FIRS|Uganda Revenue Authority/);
  });

  it("should state the no-write boundary and refuse the bank framing in every country", () => {
    for (const country of ["uganda", "nigeria", null]) {
      const frame = corporateB2BRegulatoryFrame(country);
      expect(frame).toMatch(/NOT a licensed bank/);
      expect(frame).toMatch(/PROPOSAL/);
    }
  });
});
