/**
 * Tenant AI-boundary ratchet.
 *
 * `organizations.aiAssistanceEnabled` shipped guarding exactly ONE of the
 * platform's model entry points — the deferred analysis pass — while four
 * org-scoped surfaces kept sending tenant exceptions, transactions and learned
 * resolution history to `invokeLLM` after the institution had opted out. A
 * control honoured on one path and not the others is not a control.
 *
 * Reviewing this by eye does not scale: `invokeLLM` has call sites across eight
 * modules and the org-scoped ones are not visually distinct from the demo ones.
 * So the inventory is asserted instead. Adding a model call in a new file fails
 * this test until someone states, here, whether that surface is tenant-scoped.
 *
 * Sibling of readScopeRatchet / tenancyRatchet, and the same rule applies: keep
 * the exempt list SHORT, and give every entry a reason rather than a name.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SERVER = __dirname;

/**
 * Symbols that reach a model — `invokeLLM` itself plus the exported helpers
 * that wrap it. Scanning for `invokeLLM` ALONE is not enough and the omission
 * is not theoretical: the public API endpoint reaches Claude through
 * `getAIAnalysis` and contains no `invokeLLM` call of its own, so an
 * invokeLLM-only scan reported it as not a model surface at all.
 */
const MODEL_REACHING_SYMBOLS = [
  "invokeLLM",
  "getAIAnalysis",
  "diagnoseException",
  "generateActionDraft",
  "detectAnomalies",
  "generateMmAiSummary",
];

const MODEL_REACHING_RE = new RegExp("(" + MODEL_REACHING_SYMBOLS.join("|") + ")[ ]*[(]");
const MODEL_REACHING_RE_GLOBAL = new RegExp("(" + MODEL_REACHING_SYMBOLS.join("|") + ")[ ]*[(]", "g");

/**
 * Every server module that reaches a model, and its tenancy classification.
 *
 * "gated"  — org-scoped; must consult server/aiGate.ts before building or
 *            sending context.
 * "exempt" — no owning organisation exists on this path, so the tenant switch
 *            has nothing to read. Gating it on a fail-closed rule would simply
 *            switch the surface off.
 */
