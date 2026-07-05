/**
 * Per-Institution Learning (shared module) — Unit Tests
 *
 * Covers the pure aggregation + enrichment functions used by both the mobile
 * money engine and the generic POC engine.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeResolutionHistory,
  enrichWithInstitutionalMemory,
} from "./institutionalLearning";
import { classifyResolutionAction } from "./exceptionIntelligence";

describe("summarizeResolutionHistory", () => {
  it("ignores OPEN rows and aggregates terminal statuses per category", () => {
    const stats = summarizeResolutionHistory(
      [
        { category: "AMOUNT_MISMATCH", reviewStatus: "RESOLVED", reviewNote: "Fee posted to GL" },
        { category: "AMOUNT_MISMATCH", reviewStatus: "ESCALATED", reviewNote: "Escalated to processor" },
        { category: "AMOUNT_MISMATCH", reviewStatus: "OPEN", reviewNote: null },
        { category: "DUPLICATE", reviewStatus: "RESOLVED", reviewNote: "Duplicate reversed" },
      ],
      classifyResolutionAction,
    );
    expect(stats.get("AMOUNT_MISMATCH")!.actioned).toBe(2);
    expect(stats.get("AMOUNT_MISMATCH")!.resolved).toBe(1);
    expect(stats.get("AMOUNT_MISMATCH")!.escalated).toBe(1);
    expect(stats.get("DUPLICATE")!.actioned).toBe(1);
    expect(stats.size).toBe(2);
  });

  it("returns an empty map for empty or all-OPEN history", () => {
    expect(summarizeResolutionHistory([], classifyResolutionAction).size).toBe(0);
    const stats = summarizeResolutionHistory(
      [{ category: "X", reviewStatus: "OPEN", reviewNote: null }],
      classifyResolutionAction,
    );
    expect(stats.size).toBe(0);
  });
});

describe("enrichWithInstitutionalMemory", () => {
  const baseItem = {
    category: "AMOUNT_MISMATCH",
    agentExplanation: "Amounts differ between systems.",
    agentConfidence: 85,
  };

  function statsFor(category: string, actioned: number) {
    return new Map([
      [category, { category, actioned, resolved: actioned, escalated: 0, topActionClass: null }],
    ]);
  }

  it("appends the institutional memory citation and counts enriched items", () => {
    const { items, learningApplied } = enrichWithInstitutionalMemory(
      [{ ...baseItem }],
      statsFor("AMOUNT_MISMATCH", 3),
    );
    expect(learningApplied).toBe(1);
    expect(items[0].agentExplanation).toContain("Institutional memory");
    expect(items[0].agentExplanation).toContain("3 similar exceptions");
  });

  it("raises confidence with corroborating history, capped at 98", () => {
    const { items } = enrichWithInstitutionalMemory([{ ...baseItem }], statsFor("AMOUNT_MISMATCH", 3));
    expect(items[0].agentConfidence).toBe(88); // 85 + min(6, 3)

    const { items: capped } = enrichWithInstitutionalMemory(
      [{ ...baseItem, agentConfidence: 96 }],
      statsFor("AMOUNT_MISMATCH", 20),
    );
    expect(capped[0].agentConfidence).toBe(98); // 96 + 6 → capped
  });

  it("leaves items without matching history untouched", () => {
    const { items, learningApplied } = enrichWithInstitutionalMemory(
      [{ ...baseItem, category: "NEVER_SEEN" }],
      statsFor("AMOUNT_MISMATCH", 3),
    );
    expect(learningApplied).toBe(0);
    expect(items[0].agentExplanation).not.toContain("Institutional memory");
    expect(items[0].agentConfidence).toBe(85);
  });

  it("cites the dominant resolution approach when known", () => {
    const stats = new Map([
      ["AMOUNT_MISMATCH", {
        category: "AMOUNT_MISMATCH", actioned: 2, resolved: 2, escalated: 0,
        topActionClass: "fee_posting",
      }],
    ]);
    const { items } = enrichWithInstitutionalMemory([{ ...baseItem }], stats);
    expect(items[0].agentExplanation).toContain("fee posting");
  });
});
