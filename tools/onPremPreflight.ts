/**
 * On-premise deployment preflight.
 *
 * A bank deployment fails in two characteristic ways, and neither one announces
 * itself: it starts with a placeholder secret nobody replaced, or it starts from
 * a floating image tag that has been repointed since the institution scanned it.
 * Both produce a stack that comes up green.
 *
 * This module holds the pure checks so they can be unit-tested; `preflightCli.ts`
 * wraps them for operators, and onPremServingProfile.test.ts asserts the Compose
 * files themselves satisfy the contract these checks assume.
 */

import {
  MIN_DEPLOYMENT_SECRET_LENGTH,
  MIN_SIGNING_SECRET_LENGTH,
  looksLikePlaceholderSecret,
} from "../shared/deploymentSecrets";

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  variable: string;
  message: string;
}

export type ProfileName = "cpu" | "gpu";

/** Secrets that must be present, unique per deployment, and not a template value. */
const REQUIRED_SECRETS: Record<ProfileName, string[]> = {
  cpu: ["JWT_SECRET", "MYSQL_ROOT_PASSWORD", "MINIO_ROOT_PASSWORD", "MINIO_APP_SECRET_KEY"],
  gpu: ["JWT_SECRET", "MYSQL_ROOT_PASSWORD", "MINIO_ROOT_PASSWORD", "MINIO_APP_SECRET_KEY", "VLLM_API_KEY"],
};

/** Every container image the profile starts. All must be digest-pinned. */
const REQUIRED_IMAGES: Record<ProfileName, string[]> = {
  cpu: ["MYSQL_IMAGE", "MINIO_IMAGE", "MINIO_MC_IMAGE", "OLLAMA_IMAGE", "NGINX_IMAGE"],
  gpu: ["MYSQL_IMAGE", "MINIO_IMAGE", "MINIO_MC_IMAGE", "VLLM_IMAGE", "NGINX_IMAGE"],
};

/**
 * Re-exported so the CLI and tests use one definition. The rule lives in
 * shared/ because the server's boot guard enforces the same thing — a preflight
 * that passes what the server then refuses is worse than no preflight.
 */
export const looksLikePlaceholder = looksLikePlaceholderSecret;

/**
 * A digest pin (`repo@sha256:…`) is the only form that cannot be repointed after
 * review. A tag — including a version tag — can be moved to different bytes.
 */
export function isDigestPinned(image: string): boolean {
  return /@sha256:[0-9a-f]{64}$/.test(image.trim());
}