const MODEL_REACHING_FILES: Record<string, { tenancy: "gated" | "exempt"; why: string }> = {
  "routers.ts": {
    tenancy: "gated",
    why: "superAgent.query / superAgent.diagnose / anomalies.detect / deferred AI pass — all org-scoped",
  },
  "api/gateway.ts": {
    tenancy: "gated",
    why: "public API diagnose endpoint; the API key's organisation is the tenant",
  },
  "reconciliationEngine.ts": {
    tenancy: "exempt",
    why: "defines getAIAnalysis, a pure helper with no org argument — every caller gates before invoking it",
  },
  "superAgentEngine.ts": {
    tenancy: "exempt",
    why: "diagnoseException / generateActionDraft are pure helpers; the calling procedure gates",
  },
  "anomalyDetectionService.ts": {
    tenancy: "exempt",
    why: "detectSuspiciousDescriptions runs only when the caller passes enableLLM, which anomalies.detect clears for opted-out tenants",
  },
  "poc-engine.ts": {
    tenancy: "exempt",
    why: "public POC/demo pages run on fixtures with no owning organisation",
  },
  "mobileMoney-engine.ts": {
    tenancy: "exempt",
    why: "mobile-money POC surface, keyed by pocKey rather than a tenant",
  },
  "woodcore-engine.ts": {
    tenancy: "exempt",
    why: "Woodcore POC engine — demo tenant, no organizations row drives it",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "content") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("every model entry point is classified for tenant AI opt-out", () => {
  it("no server module reaches a model without being listed here", () => {
    const found = walk(SERVER)
      .filter((f) => {
        // _core/llm.ts DEFINES invokeLLM; it is the transport, not an entry point.
        if (f.endsWith(path.join("_core", "llm.ts"))) return false;
        return MODEL_REACHING_RE.test(fs.readFileSync(f, "utf8"));
      })
      .map((f) => path.relative(SERVER, f).split(path.sep).join("/"))
      .sort();

    expect(found).toEqual(Object.keys(MODEL_REACHING_FILES).sort());
  });
});

describe("when a tenant has switched AI assistance off", () => {
  const routers = fs.readFileSync(path.join(SERVER, "routers.ts"), "utf8");
  const gateway = fs.readFileSync(path.join(SERVER, "api", "gateway.ts"), "utf8");
  const aiGate = fs.readFileSync(path.join(SERVER, "aiGate.ts"), "utf8");

  it("should refuse the Super Agent conversational surface before its context is read", () => {
    const gate = routers.indexOf('assertTenantAiAllowedForRequest(orgId, "superAgent.query")');
    const firstRead = routers.indexOf("db.getExceptions({ organizationId: ctx.user.organizationId ?? null, status: 'open'");
    expect(gate).toBeGreaterThan(-1);
    // The opt-out covers READING the tenant's operational data to feed a model,
    // not merely the network call at the end of the procedure.
    expect(firstRead).toBeGreaterThan(gate);
  });

  it("should refuse the Super Agent diagnose surface before its context is read", () => {
    const gate = routers.indexOf('assertTenantAiAllowedForRequest(ctx.user.organizationId, "superAgent.diagnose")');
    expect(gate).toBeGreaterThan(-1);
    expect(routers.indexOf("const diagnosis = await diagnoseException(")).toBeGreaterThan(gate);
  });

  it("should drop only the model detector from anomaly detection, keeping the statistical ones", () => {
    expect(routers).toContain("anomalyConfig.enableLLM = false");
    // Refusing the whole route would withdraw z-score, IQR, time-pattern and
    // counterparty detection, none of which send anything to a model.
    expect(routers).toContain("const anomalyConfig = { ...(input.config as AnomalyDetectionConfig) }");
  });

  it("should refuse the public API diagnose endpoint", () => {
    expect(gateway).toContain('sendError(res, 403, "AI_ASSISTANCE_DISABLED"');
    const gate = gateway.indexOf("isTenantAiAllowed(req.apiAuth?.organizationId)");
    const call = gateway.indexOf("const analysis = await getAIAnalysis(");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
  });

  it("should skip the deferred background pass quietly rather than raising", () => {
    const gate = routers.indexOf("isTenantAiAllowed(tenantId)");
    const pendingLookup = routers.indexOf("getJobExceptionsNeedingAi(jobId, tenantId)");
    expect(gate).toBeGreaterThan(-1);
    expect(pendingLookup).toBeGreaterThan(gate);
  });

  it("should fail closed when no owning organisation can be determined", () => {
    // The opposite default to featureAppliesTo (which fails OPEN): this
    // authorises an egress of tenant data, so ambiguity must refuse.
    expect(aiGate).toContain("if (orgId === null) return false;");
    expect(aiGate).toContain("if (orgId === null) throw new TenantAiDisabledError(null, surface);");
  });
});

/**
 * Per-CALL-SITE check.
 *
 * The inventory test above proves which FILES reach a model. That is not the
 * same invariant, and the difference was a live bug: `routers.ts` was correctly
 * classified "gated" on the strength of four gated surfaces while a fifth
 * `invokeLLM` — the public compliance-assessment narrative — sat ungated in the
 * same file. A file-level ratchet can never see that.
 *
 * So this walks every model-reaching call in routers.ts back to its enclosing
 * tRPC procedure and requires a gate between the two.
 */
describe("every model call site inside routers.ts sits behind a gate", () => {
  const ROUTERS = fs.readFileSync(path.join(SERVER, "routers.ts"), "utf8");

  /** Tokens that constitute a gate for the procedure they appear in. */
  const GATES = ["assertTenantAiAllowedForRequest(", "isTenantAiAllowed("];

  /**
   * Procedures allowed to reach a model with no tenant gate, and why. Every
   * entry is a surface where no owning organisation exists to consult.
   */
  const EXEMPT: Record<string, string> = {
    "runFullPOC": "Woodcore POC engine — the procedure takes no ctx and is keyed by product config, not a tenant",
  };

  function enclosingProcedure(index: number): string {
    // Nearest preceding `name: xxxProcedure` declaration, or the nearest
    // preceding top-level function for the background passes.
    const before = ROUTERS.slice(0, index);
    const proc = [...before.matchAll(/(\w+)\s*:\s*\w*[Pp]rocedure/g)].pop();
    const fn = [...before.matchAll(/^async function (\w+)/gm)].pop();
    const procAt = proc ? proc.index ?? -1 : -1;
    const fnAt = fn ? fn.index ?? -1 : -1;
    return procAt >= fnAt ? (proc ? proc[1] : "<unknown>") : (fn ? fn[1] : "<unknown>");
  }

  it("has no ungated model call in routers.ts", () => {
    const offenders: string[] = [];
    for (const m of ROUTERS.matchAll(MODEL_REACHING_RE_GLOBAL)) {
      const at = m.index ?? 0;
      const owner = enclosingProcedure(at);
      if (owner in EXEMPT) continue;

      // Search back to the start of the enclosing procedure/function only, so a
      // gate on an EARLIER procedure cannot vouch for this one.
      const before = ROUTERS.slice(0, at);
      const ownerAt = Math.max(
        before.lastIndexOf(owner + ":"),
        before.lastIndexOf("async function " + owner),
      );
      const body = ROUTERS.slice(ownerAt < 0 ? 0 : ownerAt, at);
      if (!GATES.some((g) => body.includes(g))) {
        const line = before.split(String.fromCharCode(10)).length;
        offenders.push(`${owner} (routers.ts:${line}) reaches a model with no tenant gate`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
