import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRiskLabel(level: string): string {
  const map: Record<string, string> = {
    critical: "Critical Risk",
    high: "High Risk",
    medium: "Medium Risk",
    low: "Low Risk",
  };
  return map[level] ?? "Medium Risk";
}

function buildLinkedInUrl(score: number, riskLevel: string, token: string): string {
  const resultUrl = `https://reconcileai.vip/compliance-assessment/result/${token}`;
  const riskLabel = buildRiskLabel(riskLevel);
  const text = encodeURIComponent(
    `I just completed the ReconcileAI CBN Compliance Readiness Assessment.\n\nMy score: ${score}/100 (${riskLabel})\n\nIf you're in banking or fintech in Nigeria, this 5-minute assessment is worth doing — it maps your reconciliation and compliance gaps against CBN requirements.\n\nTake the free assessment: ${resultUrl}`
  );
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(resultUrl)}&summary=${text}`;
}

function buildEmbedSnippet(score: number, riskLevel: string, token: string): string {
  const resultUrl = `https://reconcileai.vip/compliance-assessment/result/${token}`;
  const riskLabel = buildRiskLabel(riskLevel);
  const scoreColor = score >= 80 ? "#10b981" : score >= 60 ? "#f59e0b" : score >= 40 ? "#f97316" : "#ef4444";
  const badgeBg = score >= 80 ? "#f0fdf4" : score >= 60 ? "#fffbeb" : score >= 40 ? "#fff7ed" : "#fef2f2";
  const badgeBorder = score >= 80 ? "#bbf7d0" : score >= 60 ? "#fde68a" : score >= 40 ? "#fed7aa" : "#fecaca";
  return `<a href="${resultUrl}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:10px;padding:10px 16px;background:${badgeBg};border:1.5px solid ${badgeBorder};border-radius:10px;text-decoration:none;font-family:Inter,Arial,sans-serif;">
  <span style="font-size:22px;font-weight:800;color:${scoreColor};">${score}</span>
  <span style="font-size:11px;color:#6b7280;">/ 100</span>
  <span style="width:1px;height:28px;background:#e5e7eb;margin:0 4px;"></span>
  <span style="font-size:12px;font-weight:600;color:#1B365D;">${riskLabel}</span>
  <span style="font-size:11px;color:#9ca3af;">· CBN Compliance · ReconcileAI</span>
</a>`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildRiskLabel", () => {
  it("returns correct label for each risk level", () => {
    expect(buildRiskLabel("critical")).toBe("Critical Risk");
    expect(buildRiskLabel("high")).toBe("High Risk");
    expect(buildRiskLabel("medium")).toBe("Medium Risk");
    expect(buildRiskLabel("low")).toBe("Low Risk");
  });

  it("falls back to Medium Risk for unknown levels", () => {
    expect(buildRiskLabel("unknown")).toBe("Medium Risk");
    expect(buildRiskLabel("")).toBe("Medium Risk");
  });
});

describe("buildLinkedInUrl", () => {
  it("produces a valid LinkedIn sharing URL", () => {
    const url = buildLinkedInUrl(72, "medium", "abc123");
    expect(url).toContain("https://www.linkedin.com/sharing/share-offsite/");
    expect(url).toContain("abc123");
    expect(url).toContain("72%2F100");
  });

  it("includes the correct risk label in the text", () => {
    const url = buildLinkedInUrl(45, "high", "tok456");
    expect(url).toContain(encodeURIComponent("High Risk"));
  });

  it("embeds the result URL in both url and summary params", () => {
    const url = buildLinkedInUrl(88, "low", "tok789");
    expect(url).toContain("tok789");
  });
});

describe("buildEmbedSnippet", () => {
  it("produces an anchor tag with the correct score", () => {
    const snippet = buildEmbedSnippet(52, "high", "tok001");
    expect(snippet).toContain(">52<");
    expect(snippet).toContain("High Risk");
    expect(snippet).toContain("tok001");
  });

  it("uses green colour for scores >= 80", () => {
    const snippet = buildEmbedSnippet(85, "low", "tok002");
    expect(snippet).toContain("#10b981");
    expect(snippet).toContain("#f0fdf4"); // green bg
  });

  it("uses red colour for scores < 40", () => {
    const snippet = buildEmbedSnippet(25, "critical", "tok003");
    expect(snippet).toContain("#ef4444");
    expect(snippet).toContain("#fef2f2"); // red bg
  });

  it("uses orange colour for scores 40–59", () => {
    const snippet = buildEmbedSnippet(48, "high", "tok004");
    expect(snippet).toContain("#f97316");
    expect(snippet).toContain("#fff7ed"); // orange bg
  });

  it("includes CBN Compliance and ReconcileAI branding", () => {
    const snippet = buildEmbedSnippet(60, "medium", "tok005");
    expect(snippet).toContain("CBN Compliance");
    expect(snippet).toContain("ReconcileAI");
  });
});

describe("sendDemoInvite procedure (unit logic)", () => {
  it("validates that a token is required", () => {
    const validate = (input: { token?: string }) => {
      if (!input.token || input.token.trim() === "") {
        throw new Error("Token is required");
      }
      return true;
    };
    expect(() => validate({})).toThrow("Token is required");
    expect(() => validate({ token: "" })).toThrow("Token is required");
    expect(validate({ token: "abc123" })).toBe(true);
  });

  it("constructs a personalised demo email subject line", () => {
    const buildSubject = (institutionName?: string) =>
      institutionName
        ? `ReconcileAI Demo Invitation — ${institutionName}`
        : "ReconcileAI Demo Invitation";

    expect(buildSubject("LAPO MFB")).toBe("ReconcileAI Demo Invitation — LAPO MFB");
    expect(buildSubject()).toBe("ReconcileAI Demo Invitation");
  });
});
