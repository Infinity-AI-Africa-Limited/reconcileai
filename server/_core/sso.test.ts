/**
 * SSO pure-helper tests: PKCE generation, authorize-URL construction, and the
 * security-critical ID-token claim validation (audience, nonce, issuer shape,
 * verified email) for both Google and Entra ID.
 *
 * The network legs (code exchange, JWKS signature verification) are exercised
 * end-to-end in integration; here we lock down the logic that decides whether a
 * token is trusted, since that is where auth bypasses hide.
 */
import crypto from "crypto";
import { describe, expect, it } from "vitest";
import {
  b64url,
  buildAuthorizeUrl,
  generatePkcePair,
  orgAllowsSso,
  validateIdentityClaims,
} from "./sso";

describe("orgAllowsSso — email is the default, SSO is per-client opt-in", () => {
  it("default ('none' / null / legacy empty) allows NO SSO provider", () => {
    expect(orgAllowsSso("none", "google")).toBe(false);
    expect(orgAllowsSso("none", "microsoft")).toBe(false);
    expect(orgAllowsSso(null, "google")).toBe(false);
    expect(orgAllowsSso(undefined, "microsoft")).toBe(false);
  });

  it("a client that requested Google gets Google only", () => {
    expect(orgAllowsSso("google", "google")).toBe(true);
    expect(orgAllowsSso("google", "microsoft")).toBe(false);
  });

  it("a client that requested Microsoft gets Microsoft only", () => {
    expect(orgAllowsSso("microsoft", "microsoft")).toBe(true);
    expect(orgAllowsSso("microsoft", "google")).toBe(false);
  });

  it("'both' enables the pair; casing is tolerated", () => {
    expect(orgAllowsSso("both", "google")).toBe(true);
    expect(orgAllowsSso("both", "microsoft")).toBe(true);
    expect(orgAllowsSso("Google", "google")).toBe(true);
  });
});

describe("PKCE", () => {
  it("verifier is base64url (no +/=), challenge is its S256 hash", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = b64url(crypto.createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it("verifier length satisfies RFC 7636 (43–128 chars)", () => {
    const { verifier } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it("is unique per call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  const def = {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    clientId: "client-123",
    scope: "openid email profile",
  };

  it("includes PKCE S256, state, nonce and response_type=code", () => {
    const url = new URL(
      buildAuthorizeUrl(def, {
        redirectUri: "https://app.example/api/oauth/google/callback",
        state: "st",
        nonce: "no",
        codeChallenge: "chal",
      }),
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("nonce")).toBe("no");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example/api/oauth/google/callback",
    );
  });
});

describe("validateIdentityClaims — Google", () => {
  const def = {
    id: "google" as const,
    clientId: "gclient",
    issuer: { exact: "https://accounts.google.com" },
  };
  const good = {
    aud: "gclient",
    iss: "https://accounts.google.com",
    nonce: "N1",
    email: "Ada@Bank.NG",
    email_verified: true,
    name: "Ada Okafor",
  };

  it("accepts a well-formed token and lowercases the email", () => {
    const r = validateIdentityClaims(def, good, "N1");
    expect(r.ok).toBe(true);
    expect(r.email).toBe("ada@bank.ng");
    expect(r.name).toBe("Ada Okafor");
  });

  it("rejects an unverified email", () => {
    const r = validateIdentityClaims(def, { ...good, email_verified: false }, "N1");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not verified/);
  });

  it("rejects audience mismatch (token minted for another app)", () => {
    const r = validateIdentityClaims(def, { ...good, aud: "someone-else" }, "N1");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/audience/);
  });

  it("rejects nonce mismatch (replay / injected token)", () => {
    const r = validateIdentityClaims(def, good, "DIFFERENT");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/nonce/);
  });

  it("rejects a spoofed issuer", () => {
    const r = validateIdentityClaims(def, { ...good, iss: "https://evil.example" }, "N1");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/issuer/);
  });

  it("accepts aud as an array containing the client id", () => {
    const r = validateIdentityClaims(def, { ...good, aud: ["other", "gclient"] }, "N1");
    expect(r.ok).toBe(true);
  });
});

describe("validateIdentityClaims — Microsoft Entra (multi-tenant)", () => {
  // "common" issuer embeds the user's tenant id, so only prefix/suffix are fixed.
  const def = {
    id: "microsoft" as const,
    clientId: "mclient",
    issuer: { prefix: "https://login.microsoftonline.com/", suffix: "/v2.0" },
  };
  const good = {
    aud: "mclient",
    iss: "https://login.microsoftonline.com/9188040d-tenant-guid/v2.0",
    nonce: "N2",
    preferred_username: "ops@commercialbank.com",
    name: "Bank Ops",
  };

  it("accepts a per-tenant issuer matching the prefix/suffix", () => {
    const r = validateIdentityClaims(def, good, "N2");
    expect(r.ok).toBe(true);
    expect(r.email).toBe("ops@commercialbank.com");
  });

  it("falls back to preferred_username when there is no email claim", () => {
    const r = validateIdentityClaims(def, good, "N2");
    expect(r.ok).toBe(true);
    expect(r.email).toBe("ops@commercialbank.com");
  });

  it("prefers a real email claim over preferred_username", () => {
    const r = validateIdentityClaims(def, { ...good, email: "real@bank.com" }, "N2");
    expect(r.ok).toBe(true);
    expect(r.email).toBe("real@bank.com");
  });

  it("rejects an issuer from the wrong host even with the right suffix", () => {
    const r = validateIdentityClaims(
      def,
      { ...good, iss: "https://evil.example/tenant/v2.0" },
      "N2",
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/issuer/);
  });

  it("rejects a token whose username is not an email and has no email claim", () => {
    const r = validateIdentityClaims(def, { ...good, preferred_username: "DOMAIN\\user" }, "N2");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/email/);
  });
});
