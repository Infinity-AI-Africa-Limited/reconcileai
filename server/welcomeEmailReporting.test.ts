/**
 * What an admin is told when the invitation does not go out.
 *
 * `resolveMagicLinkOrigin` returns "" on an on-premise deployment with no
 * APP_URL, and both senders then decline to send. That is correct — but a
 * refusal upstream is only useful if the operator hears about it. Before this,
 * `admin.addUser` reported plain success and `admin.resendWelcomeLink` reported
 * success with an EMPTY link, so an admin would believe a user had been invited
 * who in fact has no way to sign in, and would not resend.
 *
 * (Greptile P2 on PR #150.)
 *
 * ⚠️ These are SOURCE-SHAPE assertions, not a running call. Driving these two
 * procedures needs a database: both go through `assertCanManageUsers`, which
 * queries before the code under test is reached, and stubbing drizzle deeply
 * enough turned into more scaffolding than the guard it protects. The runtime
 * behaviour that IS exercised lives in magicLinkOrigin.test.ts, which drives
 * both senders end to end and proves they send nothing. What remains unproven
 * at runtime is the propagation from sender to caller — asserted here on the
 * source instead, and each assertion is mutation-checked.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const routersSrc = readFileSync(path.join(__dirname, "routers.ts"), "utf8");

describe("when a welcome email cannot be sent", () => {
  it("should carry the outcome out of admin.addUser rather than a bare success", () => {
    const ret = /return \{ success: true, userId: newUserId(.*?)\};/.exec(routersSrc);
    expect(ret, "admin.addUser return statement not found").not.toBeNull();
    expect(ret![0]).toContain("invited");
  });

  it("should have the admin UI consume that outcome instead of always claiming success", () => {
    const ui = readFileSync(path.join(__dirname, "..", "client", "src", "pages", "AdminUsers.tsx"), "utf8");
    expect(ui).toContain("data.invited");
    // The unconditional "has been sent" toast must no longer be the only path.
    expect(ui).toMatch(/could not be sent/i);
  });

  it("should never hand back an empty magic link as a success", () => {
    // The specific shape that made it look fine: { success: true, magicLink: "" }.
    const resend = routersSrc.slice(routersSrc.indexOf("resendWelcomeLink: adminProcedure"));
    const body = resend.slice(0, resend.indexOf("toggleActive:"));
    expect(body).toMatch(/if \(!success \|\| !magicLink\)/);
    expect(body).toContain("Could not send the sign-in link");
  });

  it("should let that guidance reach the operator instead of a generic message", () => {
    // The message is thrown INSIDE a try whose catch re-wraps everything as
    // "Failed to send welcome link" — which is all the admin UI shows. A
    // deliberate TRPCError has to pass through untouched.
    const resend = routersSrc.slice(routersSrc.indexOf("resendWelcomeLink: adminProcedure"));
    const body = resend.slice(0, resend.indexOf("toggleActive:"));
    const catchBlock = body.slice(body.indexOf("} catch"));
    expect(catchBlock).toMatch(/if \(err instanceof TRPCError\) throw err;/);
    // …and the rethrow must come BEFORE the generic wrapper, or it is dead code.
    expect(catchBlock.indexOf("instanceof TRPCError")).toBeLessThan(catchBlock.indexOf("Failed to send welcome link"));
  });
});
