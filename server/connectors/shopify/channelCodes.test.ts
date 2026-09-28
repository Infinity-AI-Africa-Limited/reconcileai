import { describe, expect, it } from "vitest";
import { shopifyOrdersChannelCode, shopifySettlementEvidenceChannelCode } from "./channelCodes";
import { shopifyOrdersChannelCode as onboardingOrdersCode } from "./onboarding";
import { shopifySettlementEvidenceChannelCode as importSettlementCode } from "./settlementEvidence";
import { shopifyOrdersChannelCode as syncOrdersCode } from "./syncOrchestrator";

describe("when a Shopify store's channels are named", () => {
  it("should keep the codes already stored in production", () => {
    // Persisted in channels.code: renaming one orphans every existing channel.
    expect(shopifyOrdersChannelCode(7)).toBe("shopify_orders_7");
    expect(shopifySettlementEvidenceChannelCode(7)).toBe("shopify_settlement_evidence_7");
  });

  it("should give every module the one definition", () => {
    expect(onboardingOrdersCode).toBe(shopifyOrdersChannelCode);
    expect(syncOrdersCode).toBe(shopifyOrdersChannelCode);
    expect(importSettlementCode).toBe(shopifySettlementEvidenceChannelCode);
  });
});
