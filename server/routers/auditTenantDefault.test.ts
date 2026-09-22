/**
 * An audit record belongs in the trail of the tenant the action was for.
 *
 * `logAudit` defaulted an omitted organisation to the PORTAL tenant alone, so
 * every ordinary user's action — a bank's own staff resolving exceptions,
 * approving matches, uploading files — joined the global chain, which no
 * tenant's Audit Trail, export or chain verification reads. The default is now
 * the tenant the request acts for; where the default cannot know (staff acting
 * on a tenant's row from outside a portal, work outside a request), the call
 * site names the row's own tenant.
 *
 * Runs real procedures through the real base procedure. routers.ts cannot be
 * imported in a test (it boots the scheduler, SFTP and SLA monitor against the
 * configured database — production on a developer machine), so its call sites
 * are pinned by source text.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.hoisted(() => {
  process.env.DATABASE_URL = "";
});
vi.mock("../db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: vi.fn(async () => null),
  createAuditLog: vi.fn(async () => {}),
}));

import * as db from "../db";
import { router, protectedProcedure, publicProcedure } from "../_core/trpc";
import {
  auditOrganizationFor,
  currentAuditOrganizationId,
  currentPortalOrganizationId,
} from "../_core/requestScope";
import { auditTenant, canActOnTenant, logAudit, superAdminProcedure } from "./shared";

const probe = router({
  act: protectedProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "resolve_exception", "exception", 9);
    return { audit: currentAuditOrganizationId(), portal: currentPortalOrganizationId() };
  }),
  actGlobal: protectedProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "user_logout", "user_session", undefined, undefined, undefined, undefined, null);
  }),
  actOn: protectedProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "export_csv", "reconciliation_job", 5, undefined, undefined, undefined, 30009);
  }),
  anonymous: publicProcedure.mutation(async () => {
    await logAudit(null, "public_event", "platform");
  }),
  reach: protectedProcedure.query(({ ctx }) => canActOnTenant(ctx.user, 30009)),
  platform: superAdminProcedure.mutation(async ({ ctx }) => {
    await logAudit(ctx.user.id, "create_organization", "organization", 77);
  }),
});

type Who = { id: number; role: string; organizationId: number | null };
const as = (user: Who | null, viewingAs: number | null = null) =>
  probe.createCaller({ user: user ? { ...user, isReadOnly: false } : null, viewingAs, req: { headers: {} }, res: {} } as never);
const auditedOrg = () => vi.mocked(db.createAuditLog).mock.calls.at(-1)?.[0]?.organizationId;

const bankOps: Who = { id: 11, role: "operations", organizationId: 4 };
const bankAdmin: Who = { id: 12, role: "admin", organizationId: 4 };
const staff: Who = { id: 1, role: "super_admin", organizationId: 30002 };

beforeEach(() => vi.clearAllMocks());

describe("when a tenant's own user acts", () => {
  it("should file the record in their organisation's trail — not the global chain", async () => {
    await as(bankOps).act();
    expect(auditedOrg()).toBe(4);
    await as(bankAdmin).act();
    expect(auditedOrg()).toBe(4);
  });

  it("should leave the portal unset, so no by-id gate reads their organisation as a portal", async () => {
    expect(await as(bankOps).act()).toEqual({ audit: 4, portal: null });
  });

  it("should still honour an explicit global chain or an explicitly named tenant", async () => {
    await as(bankOps).actGlobal();
    expect(auditedOrg()).toBeNull();
    await as(bankOps).actOn();
    expect(auditedOrg()).toBe(30009);
  });
});

describe("when the caller belongs to no tenant", () => {
  it("should use the global chain — never a pseudo-tenant 0", async () => {
    await as({ id: 13, role: "operations", organizationId: null }).act();
    expect(auditedOrg()).toBeNull();
    await as({ id: 14, role: "operations", organizationId: 0 }).act();
    expect(auditedOrg()).toBeNull();
  });

  it("should use the global chain for an unauthenticated call", async () => {
    await as(null).anonymous();
    expect(auditedOrg()).toBeNull();
  });
});

describe("when staff act", () => {
  it("should file in the tenant on screen inside a portal", async () => {
    // Inside a portal the context has already made the tenant their organisation.
    await as({ ...staff, organizationId: 30009 }, 30009).act();
    expect(auditedOrg()).toBe(30009);
  });

  it("should file in the global chain outside a portal — they act for the platform, not their own org", async () => {
    await as(staff).act();
    expect(auditedOrg()).toBeNull();
  });

  it("should keep their cross-tenant reach outside a portal", async () => {
    expect(await as(staff).reach()).toBe(true);
  });

  it("should file a platform procedure's record in the global chain, portal or not", async () => {
    await as(staff).platform();
    expect(auditedOrg()).toBeNull();
    await as({ ...staff, organizationId: 30009 }, 30009).platform();
    expect(auditedOrg()).toBeNull();
  });
});

describe("when the default is computed", () => {
  it("should map each caller to the tenant it acts for", () => {
    expect(auditOrganizationFor(bankOps, null)).toBe(4);
    expect(auditOrganizationFor(bankOps, 30009)).toBe(4); // a portal id from a non-staff caller means nothing
    expect(auditOrganizationFor(staff, 30009)).toBe(30009);
    expect(auditOrganizationFor(staff, null)).toBeNull();
    expect(auditOrganizationFor(staff, 0)).toBeNull();
    expect(auditOrganizationFor({ role: "user", organizationId: 0 }, null)).toBeNull();
    expect(auditOrganizationFor({ role: "user", organizationId: -3 }, null)).toBeNull();
    expect(auditOrganizationFor(null, 30009)).toBeNull();
  });

  it("should map a row's tenant to its chain, and 'no tenant' to the global one", () => {
    expect(auditTenant(4)).toBe(4);
    for (const none of [null, undefined, 0, -1, 1.5]) expect(auditTenant(none), String(none)).toBeNull();
  });

  it("should carry no tenant outside a tRPC call at all", async () => {
    expect(currentAuditOrganizationId()).toBeNull();
    await logAudit(1, "background", "job");
    expect(auditedOrg()).toBeNull();
  });
});

describe("when a call site knows the tenant better than the default", () => {
  const root = join(__dirname, "..");
  const read = (p: string) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");
  const routers = read("routers.ts");
  /** Each logAudit call for `action`, from its start to its closing `);`. */
  const calls = (src: string, action: string) =>
    [...src.matchAll(new RegExp(`logAudit\\([^,]+, (?:[^,]*\\? )?"${action}"`, "g"))].map((m) => {
      const end = src.indexOf(");", m.index!);
      return src.slice(m.index!, end + 2);
    });

  it("should name the managed user's own tenant — the Super Admin dashboard manages every tenant's users", () => {
    for (const action of ["resend_welcome_link", "delete_user", "activate_user"]) {
      const found = calls(routers, action);
      expect(found.length, `${action} has moved`).toBeGreaterThan(0);
      for (const c of found) expect(c, action).toMatch(/tenantOf\.get\((input\.userId|userId|target\.id)\)\);$/);
    }
    // Every guard's answer is used: six mutations audit a managed user.
    expect([...routers.matchAll(/const tenantOf = await assertCanManageUsers\(/g)].length).toBe(6);
  });

  it("should name the tenant whose configuration the operator changed", () => {
    for (const action of ["update_org_segment", "update_org_sso", "update_org_ai_assistance", "update_org_banking_model", "update_org_is_demo"]) {
      const [c] = calls(routers, action);
      expect(c, `${action} has moved`).toBeDefined();
      expect(c, action).toMatch(/\}, undefined, undefined, input\.organizationId\);$/);
    }
    const modules = read("routers/modules.ts");
    for (const action of ["set_org_module_override", "clear_org_module_override"]) {
      const [c] = calls(modules, action);
      expect(c, `${action} has moved`).toBeDefined();
      expect(c, action).toMatch(/ip, ua, input\.organizationId\);$/);
    }
  });

  it("should name a job's own tenant where staff can reach any tenant's job", () => {
    for (const [action, arg] of [
      ["export_csv", "auditTenant(visibleJob.organizationId));"],
      ["export_xlsx", "auditTenant(visibleJob.organizationId));"],
      ["send_email_report", "auditTenant(visibleJob.organizationId));"],
      ["generate_report", "auditTenant(jobOrgId));"],
    ] as const) {
      const [c] = calls(routers, action);
      expect(c, `${action} has moved`).toBeDefined();
      expect(c.endsWith(arg), `${action}: ${c.slice(-80)}`).toBe(true);
    }
    const [view] = calls(read("routers/reconciliation.ts"), "view_reconciliation_job");
    expect(view).toBeDefined();
    expect(view.endsWith("auditTenant(job.organizationId));")).toBe(true);
  });

  it("should name the run's own tenant for work on the job queue, which has no request", () => {
    const [c] = calls(routers, "complete_reconciliation");
    expect(c).toBeDefined();
    expect(c.endsWith("auditTenant(runOrganizationId));")).toBe(true);
  });

  it("should check the job is the caller's before emailing its report", () => {
    // sendReport took any tenant's job id; "Job not found" vs success told the
    // caller which ids exist.
    const at = routers.indexOf("const result = await sendReconciliationReport(input.jobId");
    expect(at, "sendReport has moved").toBeGreaterThan(-1);
    expect(routers.slice(Math.max(0, at - 400), at)).toContain("const visibleJob = await assertJobVisible(ctx.user, input.jobId);");
  });

  it("should place storage access decisions by the object's tenant", () => {
    expect(read("_core/storageProxy.ts")).toContain("organizationId: storageAuditTenant(allowed, keyOrgId, user!),");
  });
});
