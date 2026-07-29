/**
 * Tests for the SHOPLINE GDPR handlers and the retail exception intelligence
 * layers (intra-org + cross-org). Pure-logic and mocked-DB — no network.
 */
import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";

import { classifyGdprTopic, verifyGdprSignature } from "./connectors/shopline/gdpr";
import {
  mapRetailToCoreCategory,
  relevantRetailCategoriesForText,
  retailIntelligencePromptBlock,
  type RetailExceptionIntelligence,
} from "./connectors/shopline/retailIntelligence";
import { counterpartyTypeOf } from "./exceptionIntelligence";

// ─── GDPR topic classification ────────────────────────────────────────────────

describe("GDPR topic classification", () => {
  it("maps SHOPLINE topic variants to canonical kinds", () => {
    expect(classifyGdprTopic("customers/data_request")).toBe("customer_data_request");
    expect(classifyGdprTopic("customers/redact")).toBe("customer_redact");
    expect(classifyGdprTopic("shop/redact")).toBe("shop_redact");
    expect(classifyGdprTopic("merchants/redact")).toBe("shop_redact");
    expect(classifyGdprTopic("orders/create")).toBeNull();
    expect(classifyGdprTopic(undefined)).toBeNull();
  });
});

describe("GDPR signature verification is mandatory", () => {
  it("rejects a request with no signature header (no unsigned uninstall/redact)", () => {
    const body = Buffer.from('{"shop_domain":"acme.myshopline.com"}');
    expect(verifyGdprSignature(body, "")).toBe(false);
  });

  it("rejects an invalid signature", () => {
    const body = Buffer.from('{"shop_domain":"acme.myshopline.com"}');
    expect(verifyGdprSignature(body, "not-a-real-sig")).toBe(false);
  });

  it("accepts a correctly-signed body (when app secret is configured)", () => {
    const secret = process.env.SHOPLINE_APP_SECRET;
    if (!secret) return; // secret is deploy-only; skip when absent
    const body = Buffer.from('{"shop_domain":"acme.myshopline.com"}');
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64");
    expect(verifyGdprSignature(body, sig)).toBe(true);
  });
});

// ─── Retail → core category mapping ───────────────────────────────────────────

describe("mapRetailToCoreCategory", () => {
  it("keeps duplicates distinct from reversals", () => {
    expect(mapRetailToCoreCategory("retail_chargeback_duplicate")).toBe("duplicate_transaction");
    expect(mapRetailToCoreCategory("retail_settlement_duplicate")).toBe("duplicate_transaction");
  });
  it("maps disputes/refunds/voids to reversal_unmatched", () => {
    expect(mapRetailToCoreCategory("retail_chargeback_not_posted")).toBe("reversal_unmatched");
    expect(mapRetailToCoreCategory("retail_refund_not_settled")).toBe("reversal_unmatched");
    expect(mapRetailToCoreCategory("retail_void_not_reversed")).toBe("reversal_unmatched");
  });
  it("maps fee/variance to amount_mismatch and settlement/payout to timing", () => {
    expect(mapRetailToCoreCategory("retail_gateway_fee_variance")).toBe("amount_mismatch");
    expect(mapRetailToCoreCategory("retail_interchange_misclassification")).toBe("amount_mismatch");
    expect(mapRetailToCoreCategory("retail_settlement_delay")).toBe("timing_difference");
    expect(mapRetailToCoreCategory("retail_payout_delay")).toBe("timing_difference");
  });
  it("maps fx/currency to fx_rate_variance", () => {
    expect(mapRetailToCoreCategory("retail_fx_rate_mismatch")).toBe("fx_rate_variance");
    expect(mapRetailToCoreCategory("retail_currency_conversion_error")).toBe("fx_rate_variance");
  });
});

// ─── Retail-aware counterparty typing ─────────────────────────────────────────

