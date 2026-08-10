/**
 * Assessment lead-pipeline access.
 *
 * `complianceAssessments` holds Infinity AI's OWN sales pipeline — the leads
 * captured by the public CBN readiness tool. Respondent names, work emails,
 * institution names, risk scores. It is platform-operator data, not tenant
 * data, and the table carries no organizationId to scope by because it is not
 * meant to be reachable from inside a tenant at all.
 *
 * Every one of these procedures guarded on `ctx.user.role !== "admin"`, which
 * ANY organisation's admin satisfies. At the time this was found the only two
 * `admin` accounts on the platform were both SHOPLINE retail merchants, who
 * could therefore list the whole pipeline, export it to CSV, and — via
 * bulkSendDemoInvites — send mail to all of it on Infinity AI's behalf.
 *
 * The nav item was `roles: ["admin"]`, so the LINK was hidden from most users.
 * That is the trap this file exists to prevent: hiding a menu entry is not
 * access control, and a reader who sees the nav gate can easily assume the
 * procedure behind it is gated too.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");

/** The assessment router body, isolated from the rest of the 7k-line file. */
const ASSESSMENT_ROUTER = (() => {
  const lines = ROUTERS.split("\n");
  const start = lines.findIndex((l) => /^ {2}assessment: router\(\{/.test(l));
  expect(start, "assessment router not found — has it been renamed or moved?").toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-zA-Z]+: (router\(\{|publicProcedure|protectedProcedure)/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
})();

/**
 * Procedures that operate on the lead pipeline. Each is platform-operator
 * work — reading, exporting, annotating or mailing Infinity AI's own leads.
 */
const OPERATOR_PROCEDURES = [
  "sendDemoInvite",
  "listAll",
  "exportCsv",
  "bulkSendDemoInvites",
  "markContacted",
  "updateNotes",
  "setFollowUpDue",
  "setPipelineStage",
  "countBulkEligible",
];

describe("when a procedure reads or mutates the assessment lead pipeline", () => {
  for (const name of OPERATOR_PROCEDURES) {
    it(`should restrict ${name} to super_admin`, () => {
      const declaration = new RegExp(`^ {4}${name}: (\\w+)`, "m").exec(ASSESSMENT_ROUTER);
      expect(declaration, `${name} not found in the assessment router`).not.toBeNull();
      expect(
        declaration![1],
        `${name} must use superAdminProcedure. This table is Infinity AI's own sales ` +
          `pipeline and has no organizationId to scope by, so any weaker guard exposes ` +
          `every lead to every tenant.`,
      ).toBe("superAdminProcedure");
    });
  }
});

describe("when someone reintroduces a role check instead of a procedure guard", () => {
  it("should have no inline `role !== admin` guards left in the assessment router", () => {
    // These were the original guard, and they read as if they were sufficient.
    // `admin` is an ORGANISATION role — every tenant has admins — so the check
    // let in exactly the people it looked like it was keeping out.
    expect(ASSESSMENT_ROUTER).not.toMatch(/role !== ["']admin["']/);
  });

  it("should not fall back to protectedProcedure for any operator procedure", () => {
    for (const name of OPERATOR_PROCEDURES) {
      expect(
        ASSESSMENT_ROUTER,
        `${name} must not be a bare protectedProcedure`,
      ).not.toMatch(new RegExp(`^ {4}${name}: protectedProcedure`, "m"));
    }
  });
});

describe("when the public submission path is considered", () => {
  it("should keep submit and getByToken public", () => {
    // The whole point of the funnel is that a prospect can submit without an
    // account, and read their own result back by unguessable token. Locking
    // these down would break lead capture — the tightening above must not
    // over-reach into the public path.
    expect(ASSESSMENT_ROUTER).toMatch(/^ {4}submit: publicProcedure/m);
    expect(ASSESSMENT_ROUTER).toMatch(/^ {4}getByToken: publicProcedure/m);
    expect(ASSESSMENT_ROUTER).toMatch(/^ {4}unsubscribe: publicProcedure/m);
  });
});
