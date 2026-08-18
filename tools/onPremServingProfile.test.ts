import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Deployment-contract tests for the two on-premise serving profiles.
 *
 * These parse the Compose YAML rather than string-matching it. The distinction
 * matters: a substring assertion that `internal: true` appears somewhere in the
 * file still passes when a service publishes a port it should not, and breaks
 * on a reformat that changed nothing. Parsing lets the test state the actual
 * invariant — "no service except the gateway publishes a host port" — and that
 * is the property a bank's reviewer cares about.
 *
 * Both profiles are held to ONE shared contract on purpose. The GPU profile had
 * drifted into a serving sidecar without the CPU profile's storage, gateway and
 * secret controls; a shared table makes that class of divergence a test failure
 * rather than something spotted in review.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const ONPREM = path.join(ROOT, "deploy", "on-prem");

function readOnPrem(file: string): string {
  return fs.readFileSync(path.join(ONPREM, file), "utf8");
}

interface ComposeService {
  image?: string;
  ports?: string[];
  networks?: string[] | Record<string, unknown>;
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  security_opt?: string[];
  command?: string | string[];
  restart?: string;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean } | null>;
}

const PROFILES = [
  { name: "cpu", composeFile: "docker-compose.cpu.yml", envExample: ".env.onprem.cpu.example", modelService: "ollama" },
  { name: "gpu", composeFile: "docker-compose.gpu.yml", envExample: ".env.onprem.gpu.example", modelService: "vllm" },
] as const;

