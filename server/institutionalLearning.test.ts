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
  enrichItemWithInstitutionalMemory,
  institutionalMemoryNote,
  formatNetworkGuidance,
  type CategoryResolutionStats,
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

describe("enrichItemWithInstitutionalMemory (single-item, used by Woodcore Layer 3)", () => {
  const stats = new Map<string, CategoryResolutionStats>([
    ["MANUAL_POSTING", { category: "MANUAL_POSTING", actioned: 4, resolved: 3, escalated: 1, topActionClass: "journal_entry" }],
  ]);

  it("enriches a matching item and reports applied=true", () => {
    const { item, applied } = enrichItemWithInstitutionalMemory(
      { category: "MANUAL_POSTING", agentExplanation: "Manual entry detected.", agentConfidence: 90 },
      stats,
    );
    expect(applied).toBe(true);
    expect(item.agentExplanation).toContain("Institutional memory");
    expect(item.agentExplanation).toContain("4 similar exceptions");
    expect(item.agentExplanation).toContain("journal entry");
    expect(item.agentConfidence).toBe(94); // 90 + min(6, 4)
  });

  it("returns the item unchanged when no history matches", () => {
    const original = { category: "ORPHANED_ENTRY", agentExplanation: "Orphaned.", agentConfidence: 88 };
    const { item, applied } = enrichItemWithInstitutionalMemory(original, stats);
    expect(applied).toBe(false);
    expect(item).toBe(original);
  });
});

describe("institutionalMemoryNote", () => {
  it("is empty without history and populated with it", () => {
    expect(institutionalMemoryNote(undefined)).toBe("");
    expect(institutionalMemoryNote({ category: "X", actioned: 0, resolved: 0, escalated: 0, topActionClass: null })).toBe("");
    const note = institutionalMemoryNote({ category: "X", actioned: 2, resolved: 2, escalated: 0, topActionClass: null });
    expect(note).toContain("2 similar exceptions");
  });
});

describe("formatNetworkGuidance (cross-institution read-path)", () => {
  it("returns empty string for an empty pool", () => {
    expect(formatNetworkGuidance([])).toBe("");
  });

  it("formats k-anonymous patterns as prompt guidance, capped at 3", () => {
    const guidance = formatNetworkGuidance([
      { resolutionActionClass: "journal_entry", outcome: "resolved", contributorCount: 4, observationCount: 31 },
      { resolutionActionClass: "escalate", outcome: "escalated", contributorCount: 3, observationCount: 12 },
      { resolutionActionClass: "write_off", outcome: "resolved", contributorCount: 3, observationCount: 7 },
      { resolutionActionClass: "reversal", outcome: "resolved", contributorCount: 3, observationCount: 4 },
    ]);
    expect(guidance).toContain("Cross-institution intelligence");
    expect(guidance).toContain("journal entry → resolved (seen across 4 institutions, 31 cases)");
    expect(guidance).not.toContain("reversal"); // 4th entry dropped
  });

  it("contains only categorical tokens — no identifiers, amounts, or org names", () => {
    const guidance = formatNetworkGuidance([
      { resolutionActionClass: "fee_posting", outcome: "resolved", contributorCount: 5, observationCount: 20 },
    ]);
    // Nothing that looks like an account number, currency amount, or email.
    expect(guidance).not.toMatch(/\d{6,}/);
    expect(guidance).not.toMatch(/[₦$€£]\s*\d/);
    expect(guidance).not.toMatch(/@/);
  });
});
