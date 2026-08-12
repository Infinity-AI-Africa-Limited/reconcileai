/**
 * Banking-model eligibility and narrowing.
 *
 * Extracted from SuperAdminDashboard, which computed `org.segment ===
 * "financial_services"` inline. A rule embedded in one rendering site drifts the
 * moment a second consumer needs it — the distributor registry was scoped one
 * way on the client and another on the server for exactly that reason.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BANKING_MODELS,
  bankingModelAppliesTo,
  bankingModelLabel,
  toBankingModel,
} from "./bankingModel";

describe("when deciding whether an institution has a banking model", () => {
  it("should offer it to financial services", () => {
    expect(bankingModelAppliesTo("financial_services")).toBe(true);
  });

  it("should withhold it from verticals with no banking licence", () => {
    // A merchant or an FMCG supplier has none, so offering the choice would
    // invite them to assert one.
    expect(bankingModelAppliesTo("retail_commerce")).toBe(false);
    expect(bankingModelAppliesTo("corporate_b2b")).toBe(false);
    expect(bankingModelAppliesTo("super_admin")).toBe(false);
  });

  it("should withhold it while the segment is still resolving", () => {
    // A positive match, so the control stays hidden for that frame rather than
    // flickering in — the same reasoning as the segment checks it delegates to.
    expect(bankingModelAppliesTo(null)).toBe(false);
  });
});

describe("when narrowing a stored banking model", () => {
  it("should recognise the two known values", () => {
    expect(toBankingModel("non_interest")).toBe("non_interest");
    expect(toBankingModel("conventional")).toBe("conventional");
  });

  it("should treat anything unrecognised as conventional", () => {
    // Must stay aligned with isNonInterestInstitution on the server. Non-interest
    // is a positive claim about a licence basis; defaulting to it on an unknown
    // value would misstate that claim in the operator's own console.
    expect(toBankingModel(null)).toBe("conventional");
    expect(toBankingModel(undefined)).toBe("conventional");
    expect(toBankingModel("")).toBe("conventional");
    expect(toBankingModel("islamic")).toBe("conventional");
    expect(toBankingModel("NON_INTEREST")).toBe("conventional");
  });

  it("should label both models for a human", () => {
    expect(bankingModelLabel("non_interest")).toBe("Non-interest (NIFI)");
    expect(bankingModelLabel("conventional")).toBe("Conventional");
    for (const m of BANKING_MODELS) expect(bankingModelLabel(m).length).toBeGreaterThan(0);
  });
});

describe("the page consumes the rule rather than restating it", () => {
  // A rule module the page ignores is decoration — the same assertion
  // routeAccess.test.ts makes about App.tsx wiring SegmentGuard.
  const PAGE = fs.readFileSync(
    path.join(__dirname, "..", "pages", "SuperAdminDashboard.tsx"),
    "utf8",
  );

  it("should call bankingModelAppliesTo", () => {
    expect(PAGE).toMatch(/bankingModelAppliesTo\(toSegment\(org\.segment\)\)/);
  });

  it("should not re-derive eligibility from the segment string", () => {
    expect(PAGE).not.toMatch(/org\.segment === "financial_services"/);
  });

  it("should render the options from BANKING_MODELS", () => {
    // Hardcoded <SelectItem>s would silently omit a third model.
    expect(PAGE).toMatch(/BANKING_MODELS\.map/);
  });

  it("should narrow both the stored value and the selected one", () => {
    expect(PAGE).toMatch(/value=\{toBankingModel\(org\.bankingModel\)\}/);
    expect(PAGE).toMatch(/bankingModel: toBankingModel\(v\)/);
  });
});