describe.each(PROFILES)("on-premise $name serving profile", ({ composeFile, envExample, modelService }) => {
  const raw = readOnPrem(composeFile);
  const compose = parse(raw) as ComposeFile;
  const env = readOnPrem(envExample);

  it("should publish exactly one host port, from the gateway, on loopback", () => {
    const publishing = Object.entries(compose.services)
      .filter(([, service]) => (service.ports ?? []).length > 0)
      .map(([name]) => name);

    // A container attached only to an `internal: true` network cannot serve a
    // published port — the host connection is refused. The gateway exists to
    // carry the publication, so the app must never grow its own `ports:`.
    expect(publishing).toEqual(["gateway"]);
    expect(compose.services.gateway.ports).toEqual(["${APP_BIND_ADDRESS:-127.0.0.1}:3000:8080"]);
  });

  it("should keep the model runtime, database and storage off the host network", () => {
    for (const name of [modelService, "db", "minio", "app"]) {
      expect(compose.services[name], `${name} must exist in ${composeFile}`).toBeDefined();
      expect(compose.services[name].ports ?? []).toEqual([]);
    }
  });

  it("should place every service on the internal network, and only the gateway on the published one", () => {
    expect(compose.networks["bank-internal"]?.internal).toBe(true);

    for (const [name, service] of Object.entries(compose.services)) {
      const networks = (service.networks ?? []) as string[];
      expect(networks, `${name} must be on bank-internal`).toContain("bank-internal");
      if (name !== "gateway") {
        expect(networks, `${name} must not reach the host-loopback network`).not.toContain("host-loopback");
      }
    }
  });

  it("should refuse to start without deployment-supplied secrets rather than defaulting", () => {
    // `${VAR:-fallback}` on a secret is the failure mode this guards: a stack
    // that starts happily on a password published in the repository.
    for (const secret of ["MYSQL_ROOT_PASSWORD", "MINIO_ROOT_PASSWORD", "JWT_SECRET"]) {
      expect(raw).toContain(`\${${secret}:?`);
      expect(raw, `${secret} must have no default value`).not.toMatch(
        new RegExp(`\\$\\{${secret}:-`),
      );
    }
    expect(raw).not.toContain("change-me");
  });

  it("should pin every image through a required variable, never a floating tag", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      if (!service.image) continue; // the app service builds from the Dockerfile
      expect(service.image, `${name} must take its image from a required variable`).toMatch(
        /^\$\{[A-Z0-9_]+:\?/,
      );
    }
    expect(raw).not.toMatch(/:latest/);
    // The examples ship real digests so an operator has a working reference
    // rather than a placeholder they are tempted to replace with `:latest`.
    expect(env).not.toMatch(/^[A-Z0-9_]*IMAGE=.*:latest$/m);
    expect(env).toMatch(/^MYSQL_IMAGE=mysql@sha256:[0-9a-f]{64}$/m);
    expect(env).toMatch(/^NGINX_IMAGE=nginx@sha256:[0-9a-f]{64}$/m);
  });

  it("should give the application a bucket-scoped storage credential, never the MinIO root", () => {
    const appEnv = compose.services.app.environment ?? {};
    expect(appEnv.AWS_ACCESS_KEY_ID).toContain("MINIO_APP_ACCESS_KEY");
    expect(appEnv.AWS_SECRET_ACCESS_KEY).toContain("MINIO_APP_SECRET_KEY");
    expect(appEnv.AWS_ACCESS_KEY_ID).not.toContain("MINIO_ROOT");
    expect(appEnv.AWS_SECRET_ACCESS_KEY).not.toContain("MINIO_ROOT");
    expect(compose.services["storage-init"]).toBeDefined();
  });

  it("should not load the infrastructure env file into the application container", () => {
    // .env.onprem carries MinIO root and image digests. `env_file` would hand
    // the web app the storage root credential the scoped account exists to avoid.
    expect(compose.services.app).not.toHaveProperty("env_file");
    expect(compose.services.app.environment?.JWT_SECRET).toContain("JWT_SECRET:?");
  });

  it("should prove the storage credential can write, not merely list", () => {
    // A list-only policy passes `mc ls` while every evidence upload is denied
    // (verified against MinIO), so readiness must exercise the operations the
    // application actually performs. `set -e` turns a failed probe into a
    // non-zero exit, which the app's depends_on condition then blocks on.
    const script = String(compose.services["storage-init"].command);
    expect(script).toContain("set -eu");
    expect(script).toContain("mc pipe");
    expect(script).toContain("mc cat");
    expect(script).toContain("mc rm");
    // The policy write itself must not be swallowed: a tolerated failure is how
    // a stale, more-restrictive policy survives into a new deployment. Asserting
    // the positive form also rules out a `|| true` creeping back onto that line.
    expect(script).toContain('mc admin policy create root reconcileai-app "$${pol}" 2>/dev/null || mc admin policy add');
  });

  it("should detach stale policies without revoking a credential the app is using", () => {
    // `mc admin policy attach` is additive with no replace form, so a key reused
    // across deployments keeps every binding it ever had. Removing and re-adding
    // the user fixes that and ALSO revokes the credential a running app holds —
    // `compose up -d` runs this while the app is still serving. Detaching the
    // extras reaches the same end state with no outage.
    const script = String(compose.services["storage-init"].command);
    expect(script).toContain("mc admin policy detach root");
    // Destroying the identity is opt-in, because it is the only way mc can
    // change a secret and it always interrupts whoever is holding the old one.
    expect(script).toContain("MINIO_APP_ROTATE");
    const removeAt = script.indexOf("mc admin user remove root");
    const rotateGuardAt = script.indexOf('"$${MINIO_APP_ROTATE:-false}" = "true"');
    expect(rotateGuardAt).toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(rotateGuardAt);
  });

  it("should prove the credential cannot reach another bucket, not just its own", () => {
    // Every other check passes just as happily for a credential that can also
    // reach every other bucket, so least privilege needs a denial test or it is
    // only an assertion. Verified against MinIO: a readwrite credential trips it.
    const script = String(compose.services["storage-init"].command);
    expect(script).toContain("reconcileai-scope-probe");
    expect(script).toContain("reaches beyond");
    // Cleanup must happen before the verdict, or a failure strands the probe
    // bucket and the reserved-name guard blocks every later run.
    const cleanupAt = script.indexOf("mc rb --force");
    const verdictAt = script.indexOf('if [ "$${cross_read}" = yes ]');
    expect(cleanupAt).toBeGreaterThan(-1);
    expect(verdictAt).toBeGreaterThan(cleanupAt);
  });

  it("should wait for storage to be provisioned before the app accepts traffic", () => {
    expect(compose.services.app.depends_on?.["storage-init"]?.condition).toBe("service_completed_successfully");
    expect(compose.services.gateway.depends_on?.app?.condition).toBe("service_healthy");
  });

  it("should deny privilege escalation in every container", () => {
    for (const [name, service] of Object.entries(compose.services)) {
      expect(service.security_opt ?? [], `${name} must set no-new-privileges`).toContain("no-new-privileges:true");
    }
  });

  it("should enforce data residency and allowlist only in-stack hosts", () => {
    const appEnv = compose.services.app.environment ?? {};
    expect(appEnv.DEPLOYMENT_MODE).toBe("on_premise");
    const allowlist = String(appEnv.EGRESS_ALLOWLIST).split(",");
    expect(allowlist).toContain(modelService);
    expect(allowlist).toContain("minio");
    // Anything with a dot is a real hostname, i.e. something off-box.
    for (const host of allowlist) expect(host).not.toContain(".");
  });
});

