import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("private Qwen/vLLM on-premise serving profile", () => {
  const compose = fs.readFileSync("deploy/on-prem/docker-compose.gpu.yml", "utf8");
  const gpuEnv = fs.readFileSync("deploy/on-prem/.env.onprem.gpu.example", "utf8");
  const readme = fs.readFileSync("deploy/on-prem/README.md", "utf8");

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
});
