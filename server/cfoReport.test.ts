import { describe, it, expect } from "vitest";
import { periodLabel, isBoardPeriod } from "./cfoReportService";

describe("CFO report periods", () => {
  it("labels the fixed windows", () => {
    expect(periodLabel("7d")).toBe("Last 7 Days");
    expect(periodLabel("30d")).toBe("Last 30 Days");
    expect(periodLabel("mtd")).toBe("Month to Date");
  });

  it("labels the current quarter (to date)", () => {
    expect(periodLabel("quarterly")).toMatch(/^Q[1-4] \d{4} \(to date\)$/);
  });

  it("labels the last complete quarter", () => {
    expect(periodLabel("last_quarter")).toMatch(/^Q[1-4] \d{4}$/);
  });

  it("flags quarterly periods as board-level", () => {
    expect(isBoardPeriod("quarterly")).toBe(true);
    expect(isBoardPeriod("last_quarter")).toBe(true);
    expect(isBoardPeriod("7d")).toBe(false);
    expect(isBoardPeriod("30d")).toBe(false);
    expect(isBoardPeriod("mtd")).toBe(false);
  });

  it("uses the correct quarter number for the current month", () => {
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3) + 1;
    expect(periodLabel("quarterly")).toContain(`Q${q} ${now.getFullYear()}`);
  });
});
