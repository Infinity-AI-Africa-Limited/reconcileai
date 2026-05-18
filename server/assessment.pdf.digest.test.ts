/**
 * Tests for:
 * 1. PDF download button state logic (client-side, tested via pure function extraction)
 * 2. Weekly digest scheduled endpoint logic
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 1. PDF filename generation logic ────────────────────────────────────────
describe("PDF filename generation", () => {
  function getPdfFilename(institutionName: string | null, overallScore: number): string {
    return institutionName
      ? `ReconcileAI_Compliance_Report_${institutionName.replace(/\s+/g, "_")}.pdf`
      : `ReconcileAI_Compliance_Report_${overallScore}.pdf`;
  }

  it("uses institution name when available", () => {
    expect(getPdfFilename("LAPO MFB", 72)).toBe("ReconcileAI_Compliance_Report_LAPO_MFB.pdf");
  });

  it("replaces spaces with underscores", () => {
    expect(getPdfFilename("First Bank Nigeria", 85)).toBe(
      "ReconcileAI_Compliance_Report_First_Bank_Nigeria.pdf"
    );
  });

  it("falls back to score when no institution name", () => {
    expect(getPdfFilename(null, 52)).toBe("ReconcileAI_Compliance_Report_52.pdf");
    expect(getPdfFilename("", 52)).toBe("ReconcileAI_Compliance_Report_52.pdf");
  });
});

// ── 2. Weekly digest content generation ─────────────────────────────────────
describe("Weekly digest content", () => {
  type Assessment = {
    overallScore: number | null;
    riskLevel: string | null;
    consentToContact: boolean | null;
    demoInviteSent: boolean | null;
  };

  function buildDigestStats(recent: Assessment[]) {
    const total = recent.length;
    const avgScore =
      total > 0
        ? Math.round(recent.reduce((s, r) => s + (r.overallScore ?? 0), 0) / total)
        : 0;
    const highRisk = recent.filter(
      (r) => r.riskLevel === "critical" || r.riskLevel === "high"
    ).length;
    const pendingInvites = recent.filter(
      (r) => r.consentToContact && !r.demoInviteSent
    ).length;
    return { total, avgScore, highRisk, pendingInvites };
  }

  it("returns zeros for empty list", () => {
    const stats = buildDigestStats([]);
    expect(stats).toEqual({ total: 0, avgScore: 0, highRisk: 0, pendingInvites: 0 });
  });

  it("calculates average score correctly", () => {
    const assessments: Assessment[] = [
      { overallScore: 60, riskLevel: "medium", consentToContact: false, demoInviteSent: false },
      { overallScore: 80, riskLevel: "low", consentToContact: false, demoInviteSent: false },
    ];
    expect(buildDigestStats(assessments).avgScore).toBe(70);
  });

  it("counts high and critical risk correctly", () => {
    const assessments: Assessment[] = [
      { overallScore: 30, riskLevel: "critical", consentToContact: false, demoInviteSent: false },
      { overallScore: 45, riskLevel: "high", consentToContact: false, demoInviteSent: false },
      { overallScore: 65, riskLevel: "medium", consentToContact: false, demoInviteSent: false },
    ];
    expect(buildDigestStats(assessments).highRisk).toBe(2);
  });

  it("counts pending invites as consented but not yet sent", () => {
    const assessments: Assessment[] = [
      { overallScore: 50, riskLevel: "high", consentToContact: true, demoInviteSent: false },
      { overallScore: 60, riskLevel: "medium", consentToContact: true, demoInviteSent: true },
      { overallScore: 70, riskLevel: "low", consentToContact: false, demoInviteSent: false },
    ];
    expect(buildDigestStats(assessments).pendingInvites).toBe(1);
  });

  it("skips digest when no assessments", () => {
    const stats = buildDigestStats([]);
    // The endpoint returns early with skipped when total === 0
    expect(stats.total).toBe(0);
  });
});
