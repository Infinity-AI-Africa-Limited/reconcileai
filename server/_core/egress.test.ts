import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * ENV is computed at import time from process.env, so each scenario resets the
 * module registry and re-imports egress.ts with the desired environment.
 */
/** A JWT_SECRET that satisfies the on-premise boot guard, for the cases not testing it. */
const STRONG_JWT_SECRET = "b3d1f8c04a7e2951f6a8c0d2e4b6a8901c3e5d7f9a1b3c5d7e9f0a2b4c6d8e0f";
const DEDICATED_TENANT_MASTER_KEY = "e1c4b7a9d2f5e8c0b3a6d9f1c4e7b0a3d6f9c2e5b8a1d4f7c0e3b6a9d2f5e8c1";

async function loadEgress(env: Record<string, string>) {
  vi.resetModules();
  // Clear the vars these tests care about so ambient env can't leak in.
  for (const k of ["DEPLOYMENT_MODE", "EGRESS_ALLOWLIST", "BUILT_IN_FORGE_API_KEY", "DIRECT_LLM_API_KEY", "DIRECT_LLM_API_URL", "TENANT_MASTER_KEY", "TENANT_KEY_PROVIDER", "TENANT_KMS_KEY_ID", "AUDIT_IMMUTABILITY_MODE"]) {
    vi.stubEnv(k, "");
  }
  // The on-premise startup check now also validates JWT_SECRET, so pin it
  // rather than letting the developer's ambient .env decide the outcome.
  vi.stubEnv("JWT_SECRET", STRONG_JWT_SECRET);
  vi.stubEnv("TENANT_MASTER_KEY", DEDICATED_TENANT_MASTER_KEY);
  vi.stubEnv("AUDIT_IMMUTABILITY_MODE", "db_write_deny");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return await import("./egress");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("egress guard — cloud mode (default)", () => {
  it("is a no-op and allows any external host", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "cloud" });
    expect(e.isOnPremise()).toBe(false);
    expect(() => e.assertEgressAllowed("https://api.anthropic.com/v1/messages", "llm")).not.toThrow();
    expect(e.isEgressAllowed("https://api.resend.com/emails")).toBe(true);
  });

  it("defaults to cloud when DEPLOYMENT_MODE is unset", async () => {
    const e = await loadEgress({});
    expect(e.deploymentMode()).toBe("cloud");
  });
});

describe("egress guard — on_premise mode", () => {
  it("blocks external hosts", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise" });
    expect(e.isOnPremise()).toBe(true);
    expect(() => e.assertEgressAllowed("https://api.anthropic.com/v1/messages", "llm")).toThrow(/on-premise/i);
    expect(e.isEgressAllowed("https://api.resend.com/emails")).toBe(false);
    expect(e.isEgressAllowed("https://hooks.example.com/webhook")).toBe(false);
  });

  it("allows loopback, private (RFC1918) and private-DNS hosts", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise" });
    expect(e.isEgressAllowed("http://localhost:11434/v1/chat/completions")).toBe(true);
    expect(e.isEgressAllowed("http://127.0.0.1:8000/v1/messages")).toBe(true);
    expect(e.isEgressAllowed("http://10.0.5.2:8080")).toBe(true);
    expect(e.isEgressAllowed("http://192.168.1.50:3000")).toBe(true);
    expect(e.isEgressAllowed("http://172.16.4.4:9000")).toBe(true);
    expect(e.isEgressAllowed("http://llm.internal/v1/messages")).toBe(true);
  });

  it("honours EGRESS_ALLOWLIST (exact host and subdomains)", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise", EGRESS_ALLOWLIST: "intel.reconcileai.vip" });
    expect(e.isEgressAllowed("https://intel.reconcileai.vip/v1/patterns")).toBe(true);
    expect(e.isEgressAllowed("https://eu.intel.reconcileai.vip/v1/patterns")).toBe(true);
    expect(e.isEgressAllowed("https://evil.com/steal")).toBe(false);
  });

  it("rejects malformed URLs", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise" });
    expect(() => e.assertEgressAllowed("not a url", "llm")).toThrow();
  });
});

describe("residency startup check", () => {
  it("passes in cloud mode regardless of config", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "cloud", BUILT_IN_FORGE_API_KEY: "forge-key" });
    expect(() => e.assertResidencyStartupConfig()).not.toThrow();
  });

  it("fails on-premise when Manus Forge is enabled", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise", BUILT_IN_FORGE_API_KEY: "forge-key" });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/Forge/);
  });

  it("fails on-premise when the LLM URL is external", async () => {
    const e = await loadEgress({
      DEPLOYMENT_MODE: "on_premise",
      DIRECT_LLM_API_KEY: "k",
      DIRECT_LLM_API_URL: "https://api.anthropic.com",
    });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/external host/);
  });

  it("fails on-premise when a key is set but the LLM URL is empty (would default to internet)", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise", DIRECT_LLM_API_KEY: "k" });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/empty/);
  });

  it("passes on-premise with a local LLM endpoint", async () => {
    const e = await loadEgress({
      DEPLOYMENT_MODE: "on_premise",
      DIRECT_LLM_API_KEY: "k",
      DIRECT_LLM_API_URL: "http://localhost:11434",
    });
    expect(() => e.assertResidencyStartupConfig()).not.toThrow();
  });

  it("refuses an on-premise deployment that derives tenant encryption from the session secret", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise", TENANT_MASTER_KEY: "" });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/TENANT_MASTER_KEY/);
  });

  it("requires a customer-managed key identifier when aws_kms is selected", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise", TENANT_KEY_PROVIDER: "aws_kms", TENANT_KMS_KEY_ID: "" });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/TENANT_KMS_KEY_ID/);
  });

  it("refuses an on-premise deployment without an infrastructure-immutable audit posture", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise", AUDIT_IMMUTABILITY_MODE: "" });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/AUDIT_IMMUTABILITY_MODE/);
  });
});

describe("on-premise deployment-secret guard", () => {
  const localLlm = { DEPLOYMENT_MODE: "on_premise", DIRECT_LLM_API_KEY: "k", DIRECT_LLM_API_URL: "http://localhost:11434" };

  it("refuses to boot when JWT_SECRET is still the shipped placeholder", async () => {
    const e = await loadEgress({ ...localLlm, JWT_SECRET: "replace-with-a-64-char-random-secret" });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/JWT_SECRET still holds a template placeholder/);
  });

  it("refuses to boot when JWT_SECRET is unset", async () => {
    const e = await loadEgress({ ...localLlm, JWT_SECRET: "" });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/JWT_SECRET is not set/);
  });

  it("refuses to boot when JWT_SECRET is too short to be a signing key", async () => {
    const e = await loadEgress({ ...localLlm, JWT_SECRET: "abc123" });
    expect(() => e.assertResidencyStartupConfig()).toThrow(/shorter than 32 characters/);
  });

  it("does not police secrets in cloud mode, where the platform manages them", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "cloud", JWT_SECRET: "change-me" });
    expect(() => e.assertResidencyStartupConfig()).not.toThrow();
  });
});

describe("describeResidencyPosture", () => {
  it("reports enforced=true and the allowlist in on_premise mode", async () => {
    const e = await loadEgress({ DEPLOYMENT_MODE: "on_premise", EGRESS_ALLOWLIST: "a.com, b.com" });
    const p = e.describeResidencyPosture();
    expect(p.mode).toBe("on_premise");
    expect(p.enforced).toBe(true);
    expect(p.egressAllowlist).toEqual(["a.com", "b.com"]);
  });
});
