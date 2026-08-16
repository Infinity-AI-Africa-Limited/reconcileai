import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatFindings, isDigestPinned, looksLikePlaceholder, parseEnvFile, preflight } from "./onPremPreflight";

const ONPREM = path.resolve(import.meta.dirname, "..", "deploy", "on-prem");

/** A configuration that should pass cleanly, used as the base for each scenario. */
function validCpuEnv(): Record<string, string> {
  return {
    JWT_SECRET: "a".repeat(64),
    MYSQL_ROOT_PASSWORD: "S3rv1ce-Db-Password!",
    MINIO_ROOT_PASSWORD: "St0rage-Root-Password!",
    MINIO_APP_SECRET_KEY: "St0rage-App-Password!",
    MYSQL_IMAGE: `mysql@sha256:${"1".repeat(64)}`,
    MINIO_IMAGE: `minio/minio@sha256:${"2".repeat(64)}`,
    MINIO_MC_IMAGE: `minio/mc@sha256:${"3".repeat(64)}`,
    OLLAMA_IMAGE: `ollama/ollama@sha256:${"4".repeat(64)}`,
    NGINX_IMAGE: `nginx@sha256:${"5".repeat(64)}`,
    OLLAMA_MODEL_MODE: "import",
    RECON_MODEL: "reconcileai",
    RECON_MODEL_SHA256: "f".repeat(64),
    APP_BIND_ADDRESS: "127.0.0.1",
  };
}

function validGpuEnv(): Record<string, string> {
  const env = validCpuEnv();
  delete env.OLLAMA_IMAGE;
  delete env.OLLAMA_MODEL_MODE;
  delete env.RECON_MODEL_SHA256;
  return {
    ...env,
    VLLM_API_KEY: "vllm-Deployment-Specific-Key",
    VLLM_IMAGE: `vllm/vllm-openai@sha256:${"6".repeat(64)}`,
    RECON_MODEL: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    MODEL_REVISION: "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
    HF_HUB_OFFLINE: "1",
  };
}

function errorsFor(profile: "cpu" | "gpu", env: Record<string, string>): string[] {
  return preflight(profile, env)
    .filter((f) => f.severity === "error")
    .map((f) => f.variable);
}