/**
 * Parse a dotenv-style file. Deliberately minimal: `KEY=value`, `#` comments,
 * optional `export`, and surrounding quotes stripped. No interpolation — the
 * point is to see exactly what Compose will see.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function checkSecrets(profile: ProfileName, env: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const key of REQUIRED_SECRETS[profile]) {
    const value = (env[key] ?? "").trim();
    if (!value) {
      findings.push({ severity: "error", variable: key, message: "is required but missing or empty." });
      continue;
    }
    if (looksLikePlaceholder(value)) {
      findings.push({
        severity: "error",
        variable: key,
        message: "still holds the template placeholder. Generate a unique value for this deployment.",
      });
      continue;
    }
    const min = key === "JWT_SECRET" ? MIN_SIGNING_SECRET_LENGTH : MIN_DEPLOYMENT_SECRET_LENGTH;
    if (value.length < min) {
      findings.push({
        severity: "error",
        variable: key,
        message: `is shorter than ${min} characters. Use \`openssl rand -hex 32\`.`,
      });
    }
  }

  // Reusing one secret across roles collapses the privilege separation the
  // profiles are built around — most importantly MinIO root vs the app account.
  const seen = new Map<string, string>();
  for (const key of REQUIRED_SECRETS[profile]) {
    const value = (env[key] ?? "").trim();
    if (!value || looksLikePlaceholder(value)) continue;
    const first = seen.get(value);
    if (first) {
      findings.push({
        severity: "error",
        variable: key,
        message: `reuses the value of ${first}. Each secret must be distinct.`,
      });
    } else {
      seen.set(value, key);
    }
  }
  return findings;
}

function checkImages(profile: ProfileName, env: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  for (const key of REQUIRED_IMAGES[profile]) {
    const value = (env[key] ?? "").trim();
    if (!value) {
      findings.push({ severity: "error", variable: key, message: "is required but missing or empty." });
      continue;
    }
    if (/:latest$/i.test(value) || !value.includes(":")) {
      findings.push({
        severity: "error",
        variable: key,
        message: `uses a floating tag ("${value}"). Pin it to a scanned digest: repo@sha256:…`,
      });
      continue;
    }
    if (!isDigestPinned(value)) {
      findings.push({
        severity: "warning",
        variable: key,
        message: `is tag-pinned ("${value}"). A tag can be repointed after review; prefer repo@sha256:…`,
      });
    }
  }
  return findings;
}

function checkCpuModel(env: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  const mode = (env.OLLAMA_MODEL_MODE ?? "pull").trim();

  if (mode !== "import") {
    findings.push({
      severity: "error",
      variable: "OLLAMA_MODEL_MODE",
      message:
        `is "${mode}". Institution deployments must use "import" — "pull" downloads an ` +
        "unverified stock model from the internet and is for local demonstration only.",
    });
    return findings;
  }

  const digest = (env.RECON_MODEL_SHA256 ?? "").trim();
  if (!digest) {
    findings.push({
      severity: "error",
      variable: "RECON_MODEL_SHA256",
      message: "is required in import mode. Supply the digest from the signed release record.",
    });
  } else if (looksLikePlaceholder(digest)) {
    findings.push({
      severity: "error",
      variable: "RECON_MODEL_SHA256",
      message: "still holds the template placeholder.",
    });
  } else if (!/^[0-9a-f]{64}$/i.test(digest)) {
    findings.push({
      severity: "error",
      variable: "RECON_MODEL_SHA256",
      message: "is not a 64-character hex SHA-256 digest.",
    });
  }

  if (!(env.RECON_MODEL ?? "").trim()) {
    findings.push({ severity: "error", variable: "RECON_MODEL", message: "is required in import mode." });
  }
  return findings;
}

function checkGpuModel(env: Record<string, string>): Finding[] {
  const findings: Finding[] = [];
  const revision = (env.MODEL_REVISION ?? "").trim();
  if (!revision) {
    findings.push({ severity: "error", variable: "MODEL_REVISION", message: "is required." });
  } else if (looksLikePlaceholder(revision)) {
    findings.push({
      severity: "error",
      variable: "MODEL_REVISION",
      message: "still holds the template placeholder. Use the approved immutable revision.",
    });
  } else if (["main", "master", "latest"].includes(revision.toLowerCase())) {
    findings.push({
      severity: "error",
      variable: "MODEL_REVISION",
      message: `is the moving branch "${revision}". Pin the reviewed commit SHA instead.`,
    });
  }

  if (!(env.RECON_MODEL ?? "").trim()) {
    findings.push({ severity: "error", variable: "RECON_MODEL", message: "is required." });
  }
  if ((env.HF_HUB_OFFLINE ?? "1").trim() !== "1") {
    findings.push({
      severity: "warning",
      variable: "HF_HUB_OFFLINE",
      message: "is not 1. vLLM may attempt a model download at start-up instead of using staged weights.",
    });
  }
  return findings;
}

function checkExposure(env: Record<string, string>): Finding[] {
  const bind = (env.APP_BIND_ADDRESS ?? "127.0.0.1").trim();
  if (bind === "127.0.0.1" || bind === "::1" || bind === "localhost") return [];
  return [
    {
      severity: "error",
      variable: "APP_BIND_ADDRESS",
      message:
        `is "${bind}", which publishes the gateway beyond host loopback. The institution's ` +
        "reverse proxy must terminate TLS and enforce identity in front of this stack.",
    },
  ];
}

/** Run every check for a profile. Returns findings ordered errors-first. */
export function preflight(profile: ProfileName, env: Record<string, string>): Finding[] {
  const findings = [
    ...checkSecrets(profile, env),
    ...checkImages(profile, env),
    ...(profile === "cpu" ? checkCpuModel(env) : checkGpuModel(env)),
    ...checkExposure(env),
  ];
  return [...findings.filter((f) => f.severity === "error"), ...findings.filter((f) => f.severity === "warning")];
}

export function formatFindings(profile: ProfileName, findings: Finding[]): string {
  if (findings.length === 0) {
    return `on-premise preflight (${profile}): PASS — no blocking findings.`;
  }
  const lines = findings.map((f) => `  [${f.severity.toUpperCase()}] ${f.variable} ${f.message}`);
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  return [
    `on-premise preflight (${profile}): ${errors} error(s), ${warnings} warning(s)`,
    ...lines,
    errors > 0
      ? "\nRefusing to certify this configuration for an institution deployment."
      : "\nNo blocking errors. Review the warnings before the release is signed off.",
  ].join("\n");
}
