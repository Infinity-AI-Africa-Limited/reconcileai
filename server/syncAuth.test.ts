/**
 * Shared-secret auth for the scheduler endpoints.
 *
 * These routes are internet-facing and unauthenticated apart from one header,
 * and they trigger real work: the Woodcore mirror refresh, the SHOPLINE sync
 * cycle, the webhook reconciler.
 *
 * Note there is NO environment manipulation here. `checkSyncSecret` takes the
 * expected secret as an argument, so these tests are a pure function of their
 * inputs. Mutating process.env before import (the earlier approach) leaks into
 * every other test in the run, and `vi.stubEnv` would not have worked either —
 * ENV is a frozen snapshot taken at import time, so stubbing afterwards changes
 * nothing. Injecting the value removes the problem rather than scoping it.
 */
import { describe, it, expect } from "vitest";
import { checkSyncSecret, describeSyncAuthFailure } from "./_core/syncAuth";

const SECRET = "cron-secret-value-used-by-the-schedulers";

describe("checkSyncSecret", () => {
  describe("when the caller presents the exact secret", () => {
    it("should authorise the request", () => {
      expect(checkSyncSecret(SECRET, SECRET)).toEqual({ ok: true });
    });
  });

  describe("when the caller presents a wrong secret of the same length", () => {
    it("should refuse it as a mismatch", () => {
      // Same length so the length guard cannot be what rejects it — this is the
      // case that actually exercises the constant-time comparison.
      const wrong = "X".repeat(SECRET.length);
      expect(wrong).toHaveLength(SECRET.length);
      expect(checkSyncSecret(wrong, SECRET)).toEqual({ ok: false, reason: "mismatch" });
    });
  });

  describe("when the caller presents a secret of a different length", () => {
    it("should refuse it without throwing", () => {
      // timingSafeEqual throws on differing lengths, so the length guard must
      // come first — otherwise a short header would 500 instead of 403.
      expect(() => checkSyncSecret("short", SECRET)).not.toThrow();
      expect(checkSyncSecret("short", SECRET)).toEqual({ ok: false, reason: "mismatch" });
    });
  });

  describe("when the caller presents a prefix of the real secret", () => {
    it("should refuse it", () => {
      expect(checkSyncSecret(SECRET.slice(0, -1), SECRET)).toEqual({
        ok: false,
        reason: "mismatch",
      });
    });
  });

  describe("when the request carries no secret header", () => {
    it("should distinguish a missing header from a wrong one", () => {
      // Same 403 to the caller either way; different line in the log. That
      // distinction is what makes a 5am failure diagnosable.
      for (const missing of [undefined, "", null]) {
        expect(checkSyncSecret(missing, SECRET)).toEqual({
          ok: false,
          reason: "missing_header",
        });
      }
    });
  });

  describe("when the server has no secret configured at all", () => {
    it("should fail closed rather than accepting anything", () => {
      expect(checkSyncSecret("anything", "")).toEqual({
        ok: false,
        reason: "no_secret_configured",
      });
      // Including when the caller also sends nothing — an unset secret must
      // never make an empty header "match".
      expect(checkSyncSecret("", "")).toEqual({ ok: false, reason: "no_secret_configured" });
    });
  });
});

describe("describeSyncAuthFailure", () => {
  describe("for every failure reason", () => {
    it("should name a remedy without echoing the secret", () => {
      for (const reason of ["no_secret_configured", "missing_header", "mismatch"] as const) {
        const text = describeSyncAuthFailure(reason);
        expect(text.length).toBeGreaterThan(20);
        // The point of logging a reason is to avoid ever logging the value.
        expect(text).not.toContain(SECRET);
      }
    });
  });

  describe("for a mismatch", () => {
    it("should point at secret drift, the actual historical cause", () => {
      expect(describeSyncAuthFailure("mismatch")).toMatch(/drift|CRON_SECRET/i);
    });
  });
});
