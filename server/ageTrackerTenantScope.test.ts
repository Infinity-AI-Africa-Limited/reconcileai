import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Age Tracker tenant scope", () => {
  const dbSource = fs.readFileSync("server/db.ts", "utf8");
  const routerSource = fs.readFileSync("server/routers.ts", "utf8");

  it("requires an organization id for aged-exception reads and applies it in SQL", () => {
    expect(dbSource).toContain("getOpenExceptionsForAging(organizationId: number | null");
    expect(dbSource).toContain("orgFilter(exceptions.organizationId, organizationId)");
  });

  it("passes the caller organization into summary, list and bulk escalation flows", () => {
    const scopedCall = "getOpenExceptionsForAging(ctx.user.organizationId ?? null)";
    expect(routerSource.split(scopedCall)).toHaveLength(4);
    expect(routerSource).not.toContain("getOpenExceptionsForAging();");
  });
});
