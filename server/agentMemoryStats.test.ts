import { describe, expect, it } from "vitest";
import { groupMemoryGrowthByMonth, sixMonthsAgoUtc } from "./agentMemoryStats";

describe("agent-memory dashboard statistics", () => {
  it("uses a UTC six-month boundary without database date functions", () => {
    const now = new Date("2026-08-17T00:11:43.182Z");
    expect(sixMonthsAgoUtc(now).toISOString()).toBe("2026-02-17T00:11:43.182Z");
  });

  it("groups timestamp rows chronologically across year boundaries", () => {
    const growth = groupMemoryGrowthByMonth([
      { createdAt: new Date("2026-01-31T23:59:59.000Z") },
      { createdAt: new Date("2025-12-01T00:00:00.000Z") },
      { createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { createdAt: new Date("2025-12-31T23:00:00.000Z") },
    ]);

    expect(growth).toEqual([
      { month: "2025-12", count: 2 },
      { month: "2026-01", count: 2 },
    ]);
  });
});
