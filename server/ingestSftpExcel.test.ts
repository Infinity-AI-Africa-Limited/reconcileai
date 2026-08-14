/**
 * SFTP/bucket drops must accept workbooks, not just delimited text.
 *
 * `downloadAndProcessSftpFile` previously did `fileBuffer.toString("utf8")`
 * unconditionally. Couriers and enterprise PSPs overwhelmingly drop .xlsx, so
 * that mangled the file into replacement characters and parsed it as CSV,
 * producing garbage rows rather than an honest failure. The same lossy string
 * was then hashed for duplicate detection, so two different workbooks could
 * collide and the second be silently discarded.
 */
import { describe, it, expect } from "vitest";
import { calculateFileHash, validateParsedRows } from "./apiIngestionService";
import { parseTabularFile } from "./ingest/fileParser";

/**
 * ExcelJS is a heavy dynamic import. Memoised at module scope so it is paid
 * ONCE for the file rather than on every `workbook()` call — the hashing test
 * below builds two workbooks, so it was paying it twice inside a single timed
 * test body.
 */
let excelJs: Promise<typeof import("exceljs")> | null = null;
function getExcelJS(): Promise<typeof import("exceljs")> {
  excelJs ??= import("./exceljsLoader").then((m) => m.loadExcelJS());
  return excelJs;
}

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The two tests here do real spreadsheet I/O and carry an explicit timeout, as
 * every other ExcelJS test in this repo does (see line ~46 below,
 * ingestFileParser.test.ts and shoplineSettlementImport.test.ts). They were the
 * only ones missing it, so they ran under vitest's 5s default while doing the
 * same work — and one of them failed once in a full-suite run on 2026-08-05,
 * passed in isolation, and did not recur in 15 further full runs.
 *
 * The cause was never captured, so this does not claim to be the fix. It closes
 * the one difference between these tests and their passing siblings, and it
 * CANNOT hide the alternative: a longer timeout does not make a false assertion
 * pass. The byte-level assertions below exist so that if it ever does recur,
 * the failure names its own cause instead of surfacing as a baffling hash
 * collision.
 */
describe("calculateFileHash", () => {
  it("hashes binary content over its real bytes", { timeout: 90_000 }, async () => {
    const a = await workbook([["Date", "Amount"], ["2026-08-02", 1]]);
    const b = await workbook([["Date", "Amount"], ["2026-08-02", 2]]);
    // Pin the inputs before hashing them. If ExcelJS ever returns an empty or
    // degenerate buffer, that is what failed — not the hash function, which is
    // a bare sha256 and cannot map distinct bytes onto one digest.
    expect(a.byteLength, "workbook A came back empty").toBeGreaterThan(0);
    expect(b.byteLength, "workbook B came back empty").toBeGreaterThan(0);
    expect(a.equals(b), "the two workbooks serialised to identical bytes").toBe(false);
    expect(calculateFileHash(a)).not.toBe(calculateFileHash(b));
  });

  it("collapses distinct workbooks when hashed as utf8 — the old bug", { timeout: 90_000 }, async () => {
    // Demonstrates why the Buffer overload matters: lossy utf8 decoding of
    // binary can map different inputs onto the same string.
    const a = await workbook([["Date", "Amount"], ["2026-08-02", 1]]);
    expect(a.byteLength, "workbook came back empty").toBeGreaterThan(0);
    const utf8Lossy = Buffer.from(a.toString("utf8"), "utf8");
    expect(utf8Lossy.byteLength).not.toBe(a.byteLength);
  });

  it("still hashes plain strings", () => {
    expect(calculateFileHash("abc")).toBe(calculateFileHash("abc"));
    expect(calculateFileHash("abc")).not.toBe(calculateFileHash("abd"));
  });
});

describe("SFTP drop → shared parse → shared validation", () => {
  it("ingests an .xlsx bank drop end-to-end", { timeout: 90_000 }, async () => {
    const buf = await workbook([
      ["Posting Date", "Value", "Reference"],
      ["2026-08-02", 1234.56, "REF-1"],
      ["2026-08-03", "(45.00)", "REF-2"], // refund, must stay negative
    ]);
    const parsed = await parseTabularFile(buf, "courier_remittance.xlsx");
    const res = validateParsedRows(parsed.rows);
    expect(res.invalid).toHaveLength(0);
    expect(res.valid).toHaveLength(2);
    expect(res.valid[0].amount).toBe("1234.56");
    expect(res.valid[1].amount).toBe("(45.00)");
  });

  it("ingests a .csv drop through the identical path", async () => {
    const csv = "Posting Date,Value\n2026-08-02,1234.56\n";
    const parsed = await parseTabularFile(csv, "drop.csv");
    const res = validateParsedRows(parsed.rows);
    expect(res.valid).toHaveLength(1);
    expect(res.totalRows).toBe(1);
  });

  it("rejects a non-workbook masquerading as .xlsx rather than importing junk", async () => {
    const notAWorkbook = Buffer.from("this is plainly not a zip archive", "utf8");
    await expect(parseTabularFile(notAWorkbook, "fake.xlsx")).rejects.toBeTruthy();
  });
});
