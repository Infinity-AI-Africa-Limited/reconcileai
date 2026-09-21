/**
 * Inside a tenant's portal, a super admin's actions are recorded in THAT
 * tenant's audit trail — the third condition of the portal write rule
 * (portalScopedOrgId). `logAudit` has 81 call sites and is handed no context,
 * so the base tRPC procedure opens a request scope and the logger reads it.
 * These tests run real procedures through the real base procedure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => null),
  createAuditLog: vi.fn(async () => {}),
  getReconciliationJob: vi.fn(),
}));

import * as db from "../db";
import { router, protectedProcedure } from "../_core/trpc";
import { currentPortalOrganizationId } from "../_core/requestScope";
import { assertJobVisible, logAudit } from "./shared";

const probe = router({
  act: protectedProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "resolve_exception", "exception", 9);
    return currentPortalOrganizationId();
  }),
  actGlobal: protectedProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "platform_event", "platform", undefined, undefined, undefined, undefined, null);
  }),
});

const staff = { id: 1, role: "super_admin", organizationId: 30001, isReadOnly: false } as never;
const call = (viewingAs: number | null) => probe.createCaller({ user: staff, viewingAs, req: { headers: {} }, res: {} } as never);
const auditedOrg = () => vi.mocked(db.createAuditLog).mock.calls.at(-1)?.[0]?.organizationId;

beforeEach(() => vi.clearAllMocks());

describe("when a super admin acts inside a tenant's portal", () => {
  it("should record the action in the tenant's audit trail", async () => {
    expect(await call(30001).act()).toBe(30001);
    expect(auditedOrg()).toBe(30001);
  });

  it("should still honour an explicit choice of the global chain", async () => {
    await call(30001).actGlobal();
    expect(auditedOrg()).toBeNull();
  });
});

describe("when no portal is open", () => {
  it("should record the action as before — the global chain for an omitted tenant", async () => {
    expect(await call(null).act()).toBeNull();
    expect(auditedOrg()).toBeNull();
  });

  it("should carry no portal tenant outside a tRPC call at all", async () => {
    expect(currentPortalOrganizationId()).toBeNull();
    await logAudit(1, "background", "job");
    expect(auditedOrg()).toBeNull();
  });
});

describe("when a procedure in routers.ts reads a job or schedule by a caller's id", () => {
  // routers.ts cannot be imported in a test: it starts the scheduler, SFTP
  // polling and SLA monitoring on import, against whatever database is
  // configured — production on a developer machine. So its by-id reads are
  // pinned by their checks here, and the check itself is tested below.
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "routers.ts"), "utf8").replace(/\r\n/g, "\n") as string;
  const preceding = (needle: string) =>
    [...src.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((m) => src.slice(Math.max(0, m.index! - 400), m.index));

  it("should check the job is visible before a full export or its progress is read", () => {
    for (const needle of ["db.getFullReconciliationReport(input.jobId)", "getJobProgress(input.jobId)"]) {
      const sites = preceding(needle);
      expect(sites.length, `${needle} has moved`).toBeGreaterThan(0);
      for (const before of sites) expect(before, needle).toContain("await assertJobVisible(ctx.user, input.jobId);");
    }
  });

  it("should tell the browser who is signed in, not the tenant they are viewing", () => {
    // Inside a portal ctx.user carries the TENANT's organisation; auth.me must
    // return the account itself, or the client would believe the super admin
    // had become a member of that tenant.
    expect(src).toContain("me: publicProcedure.query((opts) => opts.ctx.actor ?? opts.ctx.user),");
  });

  it("should check a schedule's tenant before returning it", () => {
    const at = src.indexOf("const task = await db.getScheduledTaskById(input.id);\n        // The task names its tenant.");
    expect(at, "schedules.get has moved").toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/canActOnTenant\(ctx\.user, task\.organizationId \?\? null\)/);
  });
});

describe("when a procedure is handed a job id", () => {
  it("should serve the caller's own tenant's job", async () => {
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 5, organizationId: 1 } as never);
    await expect(assertJobVisible({ role: "operations", organizationId: 1 }, 5)).resolves.toMatchObject({ id: 5 });
  });

  it("should answer another tenant's job exactly as a missing one", async () => {
    // export.csv / export.xlsx served ANY tenant's full reconciliation by id.
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 5, organizationId: 2 } as never);
    await expect(assertJobVisible({ role: "operations", organizationId: 1 }, 5)).rejects.toThrow("Job not found");
    vi.mocked(db.getReconciliationJob).mockResolvedValue(undefined as never);
    await expect(assertJobVisible({ role: "operations", organizationId: 1 }, 5)).rejects.toThrow("Job not found");
  });

  it("should refuse a caller with no organisation even a job with none", async () => {
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 5, organizationId: null } as never);
    await expect(assertJobVisible({ role: "operations", organizationId: null }, 5)).rejects.toThrow("Job not found");
  });
});
