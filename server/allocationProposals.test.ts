/**
 * The allocation-proposal surface — the Corporate B2B pilot's headline
 * capability, and the gate that constrains it.
 *
 * `runM2MMatching` was cited by the go-live plan as evidence of "complex
 * allocation reasoning" and had ZERO call sites. Wiring it is only safe inside
 * pilot gate B4: "every non-exact or many-to-many candidate stays proposed
 * until a named human approves it."
 *
 * That boundary is enforced by the SHAPE of the endpoint — a tRPC query, which
 * cannot be a write — rather than by remembering not to write. These tests pin
 * that, because it is the property a customer's no-write attestation rests on
 * and the one a later change is most likely to erode by adding "just an
 * approve button".
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTER = fs.readFileSync(path.join(__dirname, "routers", "allocations.ts"), "utf8");

/** Comments stripped, so prose about the boundary cannot stand in for it. */
const CODE = ROUTER.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

describe("the allocation surface cannot write", () => {
  it("exposes proposals as a query, never a mutation", () => {
    // A mutation here would let a future change post allocations directly,
    // which is precisely what B4 forbids. The endpoint shape is the control.
    expect(CODE).toContain(".query(");
    expect(CODE, "an allocation endpoint must not be a mutation — gate B4").not.toContain(".mutation(");
  });

  it("performs no insert, update or delete", () => {
    for (const write of ["db.insert(", "db.update(", "db.delete(", "tx.insert(", "tx.update(", "tx.delete("]) {
      expect(CODE, `allocations router must not ${write} — it proposes, it does not post`).not.toContain(write);
    }
  });

  it("makes no model call, so it survives a tenant with AI disabled", () => {
    // AI off is the DEFAULT for a controlled pilot (gate B5). An allocation
    // surface that needed a model would be unavailable exactly when the pilot
    // is most constrained.
    for (const symbol of ["invokeLLM", "diagnoseException", "getAIAnalysis", "assertTenantAiAllowed"]) {
      expect(CODE, `allocations must not reach a model via ${symbol}`).not.toContain(symbol);
    }
  });

  it("tells the caller it is read-only rather than leaving it to be assumed", () => {
    expect(CODE).toContain("readOnly: true");
  });
});

describe("the allocation surface is scoped to one tenant", () => {
  it("takes the organisation from the session, not from the caller's input", () => {
    // The job id arrives from the client and decides nothing about tenancy.
    expect(CODE).toContain("ctx.user.organizationId");
    const orgAt = CODE.indexOf("ctx.user.organizationId");
    const jobAt = CODE.indexOf("getReconciliationJob");
    expect(orgAt).toBeGreaterThan(-1);
    expect(jobAt, "the job is loaded after the organisation is resolved").toBeGreaterThan(orgAt);
  });

  it("refuses a job belonging to another organisation, indistinguishably from one that does not exist", () => {
    expect(CODE).toContain("job.organizationId !== organizationId");
    // NOT_FOUND, not FORBIDDEN: a different code would let a caller enumerate
    // which job ids exist in other tenants.
    const check = CODE.slice(CODE.indexOf("job.organizationId !== organizationId"));
    expect(check.slice(0, 200)).toContain("NOT_FOUND");
  });

  it("refuses a caller with no organisation rather than pooling them", () => {
    // "No organisation" is not "every organisation" — CLAUDE.md §9C.
    expect(CODE).toContain("PRECONDITION_FAILED");
  });

  it("reads each side through the org-scoped accessor", () => {
    // getTransactionsForReconciliation filters by channelId alone, on the
    // reasoning that a channel implies its tenant. That inference is what
    // produced the cross-tenant reads in §19.3.
    expect(CODE).toContain("getOpenTransactionsForChannel");
    expect(CODE, "must not use the channel-only reader").not.toContain("getTransactionsForReconciliation");
    expect(CODE).toContain("organizationId,");
  });
});

describe("the pool is the job's own window", () => {
  it("reads BOTH sides within the job's date range", () => {
    // A reconciliation job IS its date range. Without this, opening a
    // historical job proposed allocations against transactions the channel had
    // acquired long after that run finished — items that were never part of it.
    //
    // Counted, not merely found: the first cut asserted presence, and removing
    // the window from ONE of the two sides left it green. Both sides or
    // neither — a job window applied to half the comparison is not a window.
    //
    // The binding guard is the TYPE: `getOpenTransactionsForChannel` requires
    // dateFrom and dateTo, so omitting either is a compile error. This test
    // exists to catch them being passed something other than the job's own.
    const from = CODE.split("dateFrom: job.dateFrom").length - 1;
    const to = CODE.split("dateTo: job.dateTo").length - 1;
    expect(from, "both the source and target reads must use the job's dateFrom").toBe(2);
    expect(to, "both the source and target reads must use the job's dateTo").toBe(2);
  });
});

describe("the pool is bounded, and says when it was", () => {
  it("caps each side and reports truncation instead of absorbing it", () => {
    // A truncated pool silently changes which allocations exist. The engine
    // loops every source against every target, so the cap is necessary — and
    // therefore has to be visible.
    expect(CODE).toContain("SIDE_LIMIT");
    expect(CODE).toContain("truncated:");
  });
});
