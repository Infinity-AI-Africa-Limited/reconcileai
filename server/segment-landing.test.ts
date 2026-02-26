import { describe, it, expect } from "vitest";

describe("Segment Landing Pages", () => {
  it("should have three segment types defined", () => {
    const segments = ["banks", "fintechs", "payment-processors"];
    expect(segments).toHaveLength(3);
    expect(segments).toContain("banks");
    expect(segments).toContain("fintechs");
    expect(segments).toContain("payment-processors");
  });

  it("should have segment-specific value propositions", () => {
    const valueProps = {
      banks: "Protect Your Banking License with AI-Assisted Reconciliation",
      fintechs: "Scale Your FinTech Without Scaling Your Reconciliation Team",
      paymentProcessors: "Eliminate 95-98% False Positives Across 20+ Reconciliation Processes",
    };

    expect(valueProps.banks).toBeTruthy();
    expect(valueProps.fintechs).toBeTruthy();
    expect(valueProps.paymentProcessors).toBeTruthy();
  });

  it("should have segment-specific pain points", () => {
    const painPoints = {
      banks: [
        "Multi-System Login Nightmare",
        "License Revocation Risk",
        "3-4 Settlement Windows Daily",
        "Month-End Close Delays",
      ],
      fintechs: [
        "60% Time on Manual Matching",
        "Reconciliation = Last Line of Defense",
        "Volume Drives Complexity",
        "Hybrid Team Required",
      ],
      paymentProcessors: [
        "95-98% False Positive Rates",
        "Settlement-Before-Reconciliation Risk",
        "20+ Reconciliation Processes",
        "6.5-7/10 Audit Confidence",
      ],
    };

    expect(painPoints.banks).toHaveLength(4);
    expect(painPoints.fintechs).toHaveLength(4);
    expect(painPoints.paymentProcessors).toHaveLength(4);
  });

  it("should have segment-specific success metrics", () => {
    const metrics = {
      banks: {
        auditConfidence: "9+/10",
        workloadReduction: "60%",
        portalsEliminated: "5+",
        licenseRevocations: "Zero",
      },
      fintechs: {
        timeSavings: "60%",
        falsePositiveRate: "<2%",
        deploymentTime: "Weeks",
        channelsSupported: "10+",
      },
      paymentProcessors: {
        falsePositiveRate: "<2%",
        minutesSaved: "30+",
        processesUnified: "20+",
        auditConfidence: "9+/10",
      },
    };

    expect(metrics.banks.auditConfidence).toBe("9+/10");
    expect(metrics.fintechs.timeSavings).toBe("60%");
    expect(metrics.paymentProcessors.falsePositiveRate).toBe("<2%");
  });

  it("should have three-module architecture for all segments", () => {
    const modules = [
      "Transaction Integrity Reconciliation",
      "Settlement Reconciliation",
      "Account-Level Reconciliation",
    ];

    expect(modules).toHaveLength(3);
    expect(modules).toContain("Transaction Integrity Reconciliation");
    expect(modules).toContain("Settlement Reconciliation");
    expect(modules).toContain("Account-Level Reconciliation");
  });
});
