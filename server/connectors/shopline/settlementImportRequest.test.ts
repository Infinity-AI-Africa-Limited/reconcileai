import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";
import { settlementImportFailure } from "./settlementImportRequest";

/** TiDB refusing a transaction as too large, as drizzle hands it back: the driver error is the cause. */
function tidbTransactionTooLarge() {
  return Object.assign(new Error("Failed query: insert into `transactions` … params: …"), {
    cause: Object.assign(new Error("Transaction is too large, size: 104857600"), { errno: 8004 }),
  });
}

describe("when a settlement import fails", () => {
  it("should tell the merchant to split a file too large for one transaction, not to try again", () => {
    const failure = settlementImportFailure(tidbTransactionTooLarge());

    expect(failure.error).toBeInstanceOf(TRPCError);
    expect((failure.error as TRPCError).code).toBe("PAYLOAD_TOO_LARGE");
    expect(failure.batchMessage).toMatch(/split it by date range/);
    expect(failure.batchMessage).not.toMatch(/try again/i);
    expect(failure.batchMessage).not.toMatch(/Failed query|insert into/);
  });

  it("should pass a refusal the import already worded straight through", () => {
    const refusal = new TRPCError({ code: "PRECONDITION_FAILED", message: "No active SHOPLINE store for this organisation" });
    expect(settlementImportFailure(refusal)).toEqual({ error: refusal, batchMessage: refusal.message });
  });

  it("should say nothing was written for anything else, never the database's own text", () => {
    const failure = settlementImportFailure(new Error("Failed query: select … params: owner@merchant.com"));
    expect(failure.batchMessage).toBe("The import failed and nothing was written. Try again.");
  });
});
