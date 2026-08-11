/**
 * GitHub Actions OIDC verification.
 *
 * These sign real tokens with a locally generated key pair and verify them
 * through the real `jwtVerify` path. A stubbed verifier that returned "valid"
 * would prove nothing about the only thing that matters here — that a correctly
 * signed token from the WRONG repository is refused.
 *
 * That case is not hypothetical. Anyone with a public GitHub repo can mint an
 * OIDC token and choose any `aud` they like. Signature, issuer and audience
 * together establish that GitHub issued it, not that WE asked for it. Without
 * the repository check, every one of these endpoints would be open to any
 * GitHub user on earth — a worse position than the shared secret it replaces.
 */
import { describe, it, expect } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import {
  verifyGitHubOidcToken,
  describeOidcFailure,
  GITHUB_OIDC_ISSUER,
  type OidcPolicy,
} from "./_core/githubOidc";

const AUDIENCE = "https://www.reconcileaiafrica.com";
const OURS = "Infinity-AI-Africa-Limited/reconcileai";

const POLICY: OidcPolicy = {
  audience: AUDIENCE,
  allowedRepositories: [OURS],
};

/** A signing key plus the JWKS a verifier would fetch for it. */
async function keyring() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const jwks = createLocalJWKSet({ keys: [jwk] }) as JWTVerifyGetKey;
  return { privateKey, jwks };
}

async function mint(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expSeconds?: number } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(opts.issuer ?? GITHUB_OIDC_ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.expSeconds !== undefined ? `${opts.expSeconds}s` : "5m")
    .sign(privateKey);
}

describe("when the token comes from the repository we trust", () => {
  it("should authorise it", async () => {
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, {
      repository: OURS,
      workflow: "Woodcore mirror sync",
      ref: "refs/heads/main",
    });
    const result = await verifyGitHubOidcToken(token, POLICY, jwks);
    expect(result).toMatchObject({
      ok: true,
      repository: OURS,
      workflow: "Woodcore mirror sync",
      ref: "refs/heads/main",
    });
  });
});

describe("when the token is genuine but belongs to someone else", () => {
  it("should refuse a correctly signed token from another repository", async () => {
    // THE test. Everything else about this token is valid — GitHub's issuer, our
    // audience, an unexpired signature from the real key. Only the repository
    // differs, and that is the sole thing standing between these endpoints and
    // any GitHub account in the world.
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: "some-attacker/evil", ref: "refs/heads/main" });
    const result = await verifyGitHubOidcToken(token, POLICY, jwks);
    expect(result).toMatchObject({ ok: false, reason: "untrusted_repository" });
  });

  it("should refuse a token carrying no repository claim at all", async () => {
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { ref: "refs/heads/main" });
    const result = await verifyGitHubOidcToken(token, POLICY, jwks);
    expect(result).toMatchObject({ ok: false, reason: "untrusted_repository" });
  });

  it("should name the offending repository in the log line", async () => {
    // Safe to log — it is the caller's own identity — and it is the single most
    // useful fact if this ever fires in production.
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: "some-attacker/evil" });
    const result = await verifyGitHubOidcToken(token, POLICY, jwks);
    if (result.ok) throw new Error("expected refusal");
    expect(describeOidcFailure(result.reason, result.detail)).toContain("some-attacker/evil");
  });
});

describe("when the token fails basic verification", () => {
  it("should refuse a token signed by a different key", async () => {
    const signer = await keyring();
    const verifier = await keyring(); // different key pair entirely
    const token = await mint(signer.privateKey, { repository: OURS });
    const result = await verifyGitHubOidcToken(token, POLICY, verifier.jwks);
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("should refuse a token minted for a different audience", async () => {
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: OURS }, { audience: "https://someone-else.example" });
    expect(await verifyGitHubOidcToken(token, POLICY, jwks)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("should refuse a token from a different issuer", async () => {
    // A self-hosted issuer impersonating GitHub's claim shape.
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: OURS }, { issuer: "https://evil.example" });
    expect(await verifyGitHubOidcToken(token, POLICY, jwks)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("should refuse an expired token", async () => {
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: OURS }, { expSeconds: -60 });
    expect(await verifyGitHubOidcToken(token, POLICY, jwks)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("should refuse when no token is presented", async () => {
    const { jwks } = await keyring();
    expect(await verifyGitHubOidcToken(null, POLICY, jwks)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("when OIDC is not configured on this deployment", () => {
  it("should refuse rather than accept everything", async () => {
    // The direction that matters. An empty allow-list means "OIDC is off here",
    // never "any repository may trigger a production sync" — and the failure
    // mode of getting that backwards is silent and total.
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: OURS });
    for (const policy of [
      { audience: AUDIENCE, allowedRepositories: [] },
      { audience: "", allowedRepositories: [OURS] },
    ] as OidcPolicy[]) {
      expect(await verifyGitHubOidcToken(token, policy, jwks)).toMatchObject({
        ok: false,
        reason: "not_configured",
      });
    }
  });
});

describe("when a ref pin is configured", () => {
  const pinned: OidcPolicy = { ...POLICY, allowedRefs: ["refs/heads/main"] };

  it("should authorise the scheduled branch", async () => {
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: OURS, ref: "refs/heads/main" });
    expect(await verifyGitHubOidcToken(token, pinned, jwks)).toMatchObject({ ok: true });
  });

  it("should refuse a run from another branch of the same repository", async () => {
    // Scheduled workflows run on the default branch. Pinning the ref means a
    // pushed branch in our own repo cannot trigger a production sync.
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: OURS, ref: "refs/heads/experiment" });
    expect(await verifyGitHubOidcToken(token, pinned, jwks)).toMatchObject({
      ok: false,
      reason: "untrusted_ref",
    });
  });

  it("should not pin the ref when none is configured", async () => {
    const { privateKey, jwks } = await keyring();
    const token = await mint(privateKey, { repository: OURS, ref: "refs/heads/anything" });
    expect(await verifyGitHubOidcToken(token, POLICY, jwks)).toMatchObject({ ok: true });
  });
});
