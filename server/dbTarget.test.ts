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

/** Every refusal, so a new spelling of "allowed" has to be added here on purpose. */
function refusalFor(url: string, extraProductionHosts?: string): string {
  const verdict = classifyDatabaseTarget(url, extraProductionHosts);
  if (verdict.local) throw new Error(`expected ${url} to be refused, but it was allowed`);
  return describeDbTargetRefusal(verdict);
}

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
    const text = refusalFor(PRODUCTION);
    expect(text).toContain("gateway02.us-east-1.prod.aws.tidbcloud.com");
    expect(text).not.toContain("pw");
    expect(text).not.toContain(PRODUCTION);
  });

  it("should point at the command the developer probably wanted", () => {
    const text = refusalFor(PRODUCTION);
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
      expect(classifyDatabaseTarget(value).local, `${JSON.stringify(value)} must not pass`).toBe(
        false,
      );
    }
  });
});

describe("when the host is simply unfamiliar", () => {
  it("should refuse a staging or tunnelled host rather than guess", () => {
    // Deliberate: an unrecognised host is refused outright. It used to be
    // refused-unless-named, which is what the alias hole exploited.
    for (const host of ["staging.example.com", "10.0.0.5", "my-tunnel.ngrok.io"]) {
      expect(classifyDatabaseTarget(`mysql://u:p@${host}:3306/db`).local, `${host}`).toBe(false);
    }
  });
});

describe("when production is spelled a different way", () => {
  it("should still recognise the DNS root form with its trailing dot", () => {
    // `host.` and `host` reach the same cluster. As different strings they used
    // to land on opposite sides of an exact match, and the non-production side
    // was the overridable one — so the trailing dot WAS the bypass.
    expect(
      classifyDatabaseTarget(
        "mysql://u:p@gateway02.us-east-1.prod.aws.tidbcloud.com.:4000/reconcileai",
      ),
    ).toMatchObject({ local: false, reason: "production" });
  });

  it("should recognise it whatever the casing", () => {
    expect(
      classifyDatabaseTarget("mysql://u:p@GATEWAY02.US-EAST-1.PROD.AWS.TIDBCLOUD.COM:4000/x"),
    ).toMatchObject({ local: false, reason: "production" });
  });

  it("should normalise a configured production host the same way", () => {
    // Otherwise PRODUCTION_DB_HOSTS="Db.Acme.Internal." would never match anything.
    expect(
      classifyDatabaseTarget("mysql://u:p@db.acme.internal:3306/x", " Db.Acme.Internal. "),
    ).toMatchObject({ reason: "production" });
  });

  it("should refuse an alias it does not recognise at all", () => {
    // The point of removing the override: an unlisted alias of production — an
    // IP, a CNAME — is refused anyway. Being un-labelled costs a clearer
    // message, not the protection.
    expect(classifyDatabaseTarget("mysql://u:p@10.20.30.40:4000/reconcileai").local).toBe(false);
  });
});

describe("when a developer looks for a way around the refusal", () => {
  it("should offer none, for production or for any other host", () => {
    // A guard with a documented way around it is a speed bump. This asserts the
    // absence of a lever, so reintroducing one fails here rather than in prod.
    for (const url of [
      PRODUCTION,
      "mysql://u:p@staging.example.com:3306/db",
      "mysql://u:p@10.20.30.40:4000/x",
    ]) {
      const text = refusalFor(url);
      expect(text, url).not.toMatch(/ALLOW_REMOTE_DB_PUSH/);
      expect(text, url).toContain("no override");
    }
  });

  it("should say plainly that production cannot be overridden", () => {
    expect(refusalFor(PRODUCTION)).toContain("cannot be overridden");
  });
});