describe("CPU profile — verified offline model import", () => {
  const raw = readOnPrem("docker-compose.cpu.yml");
  const compose = parse(raw) as ComposeFile;
  const modelInit = compose.services["model-init"];
  const script = String(modelInit.command);

  it("should hold the app back until the model has been imported successfully", () => {
    // model-init has `restart: "no"`, so a failed verification exits non-zero,
    // this condition is never met, and the stack stops rather than serving a
    // deployment whose configured model does not exist.
    expect(compose.services.app.depends_on?.["model-init"]?.condition).toBe("service_completed_successfully");
    expect(modelInit.restart).toBe("no");
  });

  it("should verify the artifact against a digest supplied out of band, not only the shipped manifest", () => {
    // SHA256SUMS travels with the GGUF: whoever can swap one can rewrite the
    // other. RECON_MODEL_SHA256 comes from the signed release record instead.
    expect(script).toContain("sha256sum -c SHA256SUMS");
    expect(script).toContain("RECON_MODEL_SHA256:?");
    expect(script).toContain("REFUSING IMPORT");
    expect(modelInit.environment?.RECON_MODEL_SHA256).toBe("${RECON_MODEL_SHA256:-}");
  });

  it("should authenticate the Modelfile, not only the weights", () => {
    // The Modelfile carries the SYSTEM prompt, the decoding parameters and the
    // FROM that selects the weights. Verifying only the GGUF left the more
    // consequential file unauthenticated: an attacker who cannot alter the
    // approved weights can swap this and regenerate the co-delivered
    // SHA256SUMS, rewriting the instructions a bank's analyst runs under while
    // every other check still passes. Verified against the real script.
    expect(script).toContain("RECON_MODELFILE_SHA256:?");
    expect(script).toContain("sha256sum Modelfile");
    expect(modelInit.environment?.RECON_MODELFILE_SHA256).toBe("${RECON_MODELFILE_SHA256:-}");
    // And the approved Modelfile must load the artifact just verified.
    expect(script).toContain("Modelfile FROM is");
  });

  it("should select the import branch at run time so the demo path still parses", () => {
    // Compose interpolates every `${VAR:?}` in the file regardless of the shell
    // `if`, so a required-value marker written inline would break `pull` mode
    // too. Mode and model therefore arrive as container environment.
    expect(modelInit.environment?.OLLAMA_MODEL_MODE).toBe("${OLLAMA_MODEL_MODE:-pull}");
    expect(script).toContain('"$${OLLAMA_MODEL_MODE}" != "import"');
    // `$${VAR:?}` is the shell's own check inside the import branch and is fine.
    // A bare `${VAR:?}` is Compose's, evaluated for every mode — that is the bug.
    expect(raw).not.toMatch(/(?<!\$)\$\{RECON_MODEL:\?/);
    expect(script).toContain('$${RECON_MODEL:?');
  });

  it("should import the model file the Modelfile actually references", () => {
    const modelfile = readOnPrem(path.join("models", "Modelfile"));
    const from = /^FROM\s+\.\/(\S+)\s*$/m.exec(modelfile);
    expect(from, "Modelfile must FROM a relative GGUF path").not.toBeNull();
    expect(modelInit.environment?.RECON_MODEL_FILE).toBe(`\${RECON_MODEL_FILE:-${from![1]}}`);
  });
});

describe("GPU profile — private authenticated serving", () => {
  const compose = parse(readOnPrem("docker-compose.gpu.yml")) as ComposeFile;
  const vllm = compose.services.vllm;

  it("should authenticate the app to vLLM without putting the key in argv", () => {
    // `--api-key <secret>` lands in the container's command line, where
    // `docker inspect` and `docker top` expose it. vLLM reads VLLM_API_KEY.
    expect(vllm.environment?.VLLM_API_KEY).toContain("VLLM_API_KEY:?");
    expect(String(vllm.command)).not.toContain("--api-key");
    expect(compose.services.app.environment?.DIRECT_LLM_API_KEY).toContain("VLLM_API_KEY:?");
  });

  it("should require an approved immutable revision and suppress request-content logging", () => {
    expect(String(vllm.command)).toContain("--revision ${MODEL_REVISION:?");
    expect(String(vllm.command)).toContain("--disable-log-requests");
  });

  it("should serve staged weights rather than fetching them at start-up", () => {
    expect(vllm.environment?.HF_HUB_OFFLINE).toBe("${HF_HUB_OFFLINE:-1}");
  });

  it("should refuse to start when the approved weights were never staged", () => {
    // vllm is air-gapped (internal network + HF_HUB_OFFLINE), so an empty cache
    // cannot resolve itself. Without this gate it starts, never goes healthy,
    // and `app` waits on it forever with nothing naming the real cause.
    const check = compose.services["model-check"];
    expect(check, "GPU profile must verify staged weights before vllm starts").toBeDefined();
    expect(check.restart).toBe("no");
    expect(vllm.depends_on?.["model-check"]?.condition).toBe("service_completed_successfully");

    const script = String(check.command);
    expect(script).toContain("set -eu");
    expect(script).toContain("REFUSING TO START");
    // Mounted read-only: a verification step must not be able to alter what it
    // verifies, and it has no reason to write.
    expect(check.volumes).toContain("hf-cache:/root/.cache/huggingface:ro");
    // A directory alone is not weights — an interrupted copy leaves one behind.
    expect(script).toContain("safetensors");
  });
});

describe("model packaging", () => {
  it("should merge an adapter only onto its declared base and record provenance", () => {
    const mergeScript = fs.readFileSync(path.join(ROOT, "ml", "merge_adapter.py"), "utf8");
    expect(mergeScript).toContain("Adapter base model mismatch");
    expect(mergeScript).toContain("MODEL_PROVENANCE.json");
    expect(mergeScript).toContain("synthetic-only training adapter");
    expect(mergeScript).toContain("safe_serialization=True");
  });

  it("should keep model artifacts and training code out of the application image", () => {
    const dockerIgnore = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8");
    expect(dockerIgnore).toContain("deploy/on-prem/models/");
    expect(dockerIgnore).toContain("ml/");
    // The build patches a dependency before `COPY . .`, so patches/ must survive.
    expect(dockerIgnore).not.toMatch(/^patches\/?$/m);
  });
});
