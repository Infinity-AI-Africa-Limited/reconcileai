/**
 * Settlement-file import — reconcile against any payment system.
 *
 * The contract that matters most is the JOIN KEY. The retail engine matches the
 * orders channel to the payments channel on `transactionRef`, where the orders
 * side holds the SHOPLINE order id. If an imported settlement row put the
 * GATEWAY's id there instead, the file would import cleanly, report success, and
 * match nothing — a failure that looks like a working feature. Several tests
 * below exist purely to pin that down.
 */
import { describe, it, expect } from "vitest";
import {
  parseSettlementFile,
  detectColumns,
  parseAmount,
  parseDate,
  mapSettlementRows,
  normalizeHeader,
  REQUIRED_FIELDS,
  type ColumnMap,
} from "./connectors/shopline/settlementFileImport";

const ctx = {
  organizationId: 60001,
  paymentsChannelId: 300002,
  batchId: 999,
  userId: 0,
  defaultCurrency: "USD",
  sourceLabel: "Stripe payouts",
};

describe("normalizeHeader", () => {
  it("lowercases, strips quotes and collapses whitespace", () => {
    expect(normalizeHeader('  "Order Number" ')).toBe("order_number");
  });
});

describe("parseAmount — real-world money strings", () => {
  it.each([
    ["1234.56", 1234.56],
    ["1,234.56", 1234.56],
    ["$1,234.56", 1234.56],
    ["₦ 12,000", 12000],
    ["1.234,56", 1234.56], // European
    ["(12.30)", -12.3], // accounting negative
    ["-45.00", -45],
    ["0", 0],
    ["12,000", 12000],      // thousands, NOT European 12.000
    ["12,30", 12.3],        // European decimal (1-2 digit tail)
    ["1.234.567", 1234567], // European grouping
    ["1,234,567.89", 1234567.89],
  ])("parses %s", (raw, expected) => {
    expect(parseAmount(raw)).toBeCloseTo(expected, 2);
  });

  it.each(["", "   ", "n/a", undefined])("rejects %s", (raw) => {
    expect(parseAmount(raw as string | undefined)).toBeNull();
  });
});

describe("parseDate", () => {
  it("accepts ISO and common exports", () => {
    expect(parseDate("2026-08-02T10:00:00Z")?.toISOString()).toBe("2026-08-02T10:00:00.000Z");
    expect(parseDate("2026-08-02")).toBeInstanceOf(Date);
  });
  it("returns null for junk rather than an Invalid Date", () => {
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate("")).toBeNull();
  });
});

describe("detectColumns", () => {
  it("maps a Stripe-style payout export", () => {
    const { mapping, missingRequired } = detectColumns([
      "id", "Order ID", "Gross", "Fee", "Net", "Currency", "Created (UTC)",
    ]);
    expect(mapping.orderRef).toBe("Order ID");
    expect(mapping.currency).toBe("Currency");
    expect(mapping.fee).toBe("Fee");
    expect(missingRequired).toEqual([]);
  });

  it("maps a COD courier remittance sheet", () => {
    const { mapping, missingRequired } = detectColumns([
      "Waybill", "Merchant Order No", "Remitted Amount", "Remittance Date",
    ]);
    expect(mapping.orderRef).toBe("Merchant Order No");
    expect(mapping.amount).toBe("Remitted Amount");
    expect(mapping.settledAt).toBe("Remittance Date");
    expect(missingRequired).toEqual([]);
  });

  // "reference" is ambiguous; on gateway exports it is usually the gateway's own
  // id, so an explicit order column must win it.
  it("prefers an explicit order column over a bare 'reference'", () => {
    const { mapping } = detectColumns(["Reference", "Order Number", "Amount", "Date"]);
    expect(mapping.orderRef).toBe("Order Number");
    expect(mapping.gatewayRef).toBe("Reference");
  });

  it("never assigns one column to two fields", () => {
    const { mapping } = detectColumns(["Reference", "Amount", "Date"]);
    const used = Object.values(mapping);
    expect(new Set(used).size).toBe(used.length);
  });

  it("reports missing required fields instead of guessing", () => {
    const { missingRequired } = detectColumns(["Foo", "Bar"]);
    expect(missingRequired).toEqual(REQUIRED_FIELDS);
  });

  it("lets an explicit override beat detection", () => {
    const overrides: ColumnMap = { orderRef: "Reference" };
    const { mapping } = detectColumns(["Reference", "Order Number", "Amount"], overrides);
    expect(mapping.orderRef).toBe("Reference");
    // The column detection would have taken is still free for its own field.
    expect(mapping.orderRef).not.toBe("Order Number");
  });
});

