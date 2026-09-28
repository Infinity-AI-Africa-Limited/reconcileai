import { describe, expect, it } from "vitest";
import {
  assignSettlementColumn,
  confirmedSettlementMapping,
  missingRequiredSettlementFields,
  sameSettlementMapping,
} from "./shopifySettlementMapping";

describe("Shopify settlement column mapping", () => {
  describe("when the merchant assigns a column", () => {
    it("should map an unfamiliar header to a required field", () => {
      const mapping = assignSettlementColumn({ amount: "Net" }, "orderRef", "Merchant Ref");
      expect(mapping).toEqual({ orderRef: "Merchant Ref", amount: "Net" });
      expect(missingRequiredSettlementFields(mapping)).toEqual([]);
    });

    it("should move a column off the field that had it, so two fields never read one column", () => {
      expect(assignSettlementColumn({ orderRef: "Ref", gatewayRef: "Txn" }, "orderRef", "Txn")).toEqual({
        orderRef: "Txn",
      });
    });

    it("should unmap a wrongly detected optional column", () => {
      expect(assignSettlementColumn({ orderRef: "Order", amount: "Net", fee: "Gross" }, "fee", null)).toEqual({
        orderRef: "Order",
        amount: "Net",
      });
    });
  });

  describe("when a mapping is submitted", () => {
    it("should never carry the free-text description field the import discards", () => {
      expect(confirmedSettlementMapping({ orderRef: "Order", amount: "Net", description: "Memo" })).toEqual({
        orderRef: "Order",
        amount: "Net",
      });
    });

    it("should report the required fields still unmapped", () => {
      expect(missingRequiredSettlementFields({ fee: "Fee" })).toEqual(["orderRef", "amount"]);
    });
  });

  describe("when the mapping changes after it was checked", () => {
    it("should no longer match the checked mapping", () => {
      const checked = { orderRef: "Order", amount: "Net" };
      expect(sameSettlementMapping(checked, { amount: "Net", orderRef: "Order" })).toBe(true);
      expect(sameSettlementMapping(checked, assignSettlementColumn(checked, "amount", "Gross"))).toBe(false);
    });
  });
});
