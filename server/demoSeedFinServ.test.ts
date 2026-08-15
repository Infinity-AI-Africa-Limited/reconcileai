import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFinServDemoPlan, FINSERV_OPERATIONAL_CASES } from "./demoSeedFinServ";

describe("financial-services operational demo plan", () => {
  it("keeps displayed transaction, match and exception counts internally consistent", () => {
    const plan = buildFinServDemoPlan();

    expect(plan.settlementItems).toBe(320);
    expect(plan.transactionLegs).toBe(640);
    expect(plan.matchedPairs).toBe(304);
    expect(plan.exceptionCases).toBe(16);
    expect(plan.matchRate).toBe("95.00");
    expect(plan.matchedPairs + plan.exceptionCases).toBe(plan.settlementItems);
    // The Transactions view shows both settlement and core-ledger legs. The
    // 16 control cases therefore produce 16 `exception` records and 16
    // `unmatched` counterpart legs alongside 608 matched transaction legs.
    expect(plan.matchedPairs * 2 + plan.exceptionCases * 2).toBe(plan.transactionLegs);
  });

  it("provides current open records for Review Queue and aged work for the Age Tracker", () => {
    const plan = buildFinServDemoPlan();

    expect(plan.reviewQueueOpenToday).toBe(7);
    expect(plan.exceptionStatusCounts).toEqual({
      open: 10,
      in_review: 3,
      resolved: 2,
      escalated: 1,
    });
    expect(FINSERV_OPERATIONAL_CASES.some((item) => item.ageDays >= 3)).toBe(true);
  });

  it("covers the payment rails and control cases a financial-services operator needs to review", () => {
    const plan = buildFinServDemoPlan();
    const categories = new Set(plan.cases.map((item) => item.category));

    expect(plan.rails).toHaveLength(8);
    for (const category of [
      "duplicate_transaction",
      "reversal_unmatched",
      "unmatched",
      "amount_mismatch",
      "timing_difference",
      "missing_counterparty",
      "fx_rate_variance",
    ]) {
      expect(categories.has(category)).toBe(true);
    }
  });
});

// ─── The demo path must never be org-less ────────────────────────────────────
//
// Org-less is a SHARED scope, not a private one: `orgFilter(col, null)` is
// `IS NULL`, so every account without an organisation reads every other one's
// rows. Guests previously had no organisation, so their seeded jobs,
// transactions, matches, exceptions, batches and channels all pooled together —
// and the 22 real accounts that happen to have no organisation would have seen
// the guest demo data too. The eight demo rails also collapsed onto one
// unsuffixed set of channel codes shared between every org-less caller.
describe("guest demo accounts belong to a real organisation", () => {
  const PREWARM = readFileSync(join(__dirname, "prewarmDemoUser.ts"), "utf8");
  const ROUTERS = readFileSync(join(__dirname, "routers.ts"), "utf8");

  it("provisions a dedicated demo organisation", () => {
    expect(PREWARM).toMatch(/export async function ensureGuestDemoOrganization\(/);
    expect(PREWARM).toMatch(/GUEST_DEMO_ORG_CODE = "RECONCILEAI_GUEST_DEMO"/);
  });

  it("flags that organisation as a demo tenant", () => {
    // Otherwise the SLA monitor treats fabricated guest data as real breaches —
    // the failure that produced two spurious 374/382-exception alerts.
    const body = PREWARM.slice(PREWARM.indexOf("export async function ensureGuestDemoOrganization("));
    expect(body.slice(0, 1200)).toMatch(/isDemo: true/);
  });

  it("assigns it to the shared prewarm user, including one created earlier", () => {
    // Scoped to the INSERT specifically. A file-wide match for
    // `organizationId: guestOrgId` is satisfied by the backfill below it, so the
    // creation path could drop the field and this would still pass — verified by
    // deleting it and watching the test stay green.
    const insert = PREWARM.slice(
      PREWARM.indexOf("await db.insert(users).values({"),
      PREWARM.indexOf("const created = await db"),
    );
    expect(insert, "the prewarm user must be created WITH an organisation").toMatch(
      /organizationId: guestOrgId/,
    );
    // A long-lived prewarm account predates this change; without the backfill it
    // would keep seeding into the org-less shared scope forever.
    expect(PREWARM).toMatch(/if \(!demoUser\.organizationId && guestOrgId\)/);
  });

  it("assigns it to the fallback guest created when prewarm has not run", () => {
    const fallback = ROUTERS.slice(ROUTERS.indexOf("const guestOpenId = 'guest_'"));
    expect(fallback.slice(0, 900)).toMatch(/ensureGuestDemoOrganization/);
    expect(fallback.slice(0, 900)).toMatch(/organizationId: guestOrgId/);
  });

  it("keeps demo channel codes org-scoped so tenants cannot collide", () => {
    const SEED = readFileSync(join(__dirname, "demoSeedFinServ.ts"), "utf8");
    expect(SEED).toMatch(/_ORG\$\{organizationId\}/);
  });
});
