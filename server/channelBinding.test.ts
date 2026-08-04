/**
 * Channel-binding ownership guard.
 *
 * Every ingestion source stores a caller-supplied `channelId` deciding what its
 * transactions reconcile against. Unchecked, an admin can bind a feed to a
 * channel another organization owns. Rows still land under the SOURCE's
 * organizationId — so this is not a cross-tenant read — but one institution's
 * settlements get matched against another's channel, and a foreign channel id
 * becomes bindable and therefore enumerable.
 *
 * The tenancy ratchet in tenancyRatchet.test.ts cannot catch this: it guards
 * id-keyed WRITES in db.ts, and this is a foreign key accepted on the way IN.
 * Hence the second ratchet at the bottom of this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getChannelByIdForOrg = vi.hoisted(() => vi.fn());

vi.mock("../server/db", () => ({
  getChannelByIdForOrg,
  getDb: vi.fn().mockResolvedValue(null),
  createAuditLog: vi.fn(),
}));

import fs from "node:fs";
import path from "node:path";
import { TRPCError } from "@trpc/server";
import { assertChannelBindable } from "./routers/shared";

beforeEach(() => {
  getChannelByIdForOrg.mockReset();
});

describe("assertChannelBindable", () => {
  it("passes when the channel resolves within the caller's scope", async () => {
    getChannelByIdForOrg.mockResolvedValue({ id: 7, organizationId: 42 });
    await expect(assertChannelBindable(42, 7)).resolves.toBeUndefined();
  });

  it("threads the ORGANIZATION into the lookup, not just the id", async () => {
    // The whole defect is a bare-id lookup. If the org stops being passed the
    // guard still "passes" against a foreign channel, so this is the assertion
    // that actually pins the fix rather than its shape.
    getChannelByIdForOrg.mockResolvedValue({ id: 7 });
    await assertChannelBindable(42, 7);
    expect(getChannelByIdForOrg).toHaveBeenCalledWith(7, 42);
  });

  it("rejects a channel outside the caller's scope", async () => {
    getChannelByIdForOrg.mockResolvedValue(undefined);
    await expect(assertChannelBindable(42, 999)).rejects.toThrow(TRPCError);
  });

  it("fails as NOT_FOUND, so it cannot be used to enumerate other tenants", async () => {
    // FORBIDDEN would confirm the channel exists and belongs to someone else —
    // an oracle. "Missing" and "not yours" must be indistinguishable.
    getChannelByIdForOrg.mockResolvedValue(undefined);
    await expect(assertChannelBindable(42, 999)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("fails closed when the channel lookup cannot reach the database", async () => {
    // getChannelByIdForOrg returns undefined when getDb() is null. That must
    // refuse the binding, never wave it through.
    getChannelByIdForOrg.mockResolvedValue(undefined);
    await expect(assertChannelBindable(1, 1)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

/**
 * Ratchet — a domain router that accepts a channelId must also prove ownership.
 *
 * This is the part that fixes the CLASS. SFTP and bucket drops each shipped
 * without the guard and were found only by reading them; the next ingestion
 * transport should fail a test instead.
 */
describe("channel-binding ratchet", () => {
  /** Routers that take a channelId but legitimately need no guard. Give a reason. */
  const ALLOWED: Record<string, string> = {};

  const dir = path.join(__dirname, "routers");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    // Only files that ACCEPT a channelId as tRPC input are in scope.
    if (!/channelId:\s*z\.number/.test(source)) continue;
    if (ALLOWED[file]) continue;

    it(`${file} proves channel ownership before storing a channelId`, () => {
      // Deliberately the CALL form, not the bare name: `import { … }` alone
      // would otherwise satisfy this, and a router that imports the guard and
      // forgets to invoke it is exactly the regression being ratcheted against.
      expect(
        /assertChannelBindable\s*\(/.test(source),
        `${file} accepts a caller-supplied channelId but never calls assertChannelBindable(). ` +
          `Add the guard, or add the file to ALLOWED with a reason.`,
      ).toBe(true);
    });
  }

  it("covers the SFTP create path in the core router", () => {
    // routers.ts is not under server/routers/, so it is asserted explicitly
    // rather than by the directory sweep above.
    const core = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
    expect(/assertChannelBindable\s*\(/.test(core)).toBe(true);
  });

  it("scans a non-empty set of routers, so the sweep cannot silently pass", () => {
    const scanned = files.filter((f) =>
      /channelId:\s*z\.number/.test(fs.readFileSync(path.join(dir, f), "utf8")),
    );
    expect(scanned.length).toBeGreaterThan(0);
  });
});
