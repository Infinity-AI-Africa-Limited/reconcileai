/**
 * Inside a tenant's portal, a super admin's actions are recorded in THAT
 * tenant's audit trail — the third condition of the portal write rule
 * (portalScopedOrgId). `logAudit` has 81 call sites and is handed no context,
 * so the base tRPC procedure opens a request scope and the logger reads it.
 * These tests run real procedures through the real base procedure.
 *
 * The default is right only for an event about the tenant on screen, so the
 * tests also pin what keeps everything else out of it: platform procedures run
 * outside the portal scope, by-id reach narrows to the portal, and events about
 * the account rather than a tenant name the global chain.
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
import { currentPortalOrganizationId, runInRequestScope } from "../_core/requestScope";
import { assertSameOrg } from "../_core/tenancy";
import { assertCanManageUsers, assertJobVisible, canActOnTenant, logAudit, superAdminProcedure } from "./shared";

const probe = router({
  act: protectedProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "resolve_exception", "exception", 9);
    return currentPortalOrganizationId();
  }),
  actGlobal: protectedProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "platform_event", "platform", undefined, undefined, undefined, undefined, null);
  }),
  reach: protectedProcedure.query(({ ctx }) => [canActOnTenant(ctx.user, 30001), canActOnTenant(ctx.user, 30002)]),
  platform: superAdminProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "create_organization", "organization", 77);
    return { portal: currentPortalOrganizationId(), orgOnScreen: ctx.user.organizationId, reachOther: canActOnTenant(ctx.user, 30002) };
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

  it("should reach only the tenant on screen by id — not every tenant, as the role alone allowed", async () => {
    expect(await call(30001).reach()).toEqual([true, false]);
  });
});

describe("when a platform procedure is called while a portal is open", () => {
  // The browser sends the portal header on every call — the Super Admin
  // dashboard's included, while a portal is still open in the tab.
  it("should file its audit record in the global chain, not the tenant's trail", async () => {
    const out = await call(30001).platform();
    expect(auditedOrg()).toBeNull();
    expect(out.portal).toBeNull();
  });

  it("should keep its cross-tenant reach, and leave the user it acts as untouched", async () => {
    // ctx.user is not rewritten: demo.activate still seeds the tenant on screen.
    const out = await call(30001).platform();
    expect(out.reachOther).toBe(true);
    expect(out.orgOnScreen).toBe(30001);
  });

  it("should still refuse anyone who is not staff", async () => {
    const tenantAdmin = { id: 2, role: "admin", organizationId: 30001, isReadOnly: false } as never;
    const caller = probe.createCaller({ user: tenantAdmin, viewingAs: null, req: { headers: {} }, res: {} } as never);
    await expect(caller.platform()).rejects.toThrow(/Super Admin access required/);
  });
});

describe("when staff reach a row by id inside a tenant's portal", () => {
  const inPortal = <T,>(fn: () => T) => runInRequestScope({ portalOrganizationId: 30001 }, fn);
  const superAdmin = { role: "super_admin", organizationId: 30001 };

  it("should serve the tenant's own job and answer another tenant's as missing", async () => {
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 5, organizationId: 30001 } as never);
    await expect(inPortal(() => assertJobVisible(superAdmin, 5))).resolves.toMatchObject({ id: 5 });
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 6, organizationId: 30002 } as never);
    await expect(inPortal(() => assertJobVisible(superAdmin, 6))).rejects.toThrow("Job not found");
  });

  it("should keep every tenant in reach outside a portal", async () => {
    vi.mocked(db.getReconciliationJob).mockResolvedValue({ id: 6, organizationId: 30002 } as never);
    await expect(assertJobVisible(superAdmin, 6)).resolves.toMatchObject({ id: 6 });
    expect(canActOnTenant(superAdmin, 30002)).toBe(true);
  });

  it("should hold the canonical row guard to the same rule", () => {
    expect(() => inPortal(() => assertSameOrg(superAdmin, 30001))).not.toThrow();
    expect(() => inPortal(() => assertSameOrg(superAdmin, 30002))).toThrow(/another organization/);
    expect(() => inPortal(() => assertSameOrg(superAdmin, null))).toThrow(/another organization/);
    expect(() => assertSameOrg(superAdmin, 30002)).not.toThrow();
  });
});

describe("when users are managed", () => {
  const targets = (rows: { id: number; role: string; organizationId: number | null }[]) => {
    const chain = { select: () => chain, from: () => chain, where: async () => rows };
    vi.mocked(db.getDb).mockResolvedValue(chain as never);
  };
  const staffCtx = { user: { role: "super_admin", organizationId: 30001 } };
  const inPortal = <T,>(fn: () => T) => runInRequestScope({ portalOrganizationId: 30001 }, fn);

  it("should let staff inside a portal manage that tenant's users only", async () => {
    targets([{ id: 8, role: "operations", organizationId: 30001 }]);
    await expect(inPortal(() => assertCanManageUsers(staffCtx, [8]))).resolves.toBeUndefined();
    targets([{ id: 9, role: "operations", organizationId: 30002 }]);
    await expect(inPortal(() => assertCanManageUsers(staffCtx, [9]))).rejects.toThrow(/own organisation/);
    targets([{ id: 1, role: "super_admin", organizationId: 30001 }]);
    await expect(inPortal(() => assertCanManageUsers(staffCtx, [1]))).rejects.toThrow(/own organisation/);
  });

  it("should let staff outside a portal manage anyone, without a lookup", async () => {
    await expect(assertCanManageUsers(staffCtx, [9])).resolves.toBeUndefined();
    expect(db.getDb).not.toHaveBeenCalled();
  });

  it("should let an admin with no organisation manage no one, org-less users included", async () => {
    targets([{ id: 9, role: "operations", organizationId: null }]);
    await expect(assertCanManageUsers({ user: { role: "admin", organizationId: null } }, [9])).rejects.toThrow(/own organisation/);
  });

  it("should still let an org admin manage their own organisation's users", async () => {
    targets([{ id: 9, role: "operations", organizationId: 4 }]);
    await expect(assertCanManageUsers({ user: { role: "admin", organizationId: 4 } }, [9])).resolves.toBeUndefined();
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

  it("should file events about the ACCOUNT, or spanning organisations, in the global chain", () => {
    // The portal default would otherwise put a staff member's sign-out, their
    // personal email preferences, a super-admin grant or a move between
    // organisations into the trail of whichever tenant was on screen.
    for (const [action, arg] of [
      ['"user_logout"', "ip, ua, null);"],
      ['"update_email_prefs"', "ip, ua, null);"],
      ['"update_user_org"', "ip, ua, null);"],
    ] as const) {
      const sites = [...src.matchAll(new RegExp(`logAudit\\(ctx\\.user\\.id, ${action}`, "g"))];
      expect(sites.length, `${action} has moved`).toBeGreaterThan(0);
      for (const m of sites) expect(src.slice(m.index!, m.index! + 260), action).toContain(arg);
    }
    const grants = [...src.matchAll(/logAudit\(ctx\.user\.id, "update_user_role"/g)];
    expect(grants.length).toBe(2);
    for (const m of grants) expect(src.slice(m.index!, m.index! + 200)).toContain('input.role === "super_admin" ? null : undefined');
  });

  it("should name the tenant a record is about where the portal default would guess wrong", () => {
    expect(src).toMatch(/"add_user", "user", newUserId, \{[^}]*\}, ip, ua, targetOrgId\);/);
    const at = src.indexOf('"activate_finserv_operational_demo"');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).toMatch(/\}, ip, ua, target\);/);
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
