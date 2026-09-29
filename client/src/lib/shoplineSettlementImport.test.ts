import { describe, expect, it } from "vitest";
import {
  canImportShoplineSettlement,
  initialShoplineImportState,
  shoplineImportReducer,
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

describe("when the merchant replaces the file while a request is still running", () => {
  // Greptile #164: a check for the first file finished after the second was
  // chosen and confirmed its mapping onto the second — which could then be
  // imported against columns nobody checked for it.
  type FakeFile = { name: string; size: number };
  const first: FakeFile = { name: "sept-a.csv", size: 10 };
  const second: FakeFile = { name: "sept-b.csv", size: 10 };
  const preview = {
    committed: false,
    headers: ["Order", "Net"],
    mapping: { orderRef: "Order", amount: "Net" },
    missingRequired: [],
    totalRows: 3,
    parseErrors: [],
  };

  const chooseThenReplace = () => {
    let state = shoplineImportReducer(initialShoplineImportState<FakeFile>(), { type: "chooseFile", file: first });
    const sentFor = state.generation;
    state = shoplineImportReducer(state, { type: "started", generation: sentFor, mode: "checking" });
    state = shoplineImportReducer(state, { type: "chooseFile", file: second });
    return { state, sentFor };
  };

  it("should drop the first file's check instead of confirming its mapping for the second", () => {
    const { state, sentFor } = chooseThenReplace();
    const after = shoplineImportReducer(state, { type: "checked", generation: sentFor, preview });

    expect(after.file).toBe(second);
    expect(after.preview).toBeNull();
    expect(after.checkedMapping).toBeNull();
    expect(canImportShoplineSettlement({ ...after, busy: after.busy !== null })).toBe(false);
  });

  it("should drop a late import result or failure for the replaced file", () => {
    const { state, sentFor } = chooseThenReplace();
    const committed = { ...preview, committed: true, imported: 3, duplicates: 0, failed: 0, matchedCount: 3 };
    expect(shoplineImportReducer(state, { type: "imported", generation: sentFor, result: committed }).result).toBeNull();
    expect(shoplineImportReducer(state, { type: "failed", generation: sentFor, message: "boom" }).error).toBeNull();
  });

  it("should apply a check for the file still on screen, and confirm its mapping", () => {
    const { state } = chooseThenReplace();
    const after = shoplineImportReducer(state, { type: "checked", generation: state.generation, preview });

    expect(after.checkedMapping).toEqual({ orderRef: "Order", amount: "Net" });
    expect(canImportShoplineSettlement({ ...after, busy: after.busy !== null })).toBe(true);
  });

  it("should keep the source label across a file change, and clear everything checked", () => {
    let state = shoplineImportReducer(initialShoplineImportState<FakeFile>(), { type: "sourceLabel", value: "Stripe" });
    state = shoplineImportReducer(state, { type: "chooseFile", file: first });
    state = shoplineImportReducer(state, { type: "checked", generation: state.generation, preview });
    state = shoplineImportReducer(state, { type: "chooseFile", file: second });

    expect(state.sourceLabel).toBe("Stripe");
    expect(state.columnMapping).toBeNull();
    expect(state.checkedMapping).toBeNull();
  });
});
