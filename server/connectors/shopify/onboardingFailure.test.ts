/**
 * How an onboarding refusal reaches the merchant, on both installation surfaces.
 *
 * App Home had no mapping for `ShopifyOnboardingError` at all: every refusal
 * became "service_unavailable", i.e. "temporarily unavailable, try again". For
 * a shop with no contact email, or one whose contact email belongs to another
 * workspace, no retry can ever succeed — and each retry re-runs the token
 * exchange, retiring the offline token pair the previous attempt was issued.
 * These tests pin that the two surfaces now classify from the same function and
 * that a terminal refusal never reads as a transient one.
 */
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});

import type { ShopifyInstallErrorReason } from "@shared/shopifyInstall";
import { managedInstallFailure } from "./appHome";
import { ShopifyOnboardingError, type ShopifyOnboardingErrorCode } from "./onboarding";
import { onboardingFailureIsTerminal, onboardingFailureReason } from "./onboardingFailure";

const refusal = (code: ShopifyOnboardingErrorCode) => new ShopifyOnboardingError("static text", code);

describe("when an onboarding refusal is classified", () => {
  it.each<[ShopifyOnboardingErrorCode, ShopifyInstallErrorReason]>([
    ["OWNERSHIP_UNVERIFIED", "ownership_verification_required"],
    ["EMAIL_CONFLICT", "email_already_registered"],
    ["REDACTION_IN_PROGRESS", "redaction_in_progress"],
    ["MISSING_CONTACT_EMAIL", "missing_contact_email"],
    ["SHOP_IDENTITY_CONFLICT", "store_identity_conflict"],
    ["WORKSPACE_CONFLICT", "store_identity_conflict"],
    ["INSTALL_LEASE_LOST", "installation_in_progress"],
    ["TOKEN_STORE_FAILED", "install_failed"],
    ["DB_UNAVAILABLE", "install_failed"],
  ])("should read %s as %s", (code, expected) => {
    expect(onboardingFailureReason(refusal(code))).toBe(expected);
  });

  it("should report anything that is not an onboarding refusal as a generic install failure", () => {
    expect(onboardingFailureReason(new Error("fetch failed"))).toBe("install_failed");
    expect(onboardingFailureReason("thrown string")).toBe("install_failed");
  });

  it("should treat only a transient refusal and a lost lease as worth retrying", () => {
    expect(onboardingFailureIsTerminal("install_failed")).toBe(false);
    expect(onboardingFailureIsTerminal("installation_in_progress")).toBe(false);
    for (const terminal of [
      "ownership_verification_required",
      "email_already_registered",
      "redaction_in_progress",
      "missing_contact_email",
      "store_identity_conflict",
    ] as const) {
      expect(onboardingFailureIsTerminal(terminal)).toBe(true);
    }
  });
});

describe("when App Home renders an onboarding refusal", () => {
  it.each<[ShopifyOnboardingErrorCode, string, string]>([
    ["MISSING_CONTACT_EMAIL", "PRECONDITION_FAILED", "missing_contact_email"],
    ["OWNERSHIP_UNVERIFIED", "PRECONDITION_FAILED", "ownership_verification_required"],
    ["EMAIL_CONFLICT", "CONFLICT", "email_already_registered"],
    ["REDACTION_IN_PROGRESS", "CONFLICT", "redaction_in_progress"],
    ["SHOP_IDENTITY_CONFLICT", "CONFLICT", "store_identity_conflict"],
    ["WORKSPACE_CONFLICT", "CONFLICT", "store_identity_conflict"],
    ["INSTALL_LEASE_LOST", "CONFLICT", "installation_in_progress"],
  ])("should answer %s with %s and the actionable message %s", (code, trpcCode, message) => {
    const error = managedInstallFailure(refusal(code));
    expect(error.code).toBe(trpcCode);
    expect(error.message).toBe(message);
  });

  it.each<ShopifyOnboardingErrorCode>(["DB_UNAVAILABLE", "TOKEN_STORE_FAILED"])(
    "should keep %s retryable, because it really is transient",
    (code) => {
      const error = managedInstallFailure(refusal(code));
      expect(error.code).toBe("SERVICE_UNAVAILABLE");
      expect(error.message).toBe("service_unavailable");
    },
  );

  it("should never tell a merchant to retry a refusal that a retry cannot clear", () => {
    // The whole point: a retry re-runs the token exchange and still fails.
    const terminal: ShopifyOnboardingErrorCode[] = [
      "MISSING_CONTACT_EMAIL",
      "OWNERSHIP_UNVERIFIED",
      "EMAIL_CONFLICT",
      "REDACTION_IN_PROGRESS",
      "SHOP_IDENTITY_CONFLICT",
      "WORKSPACE_CONFLICT",
    ];
    for (const code of terminal) {
      expect(managedInstallFailure(refusal(code)).message).not.toBe("service_unavailable");
    }
  });

  it("should still carry no provider text or operational detail", () => {
    const error = managedInstallFailure(
      new ShopifyOnboardingError("Shopify did not return a usable shop contact email", "MISSING_CONTACT_EMAIL"),
    );
    expect(error.message).toBe("missing_contact_email");
    expect(error.message).not.toMatch(/Shopify|email address|@/);
  });
});