describe("mapSettlementRows — the join contract", () => {
  const mapping: ColumnMap = {
    orderRef: "Order ID", gatewayRef: "id", amount: "Net",
    currency: "Currency", settledAt: "Created", fee: "Fee",
  };

  it("puts the ORDER ref in transactionRef and the gateway id in externalRef", () => {
    const { rows } = mapSettlementRows(
      [{ "Order ID": "21076388995485181306699745", id: "py_3Abc", Net: "1,000,001.00", Currency: "usd", Created: "2026-08-02", Fee: "2.50" }],
      mapping, ctx,
    );
    expect(rows).toHaveLength(1);
    // This is the assertion that makes reconciliation possible at all.
    expect(rows[0].transactionRef).toBe("21076388995485181306699745");
    expect(rows[0].externalRef).toBe("py_3Abc");
    expect(rows[0].amount).toBe("1000001");
    expect(rows[0].currency).toBe("USD");
    expect(rows[0].channelId).toBe(ctx.paymentsChannelId);
    expect(rows[0].status).toBe("unmatched");
  });

  it("carries the fee and gateway ref into rawData for the exception engine", () => {
    const { rows } = mapSettlementRows(
      [{ "Order ID": "A1", id: "ch_1", Net: "100", Currency: "USD", Created: "2026-08-02", Fee: "3.10" }],
      mapping, ctx,
    );
    expect(rows[0].rawData).toMatchObject({
      gatewayEventType: "payment", originalOrderRef: "A1", gatewayRef: "ch_1", feeAmount: 3.1,
    });
  });

  it("treats a negative settlement as a refund/debit", () => {
    const { rows } = mapSettlementRows(
      [{ "Order ID": "A1", id: "re_1", Net: "(50.00)", Currency: "USD", Created: "2026-08-02", Fee: "0" }],
      mapping, ctx,
    );
    expect(rows[0].debitCredit).toBe("debit");
    expect(rows[0].isReversal).toBe(true);
    expect(rows[0].amount).toBe("50"); // magnitude stored, direction in debitCredit
    expect((rows[0].rawData as { gatewayEventType: string }).gatewayEventType).toBe("refund");
  });

  it("rejects rows with no order reference rather than importing unmatchable data", () => {
    const { rows, failures } = mapSettlementRows(
      [{ "Order ID": "", id: "py_1", Net: "10", Currency: "USD", Created: "2026-08-02", Fee: "0" }],
      mapping, ctx,
    );
    expect(rows).toHaveLength(0);
    expect(failures[0]).toMatchObject({ rowIndex: 2, reason: "missing order reference" });
  });

  it("rejects rows with an unparseable amount", () => {
    const { rows, failures } = mapSettlementRows(
      [{ "Order ID": "A1", id: "py_1", Net: "n/a", Currency: "USD", Created: "2026-08-02", Fee: "0" }],
      mapping, ctx,
    );
    expect(rows).toHaveLength(0);
    expect(failures[0].reason).toBe("unparseable amount");
  });

  it("falls back to the store currency when the file omits one", () => {
    const { rows } = mapSettlementRows(
      [{ "Order ID": "A1", id: "p", Net: "10", Currency: "", Created: "2026-08-02", Fee: "" }],
      mapping, ctx,
    );
    expect(rows[0].currency).toBe("USD");
  });
});

describe("parseSettlementFile", () => {
  it("parses CSV into header-keyed rows", async () => {
    const csv = "Order ID,Net,Currency\nA1,10.00,USD\nA2,20.00,USD\n";
    const r = await parseSettlementFile(csv, "payouts.csv");
    expect(r.rows).toHaveLength(2);
    expect(r.headers).toContain("Order ID");
    expect(r.rows[1]["Net"]).toBe("20.00");
  });

  it("round-trips a real .xlsx workbook", { timeout: 90_000 }, async () => {
    const { loadExcelJS } = await import("./exceljsLoader");
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Payouts");
    ws.addRow(["Order ID", "Net", "Currency"]);
    ws.addRow(["A1", 10.5, "USD"]);
    ws.addRow(["", "", ""]); // trailing blank row — endemic in exported sheets
    ws.addRow(["A2", 20, "USD"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const r = await parseSettlementFile(buf, "payouts.xlsx");
    expect(r.headers).toEqual(["Order ID", "Net", "Currency"]);
    expect(r.rows).toHaveLength(2); // blank row dropped
    expect(r.rows[0]["Order ID"]).toBe("A1");
    expect(parseAmount(r.rows[1]["Net"])).toBe(20);
  });

  it("end-to-end: an Excel export becomes matchable payment rows", { timeout: 90_000 }, async () => {
    const { loadExcelJS } = await import("./exceljsLoader");
    const ExcelJS = await loadExcelJS();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Merchant Order No", "Transaction ID", "Remitted Amount", "Remittance Date"]);
    ws.addRow(["21076388995485181306699745", "COD-77", "1000001.00", "2026-08-02"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const parsed = await parseSettlementFile(buf, "cod.xlsx");
    const { mapping, missingRequired } = detectColumns(parsed.headers);
    expect(missingRequired).toEqual([]);
    const { rows } = mapSettlementRows(parsed.rows, mapping, ctx);
    expect(rows[0].transactionRef).toBe("21076388995485181306699745");
    expect(rows[0].amount).toBe("1000001");
  });
});
