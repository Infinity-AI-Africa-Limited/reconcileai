/**
 * A row named by a caller-supplied id is acted on only by someone its tenant
 * admits.
 *
 * Six procedures read or wrote a row by id alone, with no tenant predicate:
 * resolution templates (update/delete — any tenant's, and the SHARED defaults
 * every tenant is shown), share-link revoke, the Super Agent's memory
 * counterparty read, exceptions.checkStaleness (read AND write), and — in the
 * POC router, tested in pocScope.test.ts — exception review status, run
 * exceptions, and the uploads a run reconciles.
 *
 * routers.ts cannot be imported in a test (it boots the scheduler, SFTP and SLA
 * monitor against the configured database — production on a developer
 * machine), so its call sites are pinned by source text, the gates are tested
 * directly, and a ratchet refuses the next write by id alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => null),
  getReportById: vi.fn(),
}));

import * as db from "../db";
import { runInRequestScope } from "../_core/requestScope";
import { assertReportVisible, assertRowVisible } from "./shared";

const bankOps = { role: "operations", organizationId: 4 };
const staff = { role: "super_admin", organizationId: 30002 };
const inPortal = <T,>(tenant: number, fn: () => T) =>
  runInRequestScope({ portalOrganizationId: tenant, auditOrganizationId: tenant } as never, fn);
const answer = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return `${err.code}: ${err.message}`;
  }
};

beforeEach(() => vi.clearAllMocks());

describe("when a tenant's user names a row by id", () => {
  it("should reach their own organisation's row", () => {
    expect(assertRowVisible(bankOps, { id: 1, organizationId: 4 }, "Template not found")).toMatchObject({ id: 1 });
  });

  it("should get the SAME not-found for another tenant's row, a shared row, and no row", () => {
    // One answer for all three, so the response cannot say which ids exist.
    const notFound = "NOT_FOUND: Template not found";
    expect(answer(() => assertRowVisible(bankOps, { id: 2, organizationId: 5 }, "Template not found"))).toBe(notFound);
    expect(answer(() => assertRowVisible(bankOps, { id: 3, organizationId: null }, "Template not found"))).toBe(notFound);
    expect(answer(() => assertRowVisible(bankOps, undefined, "Template not found"))).toBe(notFound);
  });

  it("should refuse a caller with no organisation even a row with none — no pooling", () => {
    expect(answer(() => assertRowVisible({ role: "operations", organizationId: null }, { organizationId: null }, "x"))).toBe("NOT_FOUND: x");
  });
});

describe("when staff name a row by id", () => {
  it("should let them reach any tenant's row, and the shared defaults, outside a portal", () => {
    expect(answer(() => assertRowVisible(staff, { organizationId: 5 }, "x"))).toBe("ok");
    expect(answer(() => assertRowVisible(staff, { organizationId: null }, "x"))).toBe("ok");
  });

  it("should hold them to the tenant on screen inside a portal — shared rows included", () => {
    // Editing text every tenant reads is a platform act, not something done
    // from inside one tenant's portal.
    expect(inPortal(5, () => answer(() => assertRowVisible(staff, { organizationId: 5 }, "x")))).toBe("ok");
    expect(inPortal(5, () => answer(() => assertRowVisible(staff, { organizationId: 6 }, "x")))).toBe("NOT_FOUND: x");
    expect(inPortal(5, () => answer(() => assertRowVisible(staff, { organizationId: null }, "x")))).toBe("NOT_FOUND: x");
  });
});

describe("when a report is named by id", () => {
  it("should serve it by its own tenant, from any age — not only the caller's newest 100", async () => {
    vi.mocked(db.getReportById).mockResolvedValue({ id: 9, organizationId: 4 } as never);
    await expect(assertReportVisible(bankOps, 9)).resolves.toMatchObject({ id: 9 });
    expect(db.getReportById).toHaveBeenCalledWith(9);
  });

  it("should answer another tenant's report, and a missing one, identically", async () => {
    vi.mocked(db.getReportById).mockResolvedValue({ id: 9, organizationId: 5 } as never);
    await expect(assertReportVisible(bankOps, 9)).rejects.toThrow("Report not found");
    vi.mocked(db.getReportById).mockResolvedValue(undefined as never);
    await expect(assertReportVisible(bankOps, 9)).rejects.toThrow("Report not found");
  });

  it("should use the caller's message, so a share link does not reveal its report exists", async () => {
    vi.mocked(db.getReportById).mockResolvedValue({ id: 9, organizationId: 5 } as never);
    await expect(assertReportVisible(bankOps, 9, "Share link not found")).rejects.toThrow("Share link not found");
  });

  it("should refuse an org-less caller the org-less reports that getReports(null) used to hand them", async () => {
    vi.mocked(db.getReportById).mockResolvedValue({ id: 9, organizationId: null } as never);
    await expect(assertReportVisible({ role: "user", organizationId: null }, 9)).rejects.toThrow("Report not found");
  });
});

// ─── routers.ts call sites ───────────────────────────────────────────────────

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
const routers = read("routers.ts");
/** The body of `name: <builder>` inside the named router block, up to the next sibling procedure. */
function procedure(routerName: string, name: string): string {
  const block = routers.indexOf(`  ${routerName}: router({`);
  expect(block, `${routerName} router has moved`).toBeGreaterThan(-1);
  const start = routers.indexOf(`\n    ${name}: `, block);
  expect(start, `${routerName}.${name} has moved`).toBeGreaterThan(-1);
  const next = routers.slice(start + 1).search(/\n {4}\w+: \w*[pP]rocedure/);
  return routers.slice(start, next === -1 ? undefined : start + 1 + next);
}