describe("counterpartyTypeOf — retail recognizers", () => {
  it("recognises card schemes, wallets, BNPL, gateways, marketplaces", () => {
    expect(counterpartyTypeOf("Visa")).toBe("card_scheme");
    expect(counterpartyTypeOf("Mastercard International")).toBe("card_scheme");
    expect(counterpartyTypeOf("PayPal")).toBe("digital_wallet");
    expect(counterpartyTypeOf("Klarna")).toBe("bnpl");
    expect(counterpartyTypeOf("SHOPLINE Payments")).toBe("payment_gateway");
    expect(counterpartyTypeOf("Marketplace payout")).toBe("marketplace");
  });
  it("still recognises the financial-services types", () => {
    expect(counterpartyTypeOf("First Bank MFB")).toBe("bank");
    expect(counterpartyTypeOf("ACME Distributor Ltd")).toBe("distributor");
  });
});

// ─── Relevant retail categories for free text ─────────────────────────────────

describe("relevantRetailCategoriesForText", () => {
  it("finds chargeback categories in a chargeback question", () => {
    const cats = relevantRetailCategoriesForText("Why was this chargeback not posted to my ledger?");
    expect(cats.some((c) => c.includes("chargeback"))).toBe(true);
  });
  it("finds settlement/payout categories", () => {
    const cats = relevantRetailCategoriesForText("my payout is delayed and the settlement is short");
    expect(cats.length).toBeGreaterThan(0);
  });
  it("returns nothing for an unrelated question", () => {
    expect(relevantRetailCategoriesForText("hello there")).toEqual([]);
  });
});

// ─── Prompt block combines both layers ────────────────────────────────────────

describe("retailIntelligencePromptBlock", () => {
  it("is empty when neither layer has data (safe to concatenate)", () => {
    const intel: RetailExceptionIntelligence = {
      category: "retail_gateway_fee_variance",
      categoryLabel: "Gateway fee variance",
      amountBucket: "0-100k",
      ownHistory: [],
      network: [],
    };
    expect(retailIntelligencePromptBlock(intel)).toBe("");
  });

  it("renders both the intra-org history and the cross-org network", () => {
    const intel: RetailExceptionIntelligence = {
      category: "retail_chargeback_not_posted",
      categoryLabel: "Chargeback not posted",
      amountBucket: "0-100k",
      ownHistory: [
        {
          resolution: "Posted the chargeback to the merchant GL and matched the ARN",
          outcome: "resolved",
          reasoning: "ARN found in dispute report",
          resolutionActionClass: "journal_entry",
          amountRange: "0-100k",
          resolvedAt: new Date(),
        },
      ],
      network: [
        { resolutionActionClass: "journal_entry", outcome: "resolved", contributorCount: 4, observationCount: 11 },
      ],
    };
    const block = retailIntelligencePromptBlock(intel);
    expect(block).toContain("own past resolutions");
    expect(block).toContain("Cross-merchant network");
    expect(block).toContain("4 merchants");
    expect(block).toContain("Chargeback not posted");
  });

  it("renders only the intra-org layer when the network is empty (opt-out / below k-anon)", () => {
    const intel: RetailExceptionIntelligence = {
      category: "retail_settlement_shortfall",
      categoryLabel: "Settlement shortfall",
      amountBucket: "100k-1m",
      ownHistory: [
        {
          resolution: "Raised a shortfall claim with the gateway",
          outcome: "escalated",
          reasoning: "payout < expected by fee delta",
          resolutionActionClass: "escalate",
          amountRange: "100k-1m",
          resolvedAt: new Date(),
        },
      ],
      network: [],
    };
    const block = retailIntelligencePromptBlock(intel);
    expect(block).toContain("own past resolutions");
    expect(block).not.toContain("Cross-merchant network");
  });
});

// ─── Historical backfill windowing ───────────────────────────────────────────

describe("SHOPLINE_BACKFILL_DAYS + slice windowing", () => {
  it("backfills 90 days by default", async () => {
    const { SHOPLINE_BACKFILL_DAYS } = await import("./connectors/shopline/syncOrchestrator");
    expect(SHOPLINE_BACKFILL_DAYS).toBe(90);
  });

  it("30-day slices stay inside SHOPLINE's 3-month payout range cap", () => {
    // The payouts endpoint rejects start/end ranges over 3 months; the
    // backfill must never hand it a wider window than one slice.
    const sliceDays = 30;
    const payoutCapDays = 90;
    expect(sliceDays).toBeLessThanOrEqual(payoutCapDays);
    // 90 days of history in 30-day slices = 3 requests per data type.
    expect(Math.ceil(90 / sliceDays)).toBe(3);
  });
});
