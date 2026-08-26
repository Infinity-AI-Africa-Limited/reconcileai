/**
 * The `db:push` guard.
 *
 * Three deploys have been broken by a migration reaching production outside the
 * runner (0084, 0085, 0090), and §12 warned about it in prose the whole time.
 * These pin the two cases that actually matter: the real production host must be
 * refused, and CI's own database must not be.
 */
import { describe, it, expect } from "vitest";
import { classifyDatabaseTarget, describeDbTargetRefusal } from "./dbTarget";

const PRODUCTION = "mysql://user:pw@gateway02.us-east-1.prod.aws.tidbcloud.com:4000/reconcileai";
const CI = "mysql://root:root@127.0.0.1:3306/reconcileai_test";

describe("when db:push points at the real production database", () => {
  it("should refuse it", () => {
    // The exact host this repo's local .env carries, which is how 0084, 0085 and
    // 0090 reached production before their PRs merged.
    const verdict = classifyDatabaseTarget(PRODUCTION);
    expect(verdict.local).toBe(false);
    expect(verdict.host).toBe("gateway02.us-east-1.prod.aws.tidbcloud.com");
  });

  it("should name the host in the refusal, and never the URL", () => {
    // The host makes the mistake obvious; the URL carries the password.
    const verdict = classifyDatabaseTarget(PRODUCTION);
    if (verdict.local) throw new Error("expected production to be refused");
    const text = describeDbTargetRefusal(verdict, "ALLOW_REMOTE_DB_PUSH");
    expect(text).toContain("gateway02.us-east-1.prod.aws.tidbcloud.com");
    expect(text).not.toContain("pw");
    expect(text).not.toContain(PRODUCTION);
  });

  it("should point at the command the developer probably wanted", () => {
    const verdict = classifyDatabaseTarget(PRODUCTION);
    if (verdict.local) throw new Error("expected production to be refused");
    const text = describeDbTargetRefusal(verdict, "ALLOW_REMOTE_DB_PUSH");
    expect(text).toContain("pnpm db:migrate");
    expect(text).toContain("drizzle-kit generate");
  });
});

describe("when db:push points at a throwaway database", () => {
  it("should allow CI's own MySQL service", () => {
    // CI runs `pnpm db:push` on every Tests job. Breaking that would make this
    // guard worse than the problem it solves.
    expect(classifyDatabaseTarget(CI)).toMatchObject({ local: true, host: "127.0.0.1" });
  });

  it("should allow the usual local and container hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "host.docker.internal", "mysql", "db"]) {
      const url = `mysql://root:root@${host === "::1" ? "[::1]" : host}:3306/test`;
      expect(classifyDatabaseTarget(url).local, `${host} should be treated as local`).toBe(true);
    }
  });

  it("should not care about case", () => {
    expect(classifyDatabaseTarget("mysql://root@LOCALHOST:3306/test").local).toBe(true);
  });
});

describe("when DATABASE_URL is missing or malformed", () => {
  it("should refuse rather than assume it is safe", () => {
    // Fails closed: an unreadable target is not evidence of a harmless one.
    for (const value of [undefined, null, "", "   ", "not a url"]) {
      expect(classifyDatabaseTarget(value).local, `${JSON.stringify(value)} must not pass`).toBe(false);
    }
  });
});

describe("when the host is simply unfamiliar", () => {
  it("should refuse a staging or tunnelled host rather than guess", () => {
    // Deliberate: a new environment should be named on purpose, not inherit
    // permission from a pattern that happens to match.
    for (const host of ["staging.example.com", "10.0.0.5", "my-tunnel.ngrok.io"]) {
      expect(classifyDatabaseTarget(`mysql://u:p@${host}:3306/db`).local, `${host}`).toBe(false);
    }
  });
});

describe("when the target is production", () => {
  it("should be classified apart from any other remote host", () => {
    // Not the same decision: pushing to a colleague's staging box is a choice
    // someone may legitimately make; pushing an unreviewed working-tree
    // migration to the live product is what broke 0084, 0085 and 0090.
    expect(classifyDatabaseTarget(PRODUCTION)).toMatchObject({ local: false, reason: "production" });
    expect(classifyDatabaseTarget("mysql://u:p@staging.example.com:3306/db")).toMatchObject({
      local: false,
      reason: "remote_host",
    });
  });

  it("should say plainly that it cannot be overridden, and offer no escape hatch", () => {
    const verdict = classifyDatabaseTarget(PRODUCTION);
    if (verdict.local) throw new Error("expected production to be refused");
    const text = describeDbTargetRefusal(verdict, "ALLOW_REMOTE_DB_PUSH");
    expect(text).toContain("cannot be overridden");
    expect(text).toContain("no override for production");
    // The refusal must not hand over the very lever it is refusing to provide.
    expect(text).not.toMatch(/set ALLOW_REMOTE_DB_PUSH=/);
  });

  it("should still offer the named override for an ordinary remote host", () => {
    const verdict = classifyDatabaseTarget("mysql://u:p@staging.example.com:3306/db");
    if (verdict.local) throw new Error("expected a refusal");
    const text = describeDbTargetRefusal(verdict, "ALLOW_REMOTE_DB_PUSH");
    // Named, not `=1`, so a stale value in a shell profile cannot authorise a
    // host it was never meant for.
    expect(text).toContain("ALLOW_REMOTE_DB_PUSH=staging.example.com");
  });

  it("should let another deployment name its own production host", () => {
    expect(
      classifyDatabaseTarget("mysql://u:p@db.acme.internal:3306/x", "db.acme.internal"),
    ).toMatchObject({ reason: "production" });
  });
});
