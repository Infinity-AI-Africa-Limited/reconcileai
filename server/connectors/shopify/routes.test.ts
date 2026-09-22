import { describe, expect, it } from "vitest";
import { callbackReasonFor } from "./routes";
import { ShopifyOnboardingError, type ShopifyOnboardingErrorCode } from "./onboarding";

/**
 * Every onboarding refusal maps to a reason the error page can explain. A
 * refusal that collapses to "install_failed" tells a merchant whose store was
 * protected from a cross-tenant attachment only that something broke.
 */
describe("callbackReasonFor", () => {
  it.each<[ShopifyOnboardingErrorCode, string]>([
    ["OWNERSHIP_UNVERIFIED", "ownership_verification_required"],
    ["EMAIL_CONFLICT", "email_already_registered"],
    ["MISSING_CONTACT_EMAIL", "missing_contact_email"],
    ["SHOP_IDENTITY_CONFLICT", "store_identity_conflict"],
    ["WORKSPACE_CONFLICT", "store_identity_conflict"],
    ["TOKEN_STORE_FAILED", "install_failed"],
    ["DB_UNAVAILABLE", "install_failed"],
  ])("should map %s to %s", (code, reason) => {
    expect(callbackReasonFor(new ShopifyOnboardingError("x", code))).toBe(reason);
  });

  it("should report anything else as a generic install failure", () => {
    expect(callbackReasonFor(new Error("fetch failed"))).toBe("install_failed");
    expect(callbackReasonFor("thrown string")).toBe("install_failed");
  });
});
