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
    //
    // Anchored at "more than zero", NOT at a snapshot count. It was previously
    // `> 10`, which quietly made this test push the wrong way: every `isAdmin`
    // flag removed by scoping a reader to its organization brought the count
    // closer to failing, so correcting a tenancy leak looked like breaking a
    // security test. Four such readers were fixed at once — getUploadBatches,
    // getReconciliationJobs, getReports and getMonitoringStats, each of which
    // used `isAdmin` to mean "drop the tenancy filter" — and the count fell to
    // exactly 10.
    //
    // The right invariant is that the pattern the offender regexes above are
    // built around still exists in the file at all. The goal state for the count
    // itself is zero, and when it gets there this guard should be replaced
    // rather than propped up.
    const adminChecks = [...ROUTERS.matchAll(/ctx\.user\.role === "admin"/g)];
    expect(adminChecks.length).toBeGreaterThan(0);
    // Guards against the file being moved or the read silently returning "".
    expect(ROUTERS.length).toBeGreaterThan(1000);
  });

  it("keeps guests blocked from write procedures", () => {
    // The guard that was always correct: guestProtectedProcedure rejects guests
    // outright. Removing the read widening must not disturb it.
    expect(ROUTERS).toMatch(/guestProtectedProcedure/);
  });
});