describe("when resolution templates are written", () => {
  it("should gate update and delete on the row's own tenant, and carry it into the write", () => {
    for (const name of ["update", "delete"]) {
      const body = procedure("resolutionTemplates", name);
      const gate = body.indexOf('assertRowVisible(ctx.user, found, "Template not found")');
      const write = body.search(/dbConn\.(update|delete)\(db\.resolutionTemplates\)/);
      expect(gate, `${name}: gate`).toBeGreaterThan(-1);
      expect(write, `${name}: write`).toBeGreaterThan(gate);
      expect(body.slice(write), name).toContain("db.orgFilter(db.resolutionTemplates.organizationId, template.organizationId)");
    }
  });

  it("should refuse to create a template for a caller with no tenant — it would be shared with every tenant", () => {
    const body = procedure("resolutionTemplates", "create");
    expect(body).toContain("if (!isTenantId(owner)) {");
    expect(body).toContain("organizationId: owner,");
    expect(body).not.toContain("organizationId: ctx.user.organizationId,");
  });
});

describe("when reports and their share links are reached by id", () => {
  it("should gate every one on the report's own tenant", () => {
    expect(procedure("reports", "get")).toContain("return assertReportVisible(ctx.user, input.id);");
    expect(procedure("reports", "createShareToken")).toContain("const report = await assertReportVisible(ctx.user, input.reportId);");
    expect(procedure("reports", "listShareTokens")).toContain("await assertReportVisible(ctx.user, input.reportId);");
    // The newest-100 lookup is gone from all of them.
    expect(routers).not.toMatch(/getReports\(ctx\.user\.organizationId \?\? null\);\n\s*const report = reports\.find/);
  });

  it("should file a new link under the report's tenant, not the caller's", () => {
    expect(procedure("reports", "createShareToken")).toContain("organizationId: report.organizationId ?? null,");
  });

  it("should revoke a link only after its report is shown to be the caller's", () => {
    const body = procedure("reports", "revokeShareToken");
    const gate = body.indexOf('await assertReportVisible(ctx.user, link.reportId, "Share link not found");');
    const write = body.indexOf("await dbConn.update(sharedReportTokens)");
    expect(gate).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(gate);
    expect(body.slice(write)).toContain("eq(sharedReportTokens.reportId, link.reportId)");
  });
});

