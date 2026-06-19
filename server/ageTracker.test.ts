import { describe, it, expect } from "vitest";
import { ageDays, escalationLevel, isOverAged, bucketOf, computeSummary } from "./ageTracker";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("age computation", () => {
  it("counts whole days outstanding", () => {
    expect(ageDays(daysAgo(0))).toBe(0);
    expect(ageDays(daysAgo(5))).toBe(5);
    expect(ageDays(daysAgo(40))).toBe(40);
  });
});

describe("escalation level (SLA-relative, default 7)", () => {
  it("escalates as items age past the SLA", () => {
    expect(escalationLevel(3)).toBe("on_track"); // ≤ 7
    expect(escalationLevel(7)).toBe("on_track");
    expect(escalationLevel(10)).toBe("watch"); // ≤ 14
    expect(escalationLevel(20)).toBe("overdue"); // ≤ 28
    expect(escalationLevel(40)).toBe("breach"); // > 28
  });
  it("respects a custom SLA", () => {
    expect(escalationLevel(3, 2)).toBe("watch"); // sla 2 → 3 is >2,≤4
    expect(isOverAged(3, 2)).toBe(true);
    expect(isOverAged(2, 2)).toBe(false);
  });
});

describe("aging buckets", () => {
  it("places ages in the right bucket", () => {
    expect(bucketOf(0)).toBe("0-2");
    expect(bucketOf(2)).toBe("0-2");
    expect(bucketOf(5)).toBe("3-7");
    expect(bucketOf(20)).toBe("8-30");
    expect(bucketOf(31)).toBe("30+");
    expect(bucketOf(400)).toBe("30+");
  });
});

describe("summary", () => {
  it("aggregates counts, exposure, over-aged and oldest", () => {
    const items = [
      { ageDays: 1, amount: 1000 }, // current, on_track
      { ageDays: 5, amount: 2000 }, // 3-7, on_track
      { ageDays: 10, amount: 50000 }, // 8-30, watch, over-aged
      { ageDays: 40, amount: 500000 }, // 30+, breach, over-aged
    ];
    const s = computeSummary(items, 7);
    expect(s.totalOpen).toBe(4);
    expect(s.totalExposure).toBe(553000);
    expect(s.overAgedCount).toBe(2); // ages 10 and 40
    expect(s.overAgedExposure).toBe(550000);
    expect(s.oldestAgeDays).toBe(40);
    expect(s.escalation.on_track).toBe(2);
    expect(s.escalation.watch).toBe(1);
    expect(s.escalation.breach).toBe(1);

    const b830 = s.buckets.find((b) => b.key === "8-30")!;
    expect(b830.count).toBe(1);
    expect(b830.exposure).toBe(50000);
  });

  it("handles an empty set", () => {
    const s = computeSummary([], 7);
    expect(s.totalOpen).toBe(0);
    expect(s.overAgedCount).toBe(0);
    expect(s.oldestAgeDays).toBe(0);
  });
});
