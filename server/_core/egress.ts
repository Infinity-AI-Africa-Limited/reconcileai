/**
 * Data-residency egress guard.
 *
 * PTB and other on-premise customers are given a written guarantee that their
 * transaction data "never leaves their infrastructure." This module turns that
 * promise into an enforced control rather than a deployment convention.
 *
 * When DEPLOYMENT_MODE=on_premise, `assertEgressAllowed` throws for any outbound
 * call whose destination host is not loopback/private (RFC1918 / ULA) or on the
 * explicit EGRESS_ALLOWLIST. Every outbound call site in the app routes through
 * it, so an accidental external call fails closed instead of silently shipping
 * data off-box. In the default "cloud" mode it is a no-op (current behaviour).
 */
import {
  MIN_SIGNING_SECRET_LENGTH,
  deploymentSecretProblem,
  describeSecretProblem,
} from "../../shared/deploymentSecrets";
import { ENV } from "./env";

export type DeploymentMode = "cloud" | "on_premise";

export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressBlockedError";
  }
}

export function deploymentMode(): DeploymentMode {
  return ENV.deploymentMode === "on_premise" ? "on_premise" : "cloud";
}

export function isOnPremise(): boolean {
  return deploymentMode() === "on_premise";
}

/** Loopback / private / link-local hosts are always allowed (they stay on-box / in-VPC). */
function isLocalHost(rawHost: string): boolean {
  const h = rawHost.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 10.0.0.0/8
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 192.168.0.0/16
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // 172.16.0.0/12
  if (/^127\./.test(h)) return true; // loopback range
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^\[?f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 ULA fc00::/7
  if (/\.(local|internal|lan|intranet)$/.test(h)) return true; // private DNS suffixes
  return false;
}

export function parseAllowlist(): string[] {
  return ENV.egressAllowlist
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowlisted(rawHost: string): boolean {
  const h = rawHost.toLowerCase();
  return parseAllowlist().some((entry) => h === entry || h.endsWith("." + entry));
}

/**
 * Throw if `url` would send data off the deployment in on_premise mode.
 * No-op in cloud mode. `purpose` is used only for the error message.
 */
export function assertEgressAllowed(url: string, purpose: string): void {
  if (!isOnPremise()) return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new EgressBlockedError(
      `On-premise mode: refusing ${purpose} — malformed destination URL "${url}".`,
    );
  }
  if (isLocalHost(host) || hostAllowlisted(host)) return;
  throw new EgressBlockedError(
    `On-premise mode blocked an external ${purpose} to "${host}". ` +
      `Data residency is enforced (DEPLOYMENT_MODE=on_premise) — transaction data must not leave the deployment. ` +
      `Point this at an in-infrastructure endpoint, or add "${host}" to EGRESS_ALLOWLIST if it is an approved in-VPC service.`,
  );
}

/** Non-throwing variant for gated-but-optional egress (e.g. email): true if allowed. */
export function isEgressAllowed(url: string): boolean {
  try {
    assertEgressAllowed(url, "call");
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail-fast startup validation for on-premise mode. Refuses to boot when the
 * configuration would leak data off-box (Forge enabled, or an LLM endpoint that
 * resolves to the public internet) or when a deployment secret was never
 * replaced. No-op in cloud mode.
 */
export function assertResidencyStartupConfig(): void {
  if (!isOnPremise()) return;
  const problems: string[] = [];

  // An air-gapped install is handed over on physical media and set up by
  // someone following a runbook. A JWT_SECRET left at its template value forges
  // a session as any user, including super_admin — and nothing else in the
  // stack would notice, because a placeholder secret signs cookies perfectly
  // well. Fail the boot instead, where the operator is still watching.
  const secretProblem = deploymentSecretProblem(ENV.cookieSecret, MIN_SIGNING_SECRET_LENGTH);
  if (secretProblem) {
    problems.push(
      `${describeSecretProblem("JWT_SECRET", secretProblem, MIN_SIGNING_SECRET_LENGTH)} ` +
        "It signs session cookies and derives the token-encryption key. Generate a unique value " +
        "per deployment with `openssl rand -hex 32`.",
    );
  }

  if (ENV.forgeApiKey.trim()) {
    problems.push(
      "BUILT_IN_FORGE_API_KEY is set — Manus Forge routes prompts to forge.manus.im. Unset it in on-premise mode.",
    );
  }

  const llmUrl = ENV.directLlmApiUrl.trim();
  if (ENV.directLlmApiKey.trim() && !llmUrl) {
    problems.push(
      "DIRECT_LLM_API_KEY is set but DIRECT_LLM_API_URL is empty — it would default to the public api.anthropic.com / api.openai.com endpoint. Point it at a local/in-VPC LLM.",
    );
  }
  if (llmUrl && !isEgressAllowed(llmUrl)) {
    problems.push(
      `DIRECT_LLM_API_URL "${llmUrl}" is an external host — point it at an in-VPC/local LLM endpoint, or add the host to EGRESS_ALLOWLIST if it is an approved in-infrastructure service.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      "On-premise data-residency startup check FAILED — refusing to start:\n - " +
        problems.join("\n - "),
    );
  }
}

/** Posture summary for the startup log and the residency status endpoint/badge. */
export function describeResidencyPosture() {
  const mode = deploymentMode();
  return {
    mode,
    enforced: mode === "on_premise",
    egressAllowlist: parseAllowlist(),
    note:
      mode === "on_premise"
        ? "Outbound calls are blocked except to loopback/private hosts and the egress allowlist. Transaction data stays in the deployment."
        : "Cloud mode: external services (LLM, email, storage) are reachable per configuration.",
  };
}
