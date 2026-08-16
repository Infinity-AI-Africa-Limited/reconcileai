import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("private Qwen/vLLM on-premise serving profile", () => {
  const compose = fs.readFileSync("deploy/on-prem/docker-compose.gpu.yml", "utf8");
  const gpuEnv = fs.readFileSync("deploy/on-prem/.env.onprem.gpu.example", "utf8");
  const readme = fs.readFileSync("deploy/on-prem/README.md", "utf8");
  const cpuCompose = fs.readFileSync("deploy/on-prem/docker-compose.cpu.yml", "utf8");
  const cpuEnv = fs.readFileSync("deploy/on-prem/.env.onprem.cpu.example", "utf8");
  const executionPlan = fs.readFileSync("docs/deployment/ACCELERATED_DUAL_TIER_EXECUTION.md", "utf8");

  it("keeps the vLLM endpoint on a private network and requires authenticated app access", () => {
    const vllmBlock = compose.slice(compose.indexOf("  vllm:"), compose.indexOf("  app:"));

    expect(vllmBlock).not.toContain("ports:");
    expect(vllmBlock).toContain("networks: [bank-internal]");
    expect(vllmBlock).toContain("--api-key ${VLLM_API_KEY:?");
    expect(vllmBlock).toContain("--disable-log-requests");
    expect(compose).toContain("DIRECT_LLM_API_KEY: ${VLLM_API_KEY:?");
    expect(compose).toContain("internal: true");
  });

  it("requires an approved immutable model revision and avoids direct LAN exposure", () => {
    expect(compose).toContain("--revision ${MODEL_REVISION:?");
    expect(compose).toContain("${APP_BIND_ADDRESS:-127.0.0.1}:3000:3000");
    expect(gpuEnv).toContain("MODEL_REVISION=replace-with-reviewed-immutable-model-revision");
    expect(readme).toContain("Serving boundary: local development versus bank deployment");
  });

  it("makes CPU/Ollama a private, offline-capable deployment path for institutions without GPUs", () => {
    const ollamaBlock = cpuCompose.slice(cpuCompose.indexOf("  ollama:"), cpuCompose.indexOf("  model-init:"));
    const modelInitBlock = cpuCompose.slice(cpuCompose.indexOf("  model-init:"), cpuCompose.indexOf("  app:"));

    expect(ollamaBlock).not.toContain("ports:");
    expect(ollamaBlock).toContain("networks: [bank-internal]");
    expect(modelInitBlock).toContain('"${OLLAMA_MODEL_MODE:-pull}" = "import"');
    expect(modelInitBlock).toContain("ollama create");
    expect(modelInitBlock).toContain("sha256sum --check --status SHA256SUMS");
    expect(cpuCompose).toContain("${APP_BIND_ADDRESS:-127.0.0.1}:3000:3000");
    expect(cpuCompose).toContain("internal: true");
    expect(cpuEnv).toContain("OLLAMA_MODEL_MODE=import");
    expect(cpuEnv).toContain("RECON_MODEL=reconcileai");
  });

  it("keeps the accelerated plan explicit about both tiers and immutable control gates", () => {
    expect(executionPlan).toContain("Six-week accelerated programme");
    expect(executionPlan).toContain("CPU tier");
    expect(executionPlan).toContain("GPU tier");
    expect(executionPlan).toMatch(/no real bank or customer\s+data leaves the institution-controlled environment/);
    expect(executionPlan).toContain("deterministic reconciliation engine remains the source of truth");
  });
});
