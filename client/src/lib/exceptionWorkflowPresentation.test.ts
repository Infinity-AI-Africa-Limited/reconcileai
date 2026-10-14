import { describe, expect, it } from "vitest";
import {
  exceptionWorkflowStatusLabel,
  isExceptionWorkflowReadyToClose,
} from "./exceptionWorkflowPresentation";

describe("governed exception closure presentation", () => {
  it("keeps approval-required workflows closed until a separate approval is recorded", () => {
    expect(
      isExceptionWorkflowReadyToClose({
        approvalRequired: true,
        status: "active",
      })
    ).toBe(false);
    expect(
      isExceptionWorkflowReadyToClose({
        approvalRequired: true,
        status: "decision_submitted",
      })
    ).toBe(false);
    expect(
      isExceptionWorkflowReadyToClose({
        approvalRequired: true,
        status: "approved",
      })
    ).toBe(true);
  });

  it("allows a no-approval workflow only after its decision is recorded", () => {
    expect(
      isExceptionWorkflowReadyToClose({
        approvalRequired: false,
        status: "escalated",
      })
    ).toBe(false);
    expect(
      isExceptionWorkflowReadyToClose({
        approvalRequired: false,
        status: "decision_recorded",
      })
    ).toBe(true);
  });

  it("uses readable status labels without translating lifecycle meaning", () => {
    expect(exceptionWorkflowStatusLabel("decision_submitted")).toBe(
      "decision submitted"
    );
  });
});