describe("parseEnvFile", () => {
  it("should read plain, exported, quoted and commented lines the way Compose does", () => {
    const parsed = parseEnvFile(
      ["# a comment", "PLAIN=value", "export EXPORTED=other", 'QUOTED="spaced value"', "EMPTY=", "  ", "NOEQUALS"].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({ PLAIN: "value", EXPORTED: "other", QUOTED: "spaced value", EMPTY: "" });
  });

  it("should keep a '=' that appears inside a value", () => {
    expect(parseEnvFile("DATABASE_URL=mysql://root:a=b@db:3306/x").DATABASE_URL).toBe("mysql://root:a=b@db:3306/x");
  });
});

describe("isDigestPinned", () => {
  it("should accept only a full sha256 digest reference", () => {
    expect(isDigestPinned(`nginx@sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isDigestPinned("nginx:1.27-alpine")).toBe(false);
    expect(isDigestPinned("nginx:latest")).toBe(false);
    expect(isDigestPinned("nginx@sha256:abc")).toBe(false);
  });
});

describe("looksLikePlaceholder", () => {
  it("should recognise the markers used in the shipped templates", () => {
    expect(looksLikePlaceholder("replace-with-a-64-char-random-secret")).toBe(true);
    expect(looksLikePlaceholder("change-me")).toBe(true);
    expect(looksLikePlaceholder("CHANGE_ME_NOW")).toBe(true);
    expect(looksLikePlaceholder("k7Qm2vRp9LxT4nWz")).toBe(false);
  });
});

describe("when a CPU deployment is correctly configured", () => {
  it("should report no findings at all", () => {
    expect(preflight("cpu", validCpuEnv())).toEqual([]);
  });
});

describe("when deployment secrets are unsafe", () => {
  it("should reject a template placeholder that was never filled in", () => {
    const env = { ...validCpuEnv(), JWT_SECRET: "replace-with-a-64-char-random-secret" };
    expect(errorsFor("cpu", env)).toContain("JWT_SECRET");
  });

  it("should reject a missing secret", () => {
    const env = { ...validCpuEnv(), MYSQL_ROOT_PASSWORD: "" };
    expect(errorsFor("cpu", env)).toContain("MYSQL_ROOT_PASSWORD");
  });

  it("should reject a JWT_SECRET below 32 characters", () => {
    const env = { ...validCpuEnv(), JWT_SECRET: "short-but-not-a-placeholder" };
    expect(errorsFor("cpu", env)).toContain("JWT_SECRET");
  });

  it("should reject reusing one value for the MinIO root and the app account", () => {
    const shared = "Same-Value-Everywhere-123";
    const env = { ...validCpuEnv(), MINIO_ROOT_PASSWORD: shared, MINIO_APP_SECRET_KEY: shared };
    expect(errorsFor("cpu", env)).toContain("MINIO_APP_SECRET_KEY");
  });
});

describe("when container images are not pinned", () => {
  it("should reject a :latest tag as an error", () => {
    const env = { ...validCpuEnv(), OLLAMA_IMAGE: "ollama/ollama:latest" };
    expect(errorsFor("cpu", env)).toContain("OLLAMA_IMAGE");
  });

  it("should reject an image with no tag or digest at all", () => {
    const env = { ...validCpuEnv(), NGINX_IMAGE: "nginx" };
    expect(errorsFor("cpu", env)).toContain("NGINX_IMAGE");
  });

  it("should warn — not block — on a version tag, which can still be repointed", () => {
    const env = { ...validCpuEnv(), NGINX_IMAGE: "nginx:1.27-alpine" };
    const findings = preflight("cpu", env);
    expect(findings.map((f) => f.variable)).toContain("NGINX_IMAGE");
    expect(findings.find((f) => f.variable === "NGINX_IMAGE")?.severity).toBe("warning");
  });
});

describe("when the CPU model bootstrap is not release-controlled", () => {
  it("should reject the internet-pull path for an institution deployment", () => {
    const env = { ...validCpuEnv(), OLLAMA_MODEL_MODE: "pull" };
    expect(errorsFor("cpu", env)).toContain("OLLAMA_MODEL_MODE");
  });

  it("should require the out-of-band release digest in import mode", () => {
    const env = { ...validCpuEnv(), RECON_MODEL_SHA256: "" };
    expect(errorsFor("cpu", env)).toContain("RECON_MODEL_SHA256");
  });

  it("should reject a digest that is not 64 hex characters", () => {
    const env = { ...validCpuEnv(), RECON_MODEL_SHA256: "not-a-digest" };
    expect(errorsFor("cpu", env)).toContain("RECON_MODEL_SHA256");
  });
});

describe("when a GPU deployment is correctly configured", () => {
  it("should report no findings at all", () => {
    expect(preflight("gpu", validGpuEnv())).toEqual([]);
  });

  it("should reject a moving branch as the model revision", () => {
    const env = { ...validGpuEnv(), MODEL_REVISION: "main" };
    expect(errorsFor("gpu", env)).toContain("MODEL_REVISION");
  });

  it("should require the vLLM serving key", () => {
    const env = { ...validGpuEnv(), VLLM_API_KEY: "" };
    expect(errorsFor("gpu", env)).toContain("VLLM_API_KEY");
  });

  it("should warn when vLLM is allowed to fetch weights at start-up", () => {
    const findings = preflight("gpu", { ...validGpuEnv(), HF_HUB_OFFLINE: "0" });
    expect(findings.find((f) => f.variable === "HF_HUB_OFFLINE")?.severity).toBe("warning");
  });
});

describe("when the stack would be published beyond loopback", () => {
  it("should reject a bind address that exposes the gateway to the LAN", () => {
    const env = { ...validCpuEnv(), APP_BIND_ADDRESS: "0.0.0.0" };
    expect(errorsFor("cpu", env)).toContain("APP_BIND_ADDRESS");
  });
});

describe("the shipped .env examples", () => {
  // The examples are templates, so they must FAIL preflight — every secret is
  // still a placeholder. What matters is that they fail for exactly that reason
  // and not because the template forgot a variable the profile requires.
  it.each([
    ["cpu", ".env.onprem.cpu.example"],
    ["gpu", ".env.onprem.gpu.example"],
  ] as const)("should fail %s preflight only on unreplaced placeholders", (profile, file) => {
    const env = parseEnvFile(fs.readFileSync(path.join(ONPREM, file), "utf8"));
    const errors = preflight(profile, env).filter((f) => f.severity === "error");

    expect(errors.length).toBeGreaterThan(0);
    for (const finding of errors) {
      expect(finding.message, `${finding.variable}: ${finding.message}`).toMatch(/placeholder/);
    }
  });

  it.each([
    ["cpu", ".env.onprem.cpu.example"],
    ["gpu", ".env.onprem.gpu.example"],
  ] as const)("should already pin every %s image by digest", (profile, file) => {
    const env = parseEnvFile(fs.readFileSync(path.join(ONPREM, file), "utf8"));
    const imageFindings = preflight(profile, env).filter((f) => f.variable.endsWith("_IMAGE"));
    expect(imageFindings).toEqual([]);
  });
});

describe("formatFindings", () => {
  it("should state a clean pass plainly", () => {
    expect(formatFindings("cpu", [])).toContain("PASS");
  });

  it("should refuse to certify a configuration with errors", () => {
    const output = formatFindings("cpu", [{ severity: "error", variable: "JWT_SECRET", message: "is missing." }]);
    expect(output).toContain("Refusing to certify");
    expect(output).toContain("JWT_SECRET");
  });
});
