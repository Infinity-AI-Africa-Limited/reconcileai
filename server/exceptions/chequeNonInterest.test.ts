/**
 * Cheque clearing and non-interest (NIFI) banking packs.
 *
 * These close the two coverage gaps found in the 2026-08-12 financial-services
 * audit: cheque clearing was the last major Nigerian rail with no taxonomy, and
 * a non-interest bank had no representation at all despite running the same
 * rails as everyone else.
 *
 * The distinction the assertions below protect: cheque is a CHANNEL, selected
 * from `channels.channelType`; non-interest is an INSTITUTION property, selected
 * from `organizations.bankingModel`. Wiring the second like the first would tell
 * a conventional bank its ledger breaches Sharīʿah principles, which is a false
 * finding on a compliance report.
 */
import { describe, it, expect } from "vitest";
import { CHEQUE_EXCEPTIONS, CHEQUE_EXCEPTION_KEYS } from "./cheque";
import { NON_INTEREST_EXCEPTIONS, NON_INTEREST_EXCEPTION_KEYS } from "./non-interest";
import {
  CHANNEL_EXCEPTION_GROUPS,
  EXCEPTION_CHANNELS,
  EXCEPTION_REGISTRY,
  ALL_EXCEPTIONS,
  ALL_NIGERIAN_EXCEPTIONS,
} from "./index";
import {
  isNonInterestInstitution,
  nonInterestTaxonomyPromptBlock,
  relevantNigerianChannelsForText,
} from "./seed";
import { taxonomyChannelsForChannelType, relevantNigerianChannels } from "./channelMapping";
import { RESOLUTION_TEMPLATE_CATEGORIES } from "../../drizzle/schema";

describe("the cheque clearing pack", () => {
  it("should cover the failure modes truncation and T+1 create", () => {
    // Not an arbitrary count — each of these exists because the physical
    // instrument no longer moves, or because value is provisional for a day.
    for (const key of [
      "cheque_returned_credit_not_reversed", // T+1: provisional value is spendable
      "cheque_duplicate_presentment", // truncation: nothing is surrendered on payment
      "cheque_dud_not_reported", // CRMS / credit bureau obligation
      "cheque_clearing_settlement_variance",
      "cheque_micr_ledger_mismatch", // truncation: MICR is the authoritative record
      "cheque_value_limit_breach",
      "cheque_stale_or_postdated_paid",
      "cheque_outward_not_cleared",
      "cheque_unpresented_aged",
    ]) {
      expect(CHEQUE_EXCEPTION_KEYS, key).toContain(key);
    }
  });

  it("should give the dud-cheque report a one-hour SLA", () => {
    // The CBN exposure draft of 24 Nov 2025 proposes one-hour CRMS reporting.
    // Reporting fast is not wrong under the operative 2016 rule either, so the
    // forward-looking SLA is safe in both states of the world.
    const dud = CHEQUE_EXCEPTIONS.find((e) => e.key === "cheque_dud_not_reported")!;
    expect(dud.slaHours).toBe(1);
    expect(dud.severity).toBe("critical");
  });

  it("should treat only insufficient funds as a dud cheque", () => {
    // Over-reporting is itself a customer-conduct failure — a return for
    // signature or a technical defect is not a dud cheque.
    const dud = CHEQUE_EXCEPTIONS.find((e) => e.key === "cheque_dud_not_reported")!;
    expect(dud.recommendedResolution).toMatch(/INSUFFICIENT FUNDS/);
    expect(dud.aiDiagnosisHint).toMatch(/insufficient-funds/i);
  });

  it("should flag the pending exposure draft rather than assert it as current", () => {
    // A compliance audience will know the difference between an exposure draft
    // and a commenced guideline. Stating the draft as operative would be wrong.
    const dud = CHEQUE_EXCEPTIONS.find((e) => e.key === "cheque_dud_not_reported")!;
    expect(dud.regulatoryContext).toMatch(/exposure draft/i);
    expect(dud.regulatoryContext).toMatch(/2016/);
  });

  it("should register as a channel in every place a channel is listed", () => {
    expect(Object.keys(CHANNEL_EXCEPTION_GROUPS)).toContain("cheque");
    expect(Object.keys(EXCEPTION_CHANNELS)).toContain("cheque");
    expect(EXCEPTION_CHANNELS.cheque.count).toBe(CHEQUE_EXCEPTIONS.length);
    for (const e of CHEQUE_EXCEPTIONS) expect(ALL_NIGERIAN_EXCEPTIONS).toContain(e);
  });

  it("should be selected from the channel type, not only from narration", () => {
    expect(taxonomyChannelsForChannelType("cheque_clearing")).toEqual(["cheque"]);
    // A clearing file row that never says "cheque" still resolves.
    expect(relevantNigerianChannels({ channelType: "cheque_clearing", text: "CLG 0041872 4471" }))
      .toContain("cheque");
  });

  it("should also be inferable from clearing vocabulary", () => {
    expect(relevantNigerianChannelsForText("MICR mismatch on inward clearing session")).toContain("cheque");
    expect(relevantNigerianChannelsForText("dishonoured cheque returned unpaid")).toContain("cheque");
  });
});

