import { describe, expect, it } from "vitest";
import {
  canEnterPortal,
  portalHandoffMessage,
  shoplinePortalHandoff,
  type PortalHandoffInput,
} from "./shoplinePortalHandoff";

const RETAIL_ORG = { id: 60001, name: "ReconcileAI Dev Store", code: "SL_RECONCILEAI_DEV", segment: "retail_commerce" as const };

function input(over: Partial<PortalHandoffInput> = {}): PortalHandoffInput {
  return {
    isSuperAdmin: true,
    orgCode: "SL_RECONCILEAI_DEV",
    isLoading: false,
    isError: false,
    retailOrg: RETAIL_ORG,
    ...over,
  };
}

describe("when the visitor is not a support session", () => {
  it("should not involve a portal at all for a merchant", () => {
    expect(shoplinePortalHandoff(input({ isSuperAdmin: false }))).toEqual({ status: "not_required" });
  });

  it("should not involve a portal when the redirect carries no organisation code", () => {
    expect(shoplinePortalHandoff(input({ orgCode: "" }))).toEqual({ status: "not_required" });
  });

  it("should let both cases navigate normally", () => {
    expect(canEnterPortal(shoplinePortalHandoff(input({ isSuperAdmin: false })))).toBe(true);
    expect(canEnterPortal(shoplinePortalHandoff(input({ orgCode: "" })))).toBe(true);
  });
});

describe("when a super admin returns from a test install", () => {
  it("should be ready once the retail organisation resolves", () => {
    expect(shoplinePortalHandoff(input())).toEqual({ status: "ready" });
    expect(canEnterPortal(shoplinePortalHandoff(input()))).toBe(true);
  });

  it("should hold navigation while the lookup is in flight", () => {
    const handoff = shoplinePortalHandoff(input({ isLoading: true, retailOrg: undefined }));
    expect(handoff).toEqual({ status: "resolving" });
    expect(canEnterPortal(handoff)).toBe(false);
    // Nothing is wrong yet, so nothing is said.
    expect(portalHandoffMessage(handoff)).toBeNull();
  });
});

describe("when the portal context cannot be established", () => {
  it("should refuse navigation when no retail organisation matches the code", () => {
    const handoff = shoplinePortalHandoff(input({ retailOrg: undefined }));
    expect(handoff).toEqual({ status: "blocked", reason: "not_retail" });
    expect(canEnterPortal(handoff)).toBe(false);
  });

  it("should report a failed lookup as an outage, not as a missing store", () => {
    // An errored query also reports not-loading with no data. Collapsing the two
    // tells an operator their store is not connected when the truth is that we
    // could not ask — different problem, different next step.
    const handoff = shoplinePortalHandoff(input({ isError: true, retailOrg: undefined }));
    expect(handoff).toEqual({ status: "blocked", reason: "lookup_failed" });
    expect(portalHandoffMessage(handoff)).toMatch(/transient/i);
    expect(portalHandoffMessage(handoff)).not.toMatch(/no connected retail store/i);
  });

  it("should prefer the error reason even if stale data is still cached", () => {
    // react-query keeps the previous data on a background refetch failure, so
    // `retailOrg` can be populated while `isError` is true. Acting on the stale
    // value would enter a portal on the strength of an answer we know failed.
    const handoff = shoplinePortalHandoff(input({ isError: true }));
    expect(handoff).toEqual({ status: "blocked", reason: "lookup_failed" });
  });

  it("should always produce a message the screen can render", () => {
    // This is the regression that matters. The original guard set its message
    // from the click handler while the same condition disabled the button, so a
    // truth table over its own predicates had ZERO states in which the message
    // could appear: two dead buttons and no reason given.
    for (const handoff of [
      shoplinePortalHandoff(input({ retailOrg: undefined })),
      shoplinePortalHandoff(input({ isError: true, retailOrg: undefined })),
    ]) {
      expect(canEnterPortal(handoff)).toBe(false);
      expect(portalHandoffMessage(handoff)).toBeTruthy();
    }
  });
});

describe("message discipline", () => {
  it("should say nothing when there is nothing wrong", () => {
    expect(portalHandoffMessage(shoplinePortalHandoff(input()))).toBeNull();
    expect(portalHandoffMessage(shoplinePortalHandoff(input({ isSuperAdmin: false })))).toBeNull();
  });

  it("should never leave a blocked state without an explanation", () => {
    const blocked = [
      shoplinePortalHandoff(input({ retailOrg: undefined })),
      shoplinePortalHandoff(input({ isError: true })),
    ];
    for (const handoff of blocked) expect(portalHandoffMessage(handoff)?.length).toBeGreaterThan(20);
  });
});
