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
import { checkSyncSecret, describeSyncAuthFailure, authorizeSyncRequest } from "./_core/syncAuth";

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

describe("authorizeSyncRequest", () => {
  const oidcOk = async () => ({ ok: true as const, repository: "Infinity-AI-Africa-Limited/reconcileai" });
  const oidcNo = async () => ({ ok: false as const, reason: "untrusted_repository", detail: "someone/else" });

  describe("when a valid OIDC token is presented", () => {
    it("should authorise via github_oidc without needing a secret at all", async () => {
      // The point of the change: no long-lived value is involved, so there is
      // nothing to copy between dashboards and nothing to drift.
      const result = await authorizeSyncRequest(
        { bearerToken: "jwt", secretHeader: null },
        { expectedSecret: SECRET, verifyOidc: oidcOk },
      );
      expect(result).toMatchObject({ ok: true, via: "github_oidc" });
    });

    it("should prefer OIDC even when a valid secret is also sent", async () => {
      // True during the transition, when workflows send both. The log line is
      // what tells us OIDC is actually carrying the traffic and the GitHub
      // secrets can safely be deleted.
      const result = await authorizeSyncRequest(
        { bearerToken: "jwt", secretHeader: SECRET },
        { expectedSecret: SECRET, verifyOidc: oidcOk },
      );
      expect(result).toMatchObject({ ok: true, via: "github_oidc" });
    });
  });

  describe("when OIDC cannot be used", () => {
    it("should fall back to the shared secret", async () => {
      // On-premise blocks the egress OIDC verification needs, and Railway Cron
      // cannot mint a token at all. Removing this path would strand both.
      const result = await authorizeSyncRequest(
        { bearerToken: null, secretHeader: SECRET },
        { expectedSecret: SECRET, verifyOidc: oidcNo },
      );
      expect(result).toMatchObject({ ok: true, via: "shared_secret" });
    });

    it("should not attempt OIDC when no bearer token was sent", async () => {
      // A secret-only caller should not pay for a JWKS lookup, nor log an OIDC
      // failure that means nothing.
      let called = false;
      await authorizeSyncRequest(
        { bearerToken: null, secretHeader: SECRET },
        {
          expectedSecret: SECRET,
          verifyOidc: async () => {
            called = true;
            return { ok: false as const, reason: "malformed" };
          },
        },
      );
      expect(called).toBe(false);
    });

    it("should still accept a valid secret when the OIDC token is rejected", async () => {
      const result = await authorizeSyncRequest(
        { bearerToken: "forged", secretHeader: SECRET },
        { expectedSecret: SECRET, verifyOidc: oidcNo },
      );
      expect(result).toMatchObject({ ok: true, via: "shared_secret" });
    });
  });

  describe("when neither path holds up", () => {
    it("should refuse, and carry why OIDC declined into the log", async () => {
      const result = await authorizeSyncRequest(
        { bearerToken: "forged", secretHeader: "wrong-secret-value-here" },
        { expectedSecret: SECRET, verifyOidc: oidcNo },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.reason).toBe("mismatch");
      expect(result.oidcDetail).toContain("untrusted_repository");
    });

    it("should refuse a forged OIDC token presented with no secret", async () => {
      const result = await authorizeSyncRequest(
        { bearerToken: "forged", secretHeader: null },
        { expectedSecret: SECRET, verifyOidc: oidcNo },
      );
      expect(result.ok).toBe(false);
    });
  });
});
