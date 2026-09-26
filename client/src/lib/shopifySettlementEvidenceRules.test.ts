import { describe, expect, it } from "vitest";
import {
  canCheckSettlementEvidence,
  canImportSettlementEvidence,
  settlementEvidenceInputError,
  SHOPIFY_SETTLEMENT_MAX_FILE_BYTES,
} from "./shopifySettlementEvidenceRules";

const file = { name: "settlement.csv", size: 300, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) } as File;
const preview = {
  committed: false as const,
  headers: ["order", "amount"],
  mapping: { orderRef: "order", amount: "amount" },
  missingRequired: [],
  totalRows: 2,
  parseErrors: [],
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
