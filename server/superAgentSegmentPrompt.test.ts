/**
 * What the Super Agent is actually told, per vertical — BEHAVIOURAL evidence.
 *
 * The taxonomy tests next door prove the catalogue exists and is selected by
 * segment. They cannot prove it reaches the model: the prompt is assembled
 * inside `getLLMDiagnosis`, which is not exported. So this mocks the transport
 * and reads the system message that was actually sent.
 *
 * The defect being closed: a corporate_b2b tenant — an FMCG manufacturer — was
 * diagnosed under a persona describing itself as a Nigerian payment-systems
 * expert, given the NIP/POS/ATM channel catalogue, and instructed to "reference
 * relevant Nigerian banking regulations (CBN circulars, NIBSS rules)". The
 * go-live plan's first launch geography is Uganda.
 *
 * Every assertion is paired with its opposite, so a test cannot pass because
 * the prompt is empty or the code path never ran.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeLLM = vi.fn(async () => ({
  choices: [{ message: { content: JSON.stringify({ headline: "h", rootCause: "r", recommendedAction: "a" }) } }],
}));
vi.mock("./_core/llm", () => ({ invokeLLM: (...a: unknown[]) => invokeLLM(...(a as [])) }));

import type { SATransaction } from "./superAgentEngine";

const { diagnoseException } = await import("./superAgentEngine");

/** A distributor remittance short by a promotional deduction — the FMCG case. */
const receipt = {
  id: 1,
  transactionRef: "INV-2847 less promo",
  description: "MOMO COLLECTION KAMPALA DIST less promo allowance",
  counterparty: "Kampala Distributors Ltd",
  amount: "950000.00",
  currency: "UGX",
  transactionDate: new Date("2026-08-14T09:00:00Z"),
  channelId: 3,
  channelType: "mobile_money",
  debitCredit: "credit",
} as SATransaction;

const config = { amountTolerance: 0.015, dateWindowDays: 7 };

async function systemPromptFor(institution: Record<string, unknown>): Promise<string> {
  invokeLLM.mockClear();
  await diagnoseException(receipt, [], config, "", institution as never);
  expect(invokeLLM, "the model was never called, so this proves nothing").toHaveBeenCalledTimes(1);
  const call = invokeLLM.mock.calls[0][0] as unknown as { messages: Array<{ role: string; content: string }> };
  const system = call.messages.find((m) => m.role === "system");
  expect(system).toBeDefined();
  return system!.content;
}

beforeEach(() => invokeLLM.mockClear());

describe("when the tenant is an FMCG manufacturer", () => {
  it("should brief a receivables and trade-spend controller, not a payment-systems expert", async () => {
    const prompt = await systemPromptFor({ segment: "corporate_b2b", country: "uganda" });
    expect(prompt).toMatch(/receivables and trade-spend controller/i);
    expect(prompt).not.toMatch(/NIBSS/);
  });

  it("should replace the bank channel catalogue rather than adding to it", async () => {
    // Supplementing does not help: it invites the model to explain a
    // distributor's promotional claw-back as a switch failure.
    const prompt = await systemPromptFor({ segment: "corporate_b2b", country: "uganda" });
    expect(prompt).toMatch(/CATALOGUED FMCG DISTRIBUTOR EXCEPTION PATTERNS/);
    expect(prompt).not.toMatch(/CATALOGUED NIGERIAN CHANNEL EXCEPTION PATTERNS/);
    expect(prompt).toMatch(/b2b_promotional_deduction_unapproved/);
  });

  it("should cite the pilot country's revenue authority and no other", async () => {
    const uganda = await systemPromptFor({ segment: "corporate_b2b", country: "uganda" });
    expect(uganda).toMatch(/Uganda Revenue Authority/);
    expect(uganda).not.toMatch(/\bCBN\b|Federal Inland Revenue/);

    const nigeria = await systemPromptFor({ segment: "corporate_b2b", country: "nigeria" });
    expect(nigeria).toMatch(/Federal Inland Revenue Service/);
    expect(nigeria).not.toMatch(/Uganda Revenue Authority/);
  });

  it("should state the read-only boundary so no recommendation reads as an action taken", async () => {
    const prompt = await systemPromptFor({ segment: "corporate_b2b", country: "nigeria" });
    expect(prompt).toMatch(/read-only in this pilot/i);
    expect(prompt).toMatch(/PROPOSAL/);
  });
});

describe("when the tenant is a bank", () => {
  // The control for every assertion above: the Nigerian framing is not removed
  // from the product, it is scoped to the tenants it describes.
  it("should keep the Nigerian payment-systems persona and channel catalogue", async () => {
    const prompt = await systemPromptFor({ segment: "financial_services", bankingModel: null });
    expect(prompt).toMatch(/NIBSS/);
    expect(prompt).not.toMatch(/CATALOGUED FMCG DISTRIBUTOR EXCEPTION PATTERNS/);
    expect(prompt).not.toMatch(/receivables and trade-spend controller/i);
  });

  it("should default to the bank framing when the segment is unknown", async () => {
    // Unknown segment must not silently become Corporate B2B; the FMCG frame
    // asserts things about the tenant (not a licensed bank, read-only pilot)
    // that would be false for an unclassified one.
    const prompt = await systemPromptFor({});
    expect(prompt).not.toMatch(/CATALOGUED FMCG DISTRIBUTOR EXCEPTION PATTERNS/);
    expect(prompt).toMatch(/NIBSS/);
  });
});
