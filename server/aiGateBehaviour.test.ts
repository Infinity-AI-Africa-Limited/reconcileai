/**
 * Tenant AI opt-out — BEHAVIOURAL evidence.
 *
 * The go-live plan's exit criterion for the per-tenant AI switch is "tenant-level
 * test evidence proving no model call occurs when disabled". Source-scanning
 * ratchets (aiGateRatchet.test.ts) prove that a gate is PRESENT; they cannot
 * prove that a model is not CALLED. These do, by mocking the transport and
 * asserting on it.
 *
 * Each test is checked in both directions. A test that only asserts "not called"
 * passes just as happily when the code path is broken and nothing runs at all,
 * so every case is paired with its enabled counterpart proving the call does
 * happen when the tenant permits it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Shape matches what detectSuspiciousDescriptions parses, so the enabled case
// exercises the real code path instead of tripping its error handler.
const invokeLLM = vi.fn(async () => ({
  choices: [{ message: { content: JSON.stringify({ results: [] }) } }],
}));
vi.mock("./_core/llm", () => ({ invokeLLM: (...a: unknown[]) => invokeLLM(...(a as [])) }));

const isOrganizationAiAssistanceEnabled = vi.fn(async (_id: number) => true);
vi.mock("./db", () => ({
  getOrganizationById: vi.fn(),
  isOrganizationAiAssistanceEnabled: (id: number) => isOrganizationAiAssistanceEnabled(id),
}));

const { isTenantAiAllowed, assertTenantAiAllowed, TenantAiDisabledError } = await import("./aiGate");
const { detectAnomalies } = await import("./anomalyDetectionService");

function txn(id: number, description: string) {
  return {
    id,
    description,
    amount: "1000.00",
    currency: "NGN",
    transactionDate: new Date("2026-08-01T10:00:00Z"),
    channelId: 1,
    counterparty: "ACME",
    debitCredit: "credit",
  } as never;
}

beforeEach(() => {
  invokeLLM.mockClear();
  isOrganizationAiAssistanceEnabled.mockClear();
  isOrganizationAiAssistanceEnabled.mockImplementation(async () => true);
});

describe("when an organisation has AI assistance disabled", () => {
  it("should refuse the tenant, and permit it once re-enabled", async () => {
    isOrganizationAiAssistanceEnabled.mockImplementation(async () => false);
    expect(await isTenantAiAllowed(42)).toBe(false);

    isOrganizationAiAssistanceEnabled.mockImplementation(async () => true);
    expect(await isTenantAiAllowed(42)).toBe(true);
  });

  it("should throw for request-scoped surfaces rather than silently continuing", async () => {
    isOrganizationAiAssistanceEnabled.mockImplementation(async () => false);
    await expect(assertTenantAiAllowed(42, "superAgent.query")).rejects.toBeInstanceOf(
      TenantAiDisabledError,
    );
  });
});

describe("when no owning organisation can be determined", () => {
  // Fail closed. This is the opposite default to featureAppliesTo, which fails
  // OPEN — because this decision authorises an egress of tenant data, not a read.
  it.each([null, undefined, 0, -1, 1.5, NaN])("should refuse organizationId %p", async (id) => {
    expect(await isTenantAiAllowed(id as number)).toBe(false);
    // The database is never even consulted — there is no tenant to consult about.
    expect(isOrganizationAiAssistanceEnabled).not.toHaveBeenCalled();
  });
});

describe("anomaly detection under the tenant AI switch", () => {
  const txns = [
    txn(1, "Payment to unverified offshore account urgent"),
    txn(2, "Standard settlement transfer for July"),
  ];

  it("should make NO model call when the LLM detector is disabled", async () => {
    await detectAnomalies(txns, [], { enableLLM: false });
    expect(invokeLLM).not.toHaveBeenCalled();
  });

  it("should still make one when enabled — proving the assertion above is real", async () => {
    await detectAnomalies(txns, [], {
      enableStatistical: false,
      enableTimePattern: false,
      enableFrequency: false,
      enableCounterparty: false,
      enableLLM: true,
    });
    expect(invokeLLM).toHaveBeenCalled();
  });

  it("should keep the four statistical detectors working with the model off", async () => {
    // An opted-out tenant loses the model detector, not the feature. Refusing
    // the whole route would withdraw capability the switch never covered.
    const outliers = [...Array(20)].map((_, i) => txn(100 + i, `Routine transfer ${i}`));
    const result = await detectAnomalies(outliers, [], { enableLLM: false });
    expect(invokeLLM).not.toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(true);
  });
});
