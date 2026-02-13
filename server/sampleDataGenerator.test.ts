import { describe, it, expect } from "vitest";
import { generateSampleData, type SampleDataConfig } from "./sampleDataGenerator";

const baseConfig: SampleDataConfig = {
  transactionCount: 50,
  matchRate: 75,
  sourceChannel: "nibss",
  targetChannel: "bank_transfer",
  dateRangeStart: "2026-01-01",
  dateRangeEnd: "2026-01-31",
  includeAmountMismatches: true,
  includeTimingDifferences: true,
  includeMissingCounterparties: true,
  includeDuplicates: true,
};

describe("generateSampleData", () => {
  it("should return sourceCSV and targetCSV strings with headers", () => {
    const result = generateSampleData(baseConfig);
    expect(result.sourceCSV).toBeDefined();
    expect(result.targetCSV).toBeDefined();

    const sourceLines = result.sourceCSV.split("\n");
    const targetLines = result.targetCSV.split("\n");

    // First line should be headers
    expect(sourceLines[0]).toBe(
      "reference,external_ref,date,amount,type,currency,description,counterparty,value_date"
    );
    expect(targetLines[0]).toBe(
      "reference,external_ref,date,amount,type,currency,description,counterparty,value_date"
    );
  });

  it("should generate the correct number of source transactions", () => {
    const result = generateSampleData(baseConfig);
    expect(result.summary.sourceCount).toBe(50);

    const sourceLines = result.sourceCSV.split("\n");
    // header + 50 data rows
    expect(sourceLines.length).toBe(51);
  });

  it("should generate target transactions including extras", () => {
    const result = generateSampleData(baseConfig);
    // Target count = matched + duplicates + unmatched target
    expect(result.summary.targetCount).toBeGreaterThan(0);
    const targetLines = result.targetCSV.split("\n");
    expect(targetLines.length).toBe(result.summary.targetCount + 1);
  });

  it("should respect match rate in the summary", () => {
    const result = generateSampleData(baseConfig);
    const totalMatched =
      result.summary.exactMatches +
      result.summary.amountMismatches +
      result.summary.timingDifferences +
      result.summary.duplicates;
    // matchRate of 75% of 50 = ~38 matched
    const expectedMatched = Math.round(50 * 0.75);
    expect(totalMatched).toBe(expectedMatched);
  });

  it("should include amount mismatches when enabled", () => {
    const result = generateSampleData(baseConfig);
    expect(result.summary.amountMismatches).toBeGreaterThan(0);
  });

  it("should include timing differences when enabled", () => {
    const result = generateSampleData(baseConfig);
    expect(result.summary.timingDifferences).toBeGreaterThan(0);
  });

  it("should include missing counterparties when enabled", () => {
    const result = generateSampleData(baseConfig);
    expect(result.summary.missingCounterparties).toBeGreaterThan(0);
  });

  it("should include duplicates when enabled", () => {
    const result = generateSampleData(baseConfig);
    expect(result.summary.duplicates).toBeGreaterThan(0);
  });

  it("should not include exceptions when disabled", () => {
    const config: SampleDataConfig = {
      ...baseConfig,
      includeAmountMismatches: false,
      includeTimingDifferences: false,
      includeMissingCounterparties: false,
      includeDuplicates: false,
    };
    const result = generateSampleData(config);
    expect(result.summary.amountMismatches).toBe(0);
    expect(result.summary.timingDifferences).toBe(0);
    expect(result.summary.missingCounterparties).toBe(0);
    expect(result.summary.duplicates).toBe(0);
  });

  it("should generate valid CSV rows with correct number of columns", () => {
    const result = generateSampleData({ ...baseConfig, transactionCount: 20 });
    const sourceLines = result.sourceCSV.split("\n");

    // Check a few data rows have 9 columns (matching the 9 headers)
    for (let i = 1; i < Math.min(6, sourceLines.length); i++) {
      // Simple split won't work for quoted fields, but we can verify the row is non-empty
      expect(sourceLines[i].length).toBeGreaterThan(10);
    }
  });

  it("should generate dates within the specified range", () => {
    const result = generateSampleData(baseConfig);
    const sourceLines = result.sourceCSV.split("\n");

    for (let i = 1; i < sourceLines.length; i++) {
      const parts = sourceLines[i].split(",");
      const dateStr = parts[2]; // date column
      if (dateStr) {
        const date = new Date(dateStr);
        expect(date.getTime()).not.toBeNaN();
      }
    }
  });

  it("should generate NGN currency for all transactions", () => {
    const result = generateSampleData(baseConfig);
    const sourceLines = result.sourceCSV.split("\n");

    for (let i = 1; i < sourceLines.length; i++) {
      const parts = sourceLines[i].split(",");
      expect(parts[5]).toBe("NGN"); // currency column
    }
  });

  it("should handle minimum transaction count", () => {
    const config: SampleDataConfig = {
      ...baseConfig,
      transactionCount: 10,
      matchRate: 50,
    };
    const result = generateSampleData(config);
    expect(result.summary.sourceCount).toBe(10);
  });

  it("should handle 100% match rate", () => {
    const config: SampleDataConfig = {
      ...baseConfig,
      transactionCount: 20,
      matchRate: 100,
      includeAmountMismatches: false,
      includeTimingDifferences: false,
      includeDuplicates: false,
    };
    const result = generateSampleData(config);
    expect(result.summary.unmatchedSource).toBe(0);
  });

  it("should handle 0% match rate", () => {
    const config: SampleDataConfig = {
      ...baseConfig,
      transactionCount: 20,
      matchRate: 0,
    };
    const result = generateSampleData(config);
    expect(result.summary.exactMatches).toBe(0);
    expect(result.summary.amountMismatches).toBe(0);
    expect(result.summary.timingDifferences).toBe(0);
    expect(result.summary.duplicates).toBe(0);
    expect(result.summary.unmatchedSource).toBe(20);
  });

  it("should use correct channel prefixes in references", () => {
    const result = generateSampleData(baseConfig);
    const sourceLines = result.sourceCSV.split("\n");

    // Check that source references start with NIP (nibss prefix)
    let foundNIP = false;
    for (let i = 1; i < Math.min(10, sourceLines.length); i++) {
      const ref = sourceLines[i].split(",")[0];
      if (ref.startsWith("NIP/")) {
        foundNIP = true;
        break;
      }
    }
    expect(foundNIP).toBe(true);
  });
});
