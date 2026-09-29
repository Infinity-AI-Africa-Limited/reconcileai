import { describe, expect, it } from "vitest";
import {
  canImportShoplineSettlement,
  shoplineMappingEdited,
  shoplineSettlementFileError,
  shoplineSettlementMapping,
  SHOPLINE_SETTLEMENT_MAX_BYTES,
} from "./shoplineSettlementImport";

const checked = { orderRef: "Order", amount: "Net" };
const ready = {
  busy: false,
  preview: { committed: false, missingRequired: [] as string[] },
  checkedMapping: checked,
  columnMapping: checked,
};

describe("when a SHOPLINE merchant edits the column mapping", () => {
  it("should map an unfamiliar header to a required field", () => {
    const mapping = shoplineSettlementMapping.assign({ amount: "Net" }, "orderRef", "Merchant Ref");
    expect(mapping).toEqual({ orderRef: "Merchant Ref", amount: "Net" });
    expect(shoplineSettlementMapping.missingRequired(mapping)).toEqual([]);
  });

  it("should unmap a wrongly detected free-text description", () => {
    expect(shoplineSettlementMapping.assign({ ...checked, description: "Memo" }, "description", null)).toEqual(checked);
  });

  it("should never let two fields read the same column", () => {
    expect(shoplineSettlementMapping.assign({ orderRef: "Ref", gatewayRef: "Txn" }, "orderRef", "Txn")).toEqual({
      orderRef: "Txn",
    });
  });
});

describe("when the merchant asks to import", () => {
  it("should allow the mapping the last check confirmed", () => {
    expect(canImportShoplineSettlement(ready)).toBe(true);
  });

  it("should refuse a mapping edited since the check, until it is checked again", () => {
    const edited = { ...ready, columnMapping: shoplineSettlementMapping.assign(checked, "amount", "Gross") };
    expect(shoplineMappingEdited(edited)).toBe(true);
    expect(canImportShoplineSettlement(edited)).toBe(false);
  });

  it("should refuse before any check, while busy, when a required field is missing, or once imported", () => {
    expect(canImportShoplineSettlement({ ...ready, preview: null })).toBe(false);
    expect(canImportShoplineSettlement({ ...ready, busy: true })).toBe(false);
    expect(canImportShoplineSettlement({ ...ready, preview: { committed: false, missingRequired: ["orderRef"] } })).toBe(false);
    expect(canImportShoplineSettlement({ ...ready, checkedMapping: { orderRef: "Order" }, columnMapping: { orderRef: "Order" } })).toBe(false);
    expect(canImportShoplineSettlement({ ...ready, preview: { committed: true, missingRequired: [] } })).toBe(false);
  });
});

describe("when the merchant chooses a file", () => {
  it("should refuse none, and one over the limit, before reading it", () => {
    expect(shoplineSettlementFileError(null)).toMatch(/choose/i);
    expect(shoplineSettlementFileError({ size: SHOPLINE_SETTLEMENT_MAX_BYTES + 1 })).toMatch(/10MB/);
    expect(shoplineSettlementFileError({ size: 1024 })).toBeNull();
  });
});