describe("when the Super Agent records a resolution memory", () => {
  const body = () => procedure("superAgent", "addMemory");

  it("should refuse a caller with no tenant rather than file under organisation 0", () => {
    expect(body()).toContain("if (!isTenantId(orgId)) {");
    expect(body()).not.toContain("ctx.user.organizationId ?? 0");
  });

  it("should read a linked exception only from the caller's tenant, and refuse another's", () => {
    expect(body()).toContain("and(eq(exTbl.id, input.exceptionId), eq(exTbl.organizationId, orgId))");
    expect(body()).toContain("if (!linked) throw new TRPCError({ code: 'NOT_FOUND', message: 'Exception not found' });");
  });
});

describe("when exception staleness is checked", () => {
  const body = () => procedure("exceptions", "checkStaleness");

  it("should read and write only the caller's tenant's exceptions", () => {
    expect(body()).toContain("if (!isTenantId(orgId)) {");
    expect(body()).toContain("eq(exceptionsTable.organizationId, orgId),\n              inArray(exceptionsTable.status");
    expect(body()).toContain(".where(and(eq(exceptionsTable.id, row.exceptionId), eq(exceptionsTable.organizationId, orgId)));");
  });

  it("should never search every tenant for a reappearance", () => {
    expect(body()).toContain("const orgFilter = sql` AND t_new.organizationId = ${orgId}`;");
    expect(body()).not.toContain("orgId != null ?");
  });
});

// ─── The class ───────────────────────────────────────────────────────────────

describe("when any router writes a row", () => {
  /**
   * Tables whose writes by id are gated before the statement, each for a reason
   * the table itself does not change. Adding one is a decision, not a fix.
   */
  const GATED_ELSEWHERE: Record<string, string> = {
    users: "every write sits behind assertCanManageUsers or a super-admin-only check",
    organizations: "superAdminProcedure only",
    roadmapAccessRequests: "superAdminProcedure only",
    wc_exceptions: "the Woodcore POC: one prospect, behind woodcoreProcedure's access token",
    slConnectorStores: "the store is first loaded with an organisation predicate",
  };

  it("should never update or delete by a caller-supplied id alone", () => {
    const files = ["routers.ts", ...readdirSync(join(root, "routers"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => `routers/${f}`)];
    const offenders: string[] = [];
    for (const file of files) {
      const src = read(file);
      for (const m of src.matchAll(/\.(update|delete)\(\s*([\w.]+)\s*\)/g)) {
        const stmt = src.slice(m.index!, src.indexOf(";", m.index!));
        if (!/\.where\(\s*eq\(\s*[\w.]+\.id\s*,\s*input\.\w+\s*\)\s*\)/.test(stmt)) continue;
        const table = m[2].replace(/^db\./, "");
        if (!(table in GATED_ELSEWHERE)) offenders.push(`${file}:${src.slice(0, m.index!).split("\n").length} ${m[1]}(${m[2]})`);
      }
    }
    expect(
      offenders,
      "A write whose only predicate is the caller's id reaches ANY tenant's row. Gate it on the " +
        "row's own tenant (assertRowVisible) and carry the tenant into the WHERE.",
    ).toEqual([]);
  });

  it("should be able to see the shape it forbids", () => {
    // Paired positive: the ratchet's pattern must match the defect it exists
    // for, or it would pass vacuously.
    const shape = /\.where\(\s*eq\(\s*[\w.]+\.id\s*,\s*input\.\w+\s*\)\s*\)/;
    expect(shape.test(".where(eq(db.resolutionTemplates.id, input.id))")).toBe(true);
    expect(shape.test(".where(and(eq(db.resolutionTemplates.id, input.id), x))")).toBe(false);
  });
});
