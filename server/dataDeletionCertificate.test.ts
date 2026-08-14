/**
 * Data-deletion certificate integrity.
 *
 * `compliance.requestDeletion` returns a document asserting NDPA-compliant
 * destruction. That makes its output a legal artefact, and the failure mode is
 * not a crash but a confident lie: the procedure accepted two scopes it
 * implemented nowhere, deleted nothing, marked itself "completed", and issued
 * the certificate anyway — quoting a record count taken from a query that had
 * nothing to do with what was removed.
 *
 * Asserted at the source level for the same reason the tenancy ratchets are:
 * the procedure needs a live database to execute, so the property worth pinning
 * is that the unimplemented scopes cannot be requested and that no path reaches
 * a certificate without a completed deletion.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");

/** The requestDeletion procedure body, isolated from the 6,900-line router. */
const PROCEDURE = (() => {
  const start = ROUTERS.indexOf("requestDeletion: protectedProcedure");
  expect(start, "requestDeletion procedure not found — has it been renamed?").toBeGreaterThan(-1);
  // Ends at the next sibling procedure in the compliance router.
  const end = ROUTERS.indexOf("listDeletionRequests", start);
  return ROUTERS.slice(start, end > start ? end : start + 6000);
})();

describe("requestDeletion accepts only scopes it implements", () => {
  it("no longer accepts specific_channel or specific_job", () => {
    // Both were in the input enum and had NO branch in the handler. A request
    // for either deleted nothing and still returned a signed certificate.
    const inputEnum = PROCEDURE.slice(PROCEDURE.indexOf("scope: z.enum"), PROCEDURE.indexOf("scope: z.enum") + 120);
    expect(inputEnum).not.toContain("specific_channel");
    expect(inputEnum).not.toContain("specific_job");
  });

  it("still accepts the two scopes that are actually implemented", () => {
    const inputEnum = PROCEDURE.slice(PROCEDURE.indexOf("scope: z.enum"), PROCEDURE.indexOf("scope: z.enum") + 120);
    expect(inputEnum).toContain("all_transactions");
    expect(inputEnum).toContain("all_data");
  });

  it("every accepted scope has a corresponding delete path", () => {
    // The invariant behind the bug: an enum member with no branch is a silent
    // no-op wearing a certificate.
    const accepted = [...PROCEDURE.matchAll(/"(all_transactions|all_data|specific_channel|specific_job)"/g)]
      .map((m) => m[1]);
    for (const scope of new Set(accepted)) {
      expect(["all_transactions", "all_data"]).toContain(scope);
    }
  });
});

describe("a certificate cannot outrun the deletion it attests to", () => {
  it("does not swallow delete failures", () => {
    // Previously every delete ended `.catch(() => {})`, so a total failure still
    // produced status "completed" and a certificate.
    expect(PROCEDURE).not.toMatch(/delete\([^)]*\)[\s\S]{0,120}?\.catch\(\(\) => \{\}\)/);
  });

  it("marks the request failed and throws instead of certifying", () => {
    expect(PROCEDURE).toContain('status: "failed"');
    expect(PROCEDURE).toMatch(/no certificate was issued/i);
  });

  it("builds the certificate only after the delete block has succeeded", () => {
    // Ordering is the property: the catch must return/throw before certText.
    const catchIndex = PROCEDURE.indexOf("} catch (err)");
    const certIndex = PROCEDURE.indexOf("const certText");
    expect(catchIndex).toBeGreaterThan(-1);
    expect(certIndex).toBeGreaterThan(catchIndex);
  });

  it("reports rows actually affected, not a pre-count of one table", () => {
    // The old figure came from a COUNT(*) on transactions taken BEFORE the
    // delete, and ignored matches, exceptions, batches and jobs entirely.
    expect(PROCEDURE).toContain("affectedRows");
    expect(PROCEDURE).not.toMatch(/recordsDeleted = Number\(txCount/);
  });
});
