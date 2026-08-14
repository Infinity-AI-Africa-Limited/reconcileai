import { describe, it, expect } from "vitest";
import {
  ALL_NIGERIAN_EXCEPTIONS,
  CHANNEL_EXCEPTION_GROUPS,
  EXCEPTION_CHANNELS,
  CARD_SWITCHING_EXCEPTIONS,
  CARD_SCHEME_EXCEPTIONS,
  CARD_DISPUTE_EXCEPTIONS,
} from "./index";
import {
  nigerianExceptionsTaxonomyPromptBlock,
  relevantNigerianChannelsForText,
  nigerianExceptionFor,
} from "./seed";

describe("Nigerian exception taxonomy — registry integrity", () => {
  it("has 130 exceptions across 18 channels", () => {
    // 18th channel: cheque clearing (NIBSS NACS / Truncation), added 2026-08-12
    // as the last major Nigerian rail with no taxonomy. Pinned rather than
    // computed so that losing a pack to a bad merge fails here.
    expect(ALL_NIGERIAN_EXCEPTIONS.length).toBe(130);
    expect(Object.keys(CHANNEL_EXCEPTION_GROUPS).length).toBe(18);
  });

  it("channel group counts sum to the registry total and match EXCEPTION_CHANNELS", () => {
    const groupSum = Object.values(CHANNEL_EXCEPTION_GROUPS).reduce((s, g) => s + g.length, 0);
    expect(groupSum).toBe(ALL_NIGERIAN_EXCEPTIONS.length);
    for (const [key, group] of Object.entries(CHANNEL_EXCEPTION_GROUPS)) {
      expect(EXCEPTION_CHANNELS[key as keyof typeof EXCEPTION_CHANNELS].count).toBe(group.length);
    }
  });

  it("all exception keys are unique", () => {
    const keys = ALL_NIGERIAN_EXCEPTIONS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every exception carries the full moat payload", () => {
    for (const e of ALL_NIGERIAN_EXCEPTIONS) {
      expect(e.label.length, e.key).toBeGreaterThan(5);
      expect(e.regulatoryContext.length, e.key).toBeGreaterThan(40);
      expect(e.recommendedResolution.length, e.key).toBeGreaterThan(40);
      expect(e.aiDiagnosisHint.length, e.key).toBeGreaterThan(40);
      expect(e.slaHours, e.key).toBeGreaterThan(0);
      expect(["critical", "high", "medium", "low"]).toContain(e.severity);
    }
  });

  it("card taxonomy covers switching, schemes and disputes (28 exceptions)", () => {
    expect(CARD_SWITCHING_EXCEPTIONS.length).toBe(10);
    expect(CARD_SCHEME_EXCEPTIONS.length).toBe(9);
    expect(CARD_DISPUTE_EXCEPTIONS.length).toBe(9);
    expect(nigerianExceptionFor("chargeback_representment_deadline")?.severity).toBe("critical");
    expect(nigerianExceptionFor("afrigo_settlement_break")).not.toBeNull();
  });
});

describe("taxonomy prompt block — channel-aware read-path", () => {
  it("returns the full catalogue with no channel filter", () => {
    const block = nigerianExceptionsTaxonomyPromptBlock();
    expect(block.split("\n").length).toBe(ALL_NIGERIAN_EXCEPTIONS.length);
    expect(block).toContain("nip_timeout_debit_no_credit");
    expect(block).toContain("chargeback_inbound_acquirer");
  });

  it("returns only the requested channels when filtered", () => {
    const block = nigerianExceptionsTaxonomyPromptBlock(["card_disputes"]);
    expect(block.split("\n").length).toBe(CARD_DISPUTE_EXCEPTIONS.length);
    expect(block).toContain("chargeback_fraud_coded");
    expect(block).not.toContain("nip_timeout_debit_no_credit");
  });

  it("matches card/processor text to the card channels", () => {
    const channels = relevantNigerianChannelsForText(
      "Interswitch settlement report shows chargeback on Verve card RRN 000123",
    );
    expect(channels).toContain("card_switching");
    expect(channels).toContain("card_schemes");
    expect(channels).toContain("card_disputes");
  });

  it("matches NIP text to the nip channel", () => {
    expect(relevantNigerianChannelsForText("NIP transfer session id 00002926 name enquiry failed"))
      .toContain("nip");
  });

  it("returns [] for text with no channel signal (e.g. FMCG trade deduction)", () => {
    expect(relevantNigerianChannelsForText("INV-2847 less damage deduction per distributor agreement"))
      .toEqual([]);
    expect(relevantNigerianChannelsForText("")).toEqual([]);
  });

  it("caps matched channels to bound prompt tokens", () => {
    const dense =
      "NIP POS ATM card interswitch verve visa mastercard chargeback ussd swift remittance salary bill payment";
    expect(relevantNigerianChannelsForText(dense).length).toBeLessThanOrEqual(4);
  });
});
