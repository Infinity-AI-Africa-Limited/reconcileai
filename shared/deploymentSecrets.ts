/**
 * What counts as a real deployment secret.
 *
 * Two places need this answer and they must not be able to disagree: the
 * pre-install preflight (`tools/onPremPreflight.ts`) tells an operator their
 * env file is not ready, and the boot guard (`server/_core/egress.ts`) refuses
 * to start an on-premise process configured with a template value. A preflight
 * that passes something the server then rejects — or worse, a server that
 * accepts something the preflight called unsafe — is the failure this shared
 * module exists to prevent.
 *
 * The check is deliberately narrow. It catches the template value nobody
 * replaced; it is not an entropy estimator and does not pretend to be.
 */

/** Markers that appear in the shipped .env templates and in old defaults. */
const PLACEHOLDER_MARKERS = [
  "replace-with",
  "replace_with",
  "change-me",
  "change_me",
  "changeme",
  "your-",
  "xxxxx",
] as const;

/** `openssl rand -hex 32` — the length every deployment doc asks for. */
export const MIN_SIGNING_SECRET_LENGTH = 32;

/** A generic non-signing secret (database, storage) may be shorter. */
export const MIN_DEPLOYMENT_SECRET_LENGTH = 16;

export function looksLikePlaceholderSecret(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return false;
  return PLACEHOLDER_MARKERS.some((marker) => v.includes(marker));
}

export type SecretProblem = "missing" | "placeholder" | "too_short";

/**
 * Returns why `value` is not usable as a deployment secret, or null if it is.
 * `minLength` defaults to the signing-secret length because the caller that
 * matters most is JWT_SECRET.
 */
export function deploymentSecretProblem(
  value: string | undefined,
  minLength: number = MIN_SIGNING_SECRET_LENGTH,
): SecretProblem | null {
  const v = (value ?? "").trim();
  if (!v) return "missing";
  if (looksLikePlaceholderSecret(v)) return "placeholder";
  if (v.length < minLength) return "too_short";
  return null;
}

export function describeSecretProblem(name: string, problem: SecretProblem, minLength: number): string {
  switch (problem) {
    case "missing":
      return `${name} is not set.`;
    case "placeholder":
      return `${name} still holds a template placeholder value.`;
    case "too_short":
      return `${name} is shorter than ${minLength} characters.`;
  }
}
