import { describe, expect, it } from "vitest";
import {
  canCheckSettlementEvidence,
  canImportSettlementEvidence,
  settlementEvidenceInputError,
  SHOPIFY_SETTLEMENT_MAX_FILE_BYTES,
  unalignedRowsNotice,
} from "./shopifySettlementEvidenceRules";

const file = { name: "settlement.csv", size: 300, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) } as File;
const preview = {
  committed: false as const,
  headers: ["order", "amount"],
  mapping: { orderRef: "order", amount: "amount" },
  missingRequired: [],
  totalRows: 2,
  parseErrors: [],
  unalignedRows: 0,
};

const eligibility = {
  file,
  sourceLabel: "Bank export",
  busy: false,
  preview,
  result: null,
  checkedMapping: { orderRef: "order", amount: "amount" },
  mappingEdited: false,
};

describe("Shopify settlement evidence rules", () => {
  it("keeps the file-size and source-label rules out of the page", () => {
    expect(settlementEvidenceInputError(null, "Bank export")).toContain("Choose a CSV or Excel");
    expect(settlementEvidenceInputError(file, "  ")).toContain("Enter the source");
    expect(settlementEvidenceInputError({ ...file, size: SHOPIFY_SETTLEMENT_MAX_FILE_BYTES + 1 }, "Bank export")).toContain("larger than 10MB");
    expect(canCheckSettlementEvidence(eligibility)).toBe(true);
    expect(canCheckSettlementEvidence({ ...eligibility, busy: true })).toBe(false);
  });

  it("permits import only from an unchanged, server-checked mapping", () => {
    expect(canImportSettlementEvidence(eligibility)).toBe(true);
    expect(canImportSettlementEvidence({ ...eligibility, mappingEdited: true })).toBe(false);
    expect(canImportSettlementEvidence({ ...eligibility, preview: { ...preview, missingRequired: ["amount"] } })).toBe(false);
    expect(canImportSettlementEvidence({ ...eligibility, checkedMapping: null })).toBe(false);
    expect(canImportSettlementEvidence({ ...eligibility, result: { committed: true, mapping: {}, totalRows: 1, imported: 1, duplicates: 0, failed: 0, matchedCount: 1, exceptionCount: 0 } })).toBe(false);
  });
});

describe("when rows name orders ReconcileAI has not synced", () => {
  it("should warn before import, while syncing first can still link them", () => {
    const notice = unalignedRowsNotice({ committed: false, unalignedRows: 3 });
    expect(notice).toContain("3 rows name Shopify orders ReconcileAI has not synced");
    expect(notice).toContain("refresh order evidence before importing");
    expect(notice).toContain("will not link them");
  });

  it("should read correctly for a single row", () => {
    expect(unalignedRowsNotice({ committed: false, unalignedRows: 1 })).toContain("If it is a recent order");
  });

  it("should explain the exceptions after import, and that re-importing will not fix them", () => {
    expect(unalignedRowsNotice({ committed: true, unalignedRows: 1 })).toBe(
      "1 imported row names no Shopify order ReconcileAI has synced, so it was flagged as an exception. Importing the file again will not link it to its order.",
    );
  });

  it("should say nothing when every row names a synced order, or rows could not be read", () => {
    expect(unalignedRowsNotice({ committed: false, unalignedRows: 0 })).toBeNull();
    expect(unalignedRowsNotice({ committed: false, unalignedRows: null })).toBeNull();
    expect(unalignedRowsNotice({ committed: true, unalignedRows: 0 })).toBeNull();
  });
});
