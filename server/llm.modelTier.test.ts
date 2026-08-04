/**
 * Model-tier split — general work vs genuinely agentic work.
 *
 * CLAUDE.md §4 specifies a stronger model for the Super Agent than for
 * classification, narrative and report generation. Every call previously went
 * through one `DIRECT_LLM_MODEL`, so the table was aspirational.
 *
 * Two failure modes are worth pinning, because both are silent:
 *
 *   - the agent tier quietly falling back to nothing sensible, or worse,
 *     promoting EVERY call to the expensive model because a deploy landed;
 *   - a non-agentic call site acquiring `modelTier: "agent"` by copy-paste,
 *     turning a 100-word anomaly summary into a Super Agent invocation.
 *
 * ENV is a frozen snapshot taken at import, so the variables must be set via
 * vi.hoisted — setting process.env in beforeEach is too late and every case
 * would assert against the wrong config while still passing.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.hoisted(() => {
  process.env.DIRECT_LLM_API_KEY = "sk-ant-test-key";
  process.env.DIRECT_LLM_API_URL = "https://api.anthropic.com";
  process.env.DIRECT_LLM_MODEL = "claude-sonnet-5";
  process.env.DIRECT_LLM_PROVIDER = "anthropic";
  // Deliberately NOT setting DIRECT_LLM_MODEL_AGENT — the default case.
  delete process.env.DIRECT_LLM_MODEL_AGENT;
});

vi.mock("../server/db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));

import { getLlmProviderInfo, buildAnthropicPayload } from "./_core/llm";

describe("agent tier falls back rather than promoting by default", () => {
  it("uses the general model when DIRECT_LLM_MODEL_AGENT is unset", () => {
    const info = getLlmProviderInfo();
    expect(info.model).toBe("claude-sonnet-5");
    // The whole point of the fallback: merging the split must not silently move
    // every Super Agent call onto a pricier model without the operator opting in.
    expect(info.agentModel).toBe("claude-sonnet-5");
  });

  it("reports whether the agent tier was actually configured", () => {
    // `agentModel === model` is ambiguous on its own — it could mean "set to the
    // same value deliberately" or "never set". This distinguishes them.
    expect(getLlmProviderInfo().agentModelConfigured).toBe(false);
  });
});

describe("the tier never leaks into the provider payload", () => {
  it("buildAnthropicPayload emits no modelTier field", () => {
    const { payload } = buildAnthropicPayload(
      { modelTier: "agent", messages: [{ role: "user", content: "hi" }] },
      "claude-opus-4-8",
    );
    // The payload is built from named fields, never spread from params — a
    // stray key would be rejected by the Messages API at runtime, not compile time.
    expect(payload).not.toHaveProperty("modelTier");
    expect(payload.model).toBe("claude-opus-4-8");
  });
});

/**
 * Which call sites are allowed to ask for the strong model.
 *
 * Asserted against the source rather than at runtime: the risk is a new call
 * site copying `modelTier: "agent"` from a neighbour, and that is a property of
 * the code, not of any single execution.
 */
describe("only genuinely agentic call sites request the agent tier", () => {
  const SERVER = path.join(__dirname);
  const ALLOWED = new Set([
    "superAgentEngine.ts", // Super Agent diagnosis + action drafting
    "routers.ts",          // superAgent.query — the conversational surface
    "_core/llm.ts",        // the definition itself
  ]);

  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) acc.push(p);
    }
    return acc;
  };

  it("no unexpected file asks for modelTier: \"agent\"", () => {
    const offenders = walk(SERVER)
      .filter((f) => /modelTier:\s*['"]agent['"]/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SERVER, f).split(path.sep).join("/"))
      .filter((rel) => !ALLOWED.has(rel));

    expect(
      offenders,
      `These files request the agent model tier but are not on the allow-list: ` +
        `${offenders.join(", ")}. The strong model is for multi-step reasoning, ` +
        `action drafting and conversation — not classification or narrative ` +
        `generation, which CLAUDE.md §4 assigns to the general model. If the new ` +
        `site is genuinely agentic, add it to ALLOWED with a reason.`,
    ).toEqual([]);
  });

  it("the known agentic sites still request it, so the sweep is not vacuous", () => {
    const sae = fs.readFileSync(path.join(SERVER, "superAgentEngine.ts"), "utf8");
    // Diagnosis and action drafting.
    expect([...sae.matchAll(/modelTier:\s*"agent"/g)].length).toBe(2);
    const routers = fs.readFileSync(path.join(SERVER, "routers.ts"), "utf8");
    expect(routers).toMatch(/modelTier:\s*'agent'/);
  });
});
