/**
 * The settlement-file preview, driven through the real procedure.
 *
 * A row whose description says refund while its amount is positive is booked
 * as money received — the sign decides direction, not the words. The preview is
 * where the merchant is told, so this pins that the count reaches the response
 * a merchant's check actually gets, and that a check writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb, type ScriptedDb } from "./connectors/shopify/scriptedDb.testkit";

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getDb: vi.fn(),
  createUploadBatch: vi.fn(),
  updateUploadBatch: vi.fn(),
}));

import { getDb } from "./db";
import { router } from "./_core/trpc";
import { shoplineSettlementImportProcedures } from "./routers/shoplineSettlementImport";

const ORG = 60001;
const caller = router({ ...shoplineSettlementImportProcedures }).createCaller({
  user: { id: 7, role: "admin", organizationId: ORG, email: "merchant@example.com" },
  viewingAs: null,
  req: { headers: {}, ip: "127.0.0.1" },
  res: { cookie: () => {}, clearCookie: () => {} },
} as never);

let fake: ScriptedDb;
beforeEach(() => {
  fake = scriptedDb({
    standing: {
      sl_connector_stores: [{ id: 42, organizationId: ORG, status: "active", storeHandle: "reconcileai-dev", currency: "USD" }],
    },
  });
  vi.mocked(getDb).mockResolvedValue(fake.db as never);
});

const check = (content: string, columnMapping: Record<string, string>) =>
  caller.importSettlementFile({ fileName: "payouts.csv", content, sourceLabel: "Stripe", columnMapping, dryRun: true });

describe("when a merchant checks a file whose words and signs disagree", () => {
  const file = [
    "Order ID,Net,Memo",
    "1001,10.00,Paid by Jane Doe",
    "1002,5.00,Refund issued",
    "1003,-5.00,Refund issued",
    "1004,7.00,Chargeback reversal",
  ].join("\n");

  it("should count the positive rows described as refunds or reversals, and only those", async () => {
    const preview = await check(file, { orderRef: "Order ID", amount: "Net", description: "Memo" });

    expect(preview.dryRun).toBe(true);
    // 1002 (a positive "refund") and 1004 (a positive "chargeback reversal" — a
    // real credit, which is why the count warns rather than re-signs). 1003 is
    // already negative; 1001 carries no reversal word.
    expect(preview.positiveRowsReadingAsReversals).toBe(2);
  });

  it("should count nothing when no description column is mapped", async () => {
    const preview = await check(file, { orderRef: "Order ID", amount: "Net" });
    expect(preview.positiveRowsReadingAsReversals).toBe(0);
  });

  it("should write nothing while checking", async () => {
    await check(file, { orderRef: "Order ID", amount: "Net", description: "Memo" });
    expect(fake.ops.filter((op) => op.kind !== "select")).toEqual([]);
  });
});
