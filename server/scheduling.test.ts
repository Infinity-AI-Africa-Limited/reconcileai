import { describe, it, expect } from "vitest";
import {
  calculateNextRun,
  validateScheduleConfig,
  getFrequencyDescription,
} from "./schedulingEngine";
import {
  generateEmailReportContent,
  type ReportData,
} from "./emailReportService";

// ─── calculateNextRun Tests ─────────────────────────────────────────

describe("calculateNextRun", () => {
  it("schedules daily run for tomorrow if today's time has passed", () => {
    // Use a time that's clearly past 09:00 in local timezone
    const now = new Date(2026, 1, 14, 10, 0, 0); // Feb 14 10:00 local
    const next = calculateNextRun("daily", "09:00", { fromDate: now });
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it("schedules daily run for today if time has not passed", () => {
    const now = new Date(2026, 1, 14, 8, 0, 0); // Feb 14 08:00 local
    const next = calculateNextRun("daily", "09:00", { fromDate: now });
    expect(next.getDate()).toBe(14);
    expect(next.getHours()).toBe(9);
  });

  it("schedules weekly run on correct day of week", () => {
    const now = new Date(2026, 1, 14, 10, 0, 0); // Feb 14 local
    const nowDay = now.getDay();
    // Schedule for a day 2 days ahead
    const targetDay = (nowDay + 2) % 7;
    const next = calculateNextRun("weekly", "09:00", {
      scheduledDayOfWeek: targetDay,
      fromDate: now,
    });
    expect(next.getDay()).toBe(targetDay);
    expect(next > now).toBe(true);
  });

  it("schedules biweekly run 14 days ahead if same day has passed", () => {
    const now = new Date(2026, 1, 14, 10, 0, 0); // Feb 14 10:00 local, Saturday
    const next = calculateNextRun("biweekly", "09:00", {
      scheduledDayOfWeek: 6, // Saturday
      fromDate: now,
    });
    // Should be 14 days from now since today's time passed
    expect(next.getDate()).toBe(28);
  });

  it("schedules monthly run on the correct day", () => {
    const now = new Date(2026, 1, 14, 10, 0, 0); // Feb 14 local
    const next = calculateNextRun("monthly", "09:00", {
      scheduledDayOfMonth: 1,
      fromDate: now,
    });
    // Day 1 has passed this month, so next month
    expect(next.getMonth()).toBe(2); // March
    expect(next.getDate()).toBe(1);
  });

  it("schedules monthly run this month if day has not passed", () => {
    const now = new Date(2026, 1, 14, 8, 0, 0); // Feb 14 08:00 local
    const next = calculateNextRun("monthly", "09:00", {
      scheduledDayOfMonth: 28,
      fromDate: now,
    });
    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(28);
  });

  it("handles month-end overflow (day 31 in February)", () => {
    const now = new Date(2026, 1, 14, 10, 0, 0); // Feb 14 local
    const next = calculateNextRun("monthly", "09:00", {
      scheduledDayOfMonth: 31,
      fromDate: now,
    });
    // February has 28 days, so should clamp to 28
    expect(next.getDate()).toBe(28);
  });
});

// ─── validateScheduleConfig Tests ───────────────────────────────────

describe("validateScheduleConfig", () => {
  const validConfig = {
    name: "Daily POS Reconciliation",
    sourceChannelId: 1,
    targetChannelId: 2,
    frequency: "daily" as const,
    scheduledTime: "09:00",
  };

  it("returns no errors for valid daily config", () => {
    const errors = validateScheduleConfig(validConfig);
    expect(errors).toHaveLength(0);
  });

  it("requires name", () => {
    const errors = validateScheduleConfig({ ...validConfig, name: "" });
    expect(errors).toContain("Schedule name is required");
  });

  it("validates time format", () => {
    const errors = validateScheduleConfig({ ...validConfig, scheduledTime: "9:00" });
    expect(errors.some((e) => e.includes("HH:mm"))).toBe(true);
  });

  it("validates invalid time values", () => {
    const errors = validateScheduleConfig({ ...validConfig, scheduledTime: "25:00" });
    expect(errors.some((e) => e.includes("Invalid time"))).toBe(true);
  });

  it("requires day of week for weekly schedule", () => {
    const errors = validateScheduleConfig({
      ...validConfig,
      frequency: "weekly",
    });
    expect(errors.some((e) => e.includes("Day of week"))).toBe(true);
  });

  it("requires day of month for monthly schedule", () => {
    const errors = validateScheduleConfig({
      ...validConfig,
      frequency: "monthly",
    });
    expect(errors.some((e) => e.includes("Day of month"))).toBe(true);
  });

  it("rejects same source and target channel", () => {
    const errors = validateScheduleConfig({
      ...validConfig,
      sourceChannelId: 1,
      targetChannelId: 1,
    });
    expect(errors.some((e) => e.includes("different"))).toBe(true);
  });

  it("validates lookback days range", () => {
    const errors = validateScheduleConfig({ ...validConfig, lookbackDays: 100 });
    expect(errors.some((e) => e.includes("Lookback days"))).toBe(true);
  });

  it("validates email addresses", () => {
    const errors = validateScheduleConfig({
      ...validConfig,
      emailRecipients: ["valid@email.com", "invalid-email"],
    });
    expect(errors.some((e) => e.includes("Invalid email"))).toBe(true);
  });

  it("accepts valid weekly config with day of week", () => {
    const errors = validateScheduleConfig({
      ...validConfig,
      frequency: "weekly",
      scheduledDayOfWeek: 1,
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts valid monthly config with day of month", () => {
    const errors = validateScheduleConfig({
      ...validConfig,
      frequency: "monthly",
      scheduledDayOfMonth: 15,
    });
    expect(errors).toHaveLength(0);
  });
});

// ─── getFrequencyDescription Tests ──────────────────────────────────

describe("getFrequencyDescription", () => {
  it("describes daily schedule", () => {
    const desc = getFrequencyDescription("daily", "09:00");
    expect(desc).toBe("Every day at 09:00");
  });

  it("describes weekly schedule", () => {
    const desc = getFrequencyDescription("weekly", "14:30", 1);
    expect(desc).toBe("Every Monday at 14:30");
  });

  it("describes biweekly schedule", () => {
    const desc = getFrequencyDescription("biweekly", "08:00", 5);
    expect(desc).toBe("Every other Friday at 08:00");
  });

  it("describes monthly schedule", () => {
    const desc = getFrequencyDescription("monthly", "23:00", null, 15);
    expect(desc).toBe("Monthly on day 15 at 23:00");
  });
});

// ─── Email Report Generation Tests ──────────────────────────────────

describe("generateEmailReportContent", () => {
  const sampleReport: ReportData = {
    jobId: 42,
    jobName: "Daily POS vs Bank Settlement",
    sourceChannel: "POS Terminal",
    targetChannel: "Bank Statement",
    dateFrom: "2026-02-13",
    dateTo: "2026-02-14",
    totalSourceTxns: 500,
    totalTargetTxns: 480,
    matchedCount: 450,
    exceptionCount: 30,
    unmatchedCount: 50,
    matchRate: "91.84",
    processingTimeMs: 12500,
    matchBreakdown: {
      exact: 380,
      fuzzy: 50,
      tolerance: 20,
    },
    exceptionBreakdown: {
      amount_mismatch: 15,
      missing_counterparty: 10,
      duplicate_transaction: 5,
    },
    severityBreakdown: {
      critical: 2,
      high: 8,
      medium: 12,
      low: 8,
    },
    topExceptions: [
      {
        category: "amount_mismatch",
        severity: "critical",
        description: "Amount differs by NGN 50,000",
        transactionId: 101,
      },
      {
        category: "missing_counterparty",
        severity: "high",
        description: "No matching bank entry found",
        transactionId: 102,
      },
    ],
  };

  it("generates report with correct title", () => {
    const { title } = generateEmailReportContent(sampleReport);
    expect(title).toContain("ReconcileAI Report");
    expect(title).toContain("Daily POS vs Bank Settlement");
    expect(title).toContain("91.8%");
  });

  it("includes summary section with key metrics", () => {
    const { content } = generateEmailReportContent(sampleReport);
    expect(content).toContain("## Summary");
    expect(content).toContain("91.8%");
    expect(content).toContain("500");
    expect(content).toContain("480");
    expect(content).toContain("450");
    expect(content).toContain("30");
  });

  it("includes match breakdown when enabled", () => {
    const { content } = generateEmailReportContent(sampleReport, {
      includeMatchBreakdown: true,
    });
    expect(content).toContain("## Match Breakdown");
    expect(content).toContain("Exact");
    expect(content).toContain("380");
  });

  it("includes exception details when enabled", () => {
    const { content } = generateEmailReportContent(sampleReport, {
      includeExceptionDetails: true,
    });
    expect(content).toContain("## Exception Breakdown");
    expect(content).toContain("Amount Mismatch");
    expect(content).toContain("critical");
  });

  it("includes top exceptions", () => {
    const { content } = generateEmailReportContent(sampleReport);
    expect(content).toContain("High-Priority Exceptions");
    expect(content).toContain("Amount differs by NGN 50,000");
    expect(content).toContain("Txn #101");
  });

  it("includes recommended actions for critical exceptions", () => {
    const { content } = generateEmailReportContent(sampleReport);
    expect(content).toContain("## Recommended Actions");
    expect(content).toContain("critical exceptions require immediate attention");
  });

  it("includes job ID in footer", () => {
    const { content } = generateEmailReportContent(sampleReport);
    expect(content).toContain("Job ID: 42");
  });

  it("handles perfect reconciliation", () => {
    const perfectReport: ReportData = {
      ...sampleReport,
      matchRate: "100.00",
      exceptionCount: 0,
      unmatchedCount: 0,
      exceptionBreakdown: {},
      severityBreakdown: {},
      topExceptions: [],
    };
    const { content } = generateEmailReportContent(perfectReport);
    expect(content).toContain("completed successfully with no issues");
  });

  it("warns about low match rate", () => {
    const lowMatchReport: ReportData = {
      ...sampleReport,
      matchRate: "55.00",
    };
    const { content } = generateEmailReportContent(lowMatchReport);
    expect(content).toContain("below 70%");
  });

  it("warns about high unmatched percentage", () => {
    const highUnmatchedReport: ReportData = {
      ...sampleReport,
      unmatchedCount: 300,
      totalSourceTxns: 500,
      totalTargetTxns: 500,
    };
    const { content } = generateEmailReportContent(highUnmatchedReport);
    expect(content).toContain("20% of transactions are unmatched");
  });
});
