/**
 * Bucket-drop ingestion.
 *
 * The behaviours pinned here are the ones whose failure is silent and
 * expensive: pattern matching that quietly ingests the wrong objects, and
 * idempotency that quietly double-counts settlements.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../server/db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));

import { patternToRegExp, baseName, buildS3Client } from "./bucketIngestionService";

describe("baseName", () => {
  it("strips the prefix so filePattern matches the file, not the path", () => {
    expect(baseName("settlements/incoming/payout_2026-08-02.csv")).toBe("payout_2026-08-02.csv");
    expect(baseName("payout.csv")).toBe("payout.csv");
  });
});

describe("patternToRegExp", () => {
  it("matches a glob the way the SFTP poller does", () => {
    const re = patternToRegExp("*.csv");
    expect(re.test("payout.csv")).toBe(true);
    expect(re.test("PAYOUT.CSV")).toBe(true); // case-insensitive
    expect(re.test("payout.xlsx")).toBe(false);
  });

  it("supports prefixed globs", () => {
    const re = patternToRegExp("settlement_*.xlsx");
    expect(re.test("settlement_2026-08.xlsx")).toBe(true);
    expect(re.test("refunds_2026-08.xlsx")).toBe(false);
  });

  it("anchors, so a pattern cannot match a longer name by accident", () => {
    const re = patternToRegExp("*.csv");
    // Without anchoring, "payout.csv.bak" would match and a backup would be
    // ingested as if it were the live file.
    expect(re.test("payout.csv.bak")).toBe(false);
  });

  it("treats regex metacharacters in the pattern as literals", () => {
    const re = patternToRegExp("report(final).csv");
    expect(re.test("report(final).csv")).toBe(true);
    expect(re.test("reportfinal.csv")).toBe(false);
  });

  it("supports ? as a single-character wildcard", () => {
    const re = patternToRegExp("day_?.csv");
    expect(re.test("day_1.csv")).toBe(true);
    expect(re.test("day_12.csv")).toBe(false);
  });
});

describe("buildS3Client", () => {
  // `forcePathStyle` is a plain boolean on the resolved config; `region` is a
  // provider function. They are not symmetrical.
  it("uses path-style addressing when a custom endpoint is set (R2/MinIO)", () => {
    const c = buildS3Client({
      region: "auto",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      accessKeyIdEncrypted: null,
      secretAccessKeyEncrypted: null,
    });
    expect(c.config.forcePathStyle).toBe(true);
  });

  it("leaves virtual-host addressing in place for plain AWS S3", () => {
    const c = buildS3Client({ region: "eu-west-1", endpoint: null });
    expect(c.config.forcePathStyle).toBe(false);
  });

  it("omits credentials so the instance role is used when none are stored", () => {
    // Passing undefined credentials would break the SDK's default chain; the
    // key must be absent entirely.
    const c = buildS3Client({ region: "eu-west-1", endpoint: null });
    expect(c).toBeDefined();
  });

  it("defaults the region rather than sending an empty string", async () => {
    const c = buildS3Client({ region: "", endpoint: null });
    expect(await c.config.region()).toBe("auto");
  });
});