describe("the non-interest (NIFI) pack", () => {
  it("should cover the ways non-interest principles are breached in a ledger", () => {
    for (const key of [
      "nifi_interest_bearing_entry",
      "nifi_commingling_breach",
      "nifi_non_permissible_income_unsegregated",
      "nifi_late_payment_charge_to_income",
      "nifi_profit_distribution_variance",
      "nifi_per_irr_movement_unapproved",
      "nifi_murabaha_profit_accrual_mismatch",
      "nifi_ijara_rental_unmatched",
      "nifi_salam_istisna_milestone_mismatch",
      "nifi_wakala_fee_variance",
    ]) {
      expect(NON_INTEREST_EXCEPTION_KEYS, key).toContain(key);
    }
  });

  it("should NOT be registered as a payment channel", () => {
    // The whole point. It belongs to an institution and spans every rail, so a
    // channel type must never pull it in.
    expect(Object.keys(CHANNEL_EXCEPTION_GROUPS)).not.toContain("non_interest");
    expect(Object.keys(CHANNEL_EXCEPTION_GROUPS)).not.toContain("nifi");
    for (const e of NON_INTEREST_EXCEPTIONS) {
      expect(ALL_NIGERIAN_EXCEPTIONS, e.key).not.toContain(e);
    }
  });

  it("should still be resolvable by key like every other taxonomy", () => {
    // Orphaned keys are what the cross-vertical registry exists to prevent.
    for (const e of NON_INTEREST_EXCEPTIONS) {
      expect(EXCEPTION_REGISTRY.get(e.key), e.key).toBeDefined();
      expect(ALL_EXCEPTIONS).toContain(e);
    }
  });

  it("should apply only to an institution that declares non-interest", () => {
    expect(isNonInterestInstitution("non_interest")).toBe(true);
    expect(isNonInterestInstitution("conventional")).toBe(false);
  });

  it("should treat an unknown or missing banking model as conventional", () => {
    // The OPPOSITE default to shared/verticalFeatures, deliberately. That rule
    // withdraws a capability, so failing open is safe. This one asserts a
    // Sharīʿah-compliance finding — telling a conventional bank its ledger
    // breaches non-interest principles because a column was unset is a false
    // finding on a compliance report.
    expect(isNonInterestInstitution(null)).toBe(false);
    expect(isNonInterestInstitution(undefined)).toBe(false);
    expect(isNonInterestInstitution("")).toBe(false);
    expect(isNonInterestInstitution("islamic")).toBe(false);
  });

  it("should inject nothing at all for a conventional bank", () => {
    expect(nonInterestTaxonomyPromptBlock("conventional")).toBe("");
    expect(nonInterestTaxonomyPromptBlock(null)).toBe("");
  });

  it("should inject every pattern for a non-interest bank", () => {
    const block = nonInterestTaxonomyPromptBlock("non_interest");
    for (const key of NON_INTEREST_EXCEPTION_KEYS) expect(block).toContain(key);
  });
});

describe("both packs are persistable as resolution templates", () => {
  // resolution_templates.category is a MySQL enum. A key missing from it would
  // seed fine in tests and throw on the first real insert.
  it("should have every key present in RESOLUTION_TEMPLATE_CATEGORIES", () => {
    const known = new Set<string>(RESOLUTION_TEMPLATE_CATEGORIES);
    for (const key of [...CHEQUE_EXCEPTION_KEYS, ...NON_INTEREST_EXCEPTION_KEYS]) {
      expect(known.has(key), `${key} missing from RESOLUTION_TEMPLATE_CATEGORIES`).toBe(true);
    }
  });

  it("should keep every key unique across the whole registry", () => {
    const keys = ALL_EXCEPTIONS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("should carry the four fields that make an entry usable", () => {
    for (const e of [...CHEQUE_EXCEPTIONS, ...NON_INTEREST_EXCEPTIONS]) {
      expect(e.regulatoryContext.length, `${e.key} regulatoryContext`).toBeGreaterThan(80);
      expect(e.recommendedResolution.length, `${e.key} recommendedResolution`).toBeGreaterThan(80);
      expect(e.aiDiagnosisHint.length, `${e.key} aiDiagnosisHint`).toBeGreaterThan(60);
      expect(e.slaHours, `${e.key} slaHours`).toBeGreaterThan(0);
    }
  });
});

describe("the Super Agent consults the institution's banking model", () => {
  // A taxonomy nothing injects is decoration.
  it("should thread bankingModel into the diagnosis prompt", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const ENGINE = fs.readFileSync(path.join(__dirname, "..", "superAgentEngine.ts"), "utf8");
    expect(ENGINE).toMatch(/nonInterestTaxonomyPromptBlock\(bankingModel\)/);
    expect(ENGINE).toMatch(/\$\{nonInterestBlock \?/);

    const ROUTERS = fs.readFileSync(path.join(__dirname, "..", "routers.ts"), "utf8");
    expect(ROUTERS).toMatch(/diagnosingOrg\?\.bankingModel \?\? null/);
  });
});
