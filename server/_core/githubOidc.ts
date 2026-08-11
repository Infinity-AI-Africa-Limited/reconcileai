/**
 * GitHub Actions OIDC verification for the scheduler endpoints.
 *
 * Replaces a long-lived shared secret copied between two dashboards with a
 * short-lived token GitHub mints per workflow run and signs with its own key.
 * There is then nothing to rotate and nothing to drift — which is the actual
 * fix for the 2026-08-02 outage, where `CRON_SECRET` was rotated on Railway,
 * the GitHub copy was not, and the Woodcore mirror sat stale for three days
 * behind a 403 nobody was watching.
 *
 * ── The check that carries the whole thing ────────────────────────────────
 *
 * A valid GitHub OIDC token proves only that SOME workflow on SOME repository
 * issued it. Anyone with a public repo can mint one, choose any `aud` they
 * like, and present it here. Signature + issuer + audience together are NOT
 * authentication — they would let any GitHub user on earth trigger a
 * production sync.
 *
 * The `repository` claim is what makes it authentication, so it is required,
 * and an unset allow-list DISABLES OIDC rather than accepting everything. That
 * direction matters: the failure mode of the alternative is silent and total.
 *
 * ── Deliberately kept alongside the shared secret ─────────────────────────
 *
 * Verification fetches GitHub's JWKS, so it needs egress to
 * token.actions.githubusercontent.com. An on-premise deployment
 * (DEPLOYMENT_MODE=on_premise) blocks exactly that, and Railway Cron cannot
 * mint an OIDC token at all. Both still need to trigger a sync, so the shared
 * secret remains a valid second path rather than being ripped out.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** GitHub's OIDC issuer. Fixed; never read from the token. */
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

export type OidcVerifyResult =
  | { ok: true; repository: string; workflow: string | null; ref: string | null }
  | { ok: false; reason: OidcFailure; detail?: string };

export type OidcFailure =
  | "not_configured"
  | "malformed"
  | "untrusted_repository"
  | "untrusted_ref"
  | "invalid";

export interface OidcPolicy {
  /** The `aud` this deployment requires. Chosen by us; GitHub echoes it. */
  audience: string;
  /** `owner/repo` values permitted to trigger. EMPTY DISABLES OIDC ENTIRELY. */
  allowedRepositories: string[];
  /** Optional extra pin, e.g. `refs/heads/main`. Empty = any ref on an allowed repo. */
  allowedRefs?: string[];
}

/**
 * Lazily-created remote key set.
 *
 * `createRemoteJWKSet` caches keys and re-fetches on an unknown `kid`, so this
 * is one network call at startup rather than one per request — and it survives
 * GitHub's key rotation without a deploy.
 */
let cachedJwks: JWTVerifyGetKey | null = null;
function remoteJwks(): JWTVerifyGetKey {
  if (!cachedJwks) cachedJwks = createRemoteJWKSet(new URL(GITHUB_OIDC_JWKS_URL));
  return cachedJwks;
}

/**
 * Verify a GitHub Actions OIDC token against a policy.
 *
 * `getKey` is injectable so the claim logic can be tested against a locally
 * generated key pair. Real signature verification runs in those tests — a stub
 * that returns "valid" would prove nothing about the part that matters.
 */
export async function verifyGitHubOidcToken(
  token: string | undefined | null,
  policy: OidcPolicy,
  getKey: JWTVerifyGetKey = remoteJwks(),
): Promise<OidcVerifyResult> {
  // Fail closed. No allow-list means OIDC is not configured for this
  // deployment, NOT that every repository is welcome.
  if (!policy.audience || policy.allowedRepositories.length === 0) {
    return { ok: false, reason: "not_configured" };
  }
  if (!token) return { ok: false, reason: "malformed" };

  let claims: Record<string, unknown>;
  try {
    // jose enforces signature, `iss`, `aud`, and expiry. Everything below is
    // authorisation, which it cannot know anything about.
    const { payload } = await jwtVerify(token, getKey, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: policy.audience,
    });
    claims = payload as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: "invalid", detail: err instanceof Error ? err.message : String(err) };
  }

  const repository = typeof claims.repository === "string" ? claims.repository : "";
  if (!policy.allowedRepositories.includes(repository)) {
    // The token is genuine and correctly signed — it simply belongs to someone
    // else. Naming the repository is safe (it is the caller's own) and is the
    // single most useful thing in the log if this ever fires.
    return { ok: false, reason: "untrusted_repository", detail: repository || "(no repository claim)" };
  }

  const ref = typeof claims.ref === "string" ? claims.ref : null;
  if (policy.allowedRefs?.length && (!ref || !policy.allowedRefs.includes(ref))) {
    return { ok: false, reason: "untrusted_ref", detail: ref ?? "(no ref claim)" };
  }

  return {
    ok: true,
    repository,
    workflow: typeof claims.workflow === "string" ? claims.workflow : null,
    ref,
  };
}

/** Human-readable remedy for a refusal, for the server log. Never includes the token. */
export function describeOidcFailure(reason: OidcFailure, detail?: string): string {
  switch (reason) {
    case "not_configured":
      return "GitHub OIDC is not configured on this deployment (GITHUB_OIDC_AUDIENCE / GITHUB_OIDC_REPOSITORIES unset) — falling back to the shared secret";
    case "malformed":
      return "request carried no bearer token";
    case "untrusted_repository":
      return `token is valid but was issued to repository ${detail}, which is not in GITHUB_OIDC_REPOSITORIES — this is the check that stops any GitHub user triggering a sync`;
    case "untrusted_ref":
      return `token is valid but was issued for ref ${detail}, which is not in GITHUB_OIDC_REFS`;
    case "invalid":
      return `token failed signature/issuer/audience/expiry verification: ${detail ?? "no detail"}`;
  }
}
