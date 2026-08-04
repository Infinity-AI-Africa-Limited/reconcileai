/**
 * Shared-secret auth for the scheduler endpoints.
 *
 * These routes are internet-facing and unauthenticated apart from one header,
 * and they trigger real work: the Woodcore mirror refresh, the SHOPLINE sync
 * cycle, the webhook reconciler. The behaviours pinned here are the ones whose
 * failure is silent — a comparison that leaks timing, and a refusal nobody can
 * diagnose.
 *
 * ENV is a frozen snapshot taken at import, so the secret must be set via
 * vi.hoisted; setting process.env in beforeEach is too late and every case
 * would pass for the wrong reason.
 */
import { describe, it, expect, vi } from "vitest";

const SECRET = vi.hoisted(() => {
  const s = "cron-secret-value-used-by-the-schedulers";
  process.env.CRON_SECRET = s;
  return s;
});

import { checkSyncSecret, expectedSyncSecret, describeSyncAuthFailure } from "./_core/syncAuth";

describe("checkSyncSecret", () => {
  it("accepts the exact secret", () => {
    expect(checkSyncSecret(SECRET)).toEqual({ ok: true });
  });

  it("rejects a wrong secret of the same length", () => {
    // Same length so the length check cannot be what rejects it — this is the
    // case that actually exercises the constant-time comparison.
    const wrong = "X".repeat(SECRET.length);
    expect(wrong).toHaveLength(SECRET.length);
    expect(checkSyncSecret(wrong)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a wrong secret of a different length without throwing", () => {
    // timingSafeEqual throws on differing lengths; the guard must come first or
    // a short header would 500 instead of 403.
    expect(() => checkSyncSecret("short")).not.toThrow();
    expect(checkSyncSecret("short")).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects a prefix of the real secret", () => {
    expect(checkSyncSecret(SECRET.slice(0, -1))).toEqual({ ok: false, reason: "mismatch" });
  });

  it("distinguishes a missing header from a wrong one", () => {
    // Same 403 to the caller, different line in the log — that distinction is
    // what makes a 5am failure diagnosable.
    expect(checkSyncSecret(undefined)).toEqual({ ok: false, reason: "missing_header" });
    expect(checkSyncSecret("")).toEqual({ ok: false, reason: "missing_header" });
    expect(checkSyncSecret(null)).toEqual({ ok: false, reason: "missing_header" });
  });

  it("resolves the secret from CRON_SECRET", () => {
    expect(expectedSyncSecret()).toBe(SECRET);
  });
});

describe("failure descriptions", () => {
  it("name a remedy and never echo the secret", () => {
    for (const reason of ["no_secret_configured", "missing_header", "mismatch"] as const) {
      const text = describeSyncAuthFailure(reason);
      expect(text.length).toBeGreaterThan(20);
      // The whole point of logging the reason is to avoid ever logging the value.
      expect(text).not.toContain(SECRET);
    }
  });

  it("points a mismatch at secret drift, the actual historical cause", () => {
    expect(describeSyncAuthFailure("mismatch")).toMatch(/drift|CRON_SECRET/i);
  });
});
