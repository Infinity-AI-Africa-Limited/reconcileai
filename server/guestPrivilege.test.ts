/**
 * Guests must not be treated as administrators.
 *
 * Seventeen procedures computed their breadth flag as:
 *
 *     const isAdmin = ctx.user.role === "admin" || ctx.user.isGuest === true;
 *
 * That flag is handed to db readers, where it means "drop the userId filter and
 * return everything in scope". So an unauthenticated demo visitor was granted
 * the widest read the tenancy layer allows.
 *
 * Until the read paths were org-scoped, "everything in scope" meant every
 * tenant's rows. It is now bounded to the guest's own organization — which for
 * the shared demo user is NULL, i.e. the orgless demo and legacy rows — so this
 * is no longer a cross-tenant hole. It is still wrong: a guest should see the
 * demo dataset, not every orgless row ever written, and "guest === admin" is a
 * dangerous idiom to leave lying around for the next reader to copy.
 *
 * Removing it costs the demo nothing. Every guest session resolves to ONE shared
 * pre-warmed demo user, and the demo data is seeded under that user's id, so the
 * ordinary userId filter returns exactly the intended dataset.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");

describe("guest sessions do not inherit admin breadth", () => {
  it("no procedure ORs isGuest into an admin check", () => {
    // Matches either quote style, and any spacing around the ||.
    const offenders = [
      ...ROUTERS.matchAll(/role\s*===\s*['"]admin['"]\s*\|\|\s*ctx\.user\.isGuest/g),
    ];
    expect(
      offenders.length,
      "A procedure treats a guest as an admin. `isAdmin` is passed to db readers " +
        "as 'drop the userId filter', so this grants an unauthenticated demo " +
        "visitor the widest read the tenancy layer permits. Guests resolve to the " +
        "shared demo user and the demo data is seeded under that user's id, so the " +
        "plain `role === \"admin\"` check already shows the full demo dataset.",
    ).toBe(0);
  });

  it("no procedure ORs isGuest in the reverse order either", () => {
    // `isGuest === true || role === "admin"` is the same bug written backwards.
    const reversed = [...ROUTERS.matchAll(/isGuest\s*===\s*true\s*\|\|\s*ctx\.user\.role/g)];
    expect(reversed.length).toBe(0);
  });

  it("still computes an admin breadth flag, so the sweep is not vacuous", () => {
    // If these disappear entirely the assertions above would pass trivially.
    const adminChecks = [...ROUTERS.matchAll(/const isAdmin = ctx\.user\.role === "admin"/g)];
    expect(adminChecks.length).toBeGreaterThan(10);
  });

  it("keeps guests blocked from write procedures", () => {
    // The guard that was always correct: guestProtectedProcedure rejects guests
    // outright. Removing the read widening must not disturb it.
    expect(ROUTERS).toMatch(/guestProtectedProcedure/);
  });
});
