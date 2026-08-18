/**
 * What the retail vertical shows — as an EXACT set, for every viewer.
 *
 * The previous rules here were written one surface at a time, and each was
 * correct about the case it was written for and silent about the one beside it.
 * Segment scoping was checked for tenants but not for staff inside a portal;
 * route access was checked for the spelling in NAV_ITEMS but not the aliases the
 * router also accepts. Every one of those gaps was found by someone else.
 *
 * So this file does not spot-check. It pins the WHOLE set a retail viewer can
 * see and enumerates every role, including the portal composition. A new nav
 * entry that is not deliberately scoped fails here on the day it is added,
 * whoever adds it and whichever surface they were thinking about — which is the
 * only way this stops depending on someone remembering to look.
 */
import { describe, it, expect } from "vitest";
import { NAV_ITEMS, navFor } from "./navItems";
import { canReachPath } from "./routeAccess";

/**
 * Every path a retail tenant may see, in sidebar order.
 *
 * This is the portal set: segment filtering only, with the operator's own group
 * and staff tools removed. A merchant's own sidebar is this list narrowed
 * further by role, never widened, which the subset assertions below enforce.
 *
 * Adding a line here is a decision that the surface belongs to a merchant.
 * Removing one is a decision that it does not. Neither should happen by accident.
 */
const RETAIL_APPROVED = [
  // Retail's own surfaces — the reason the vertical exists.
  "/settlement-monitor",
  "/dashboard",
  "/shopline/sync-status",
  "/shopline/connect",
  // Merchant controls for SHOPLINE orders, payments, and settlement breaks.
  "/exceptions",
  "/transactions",
  "/admin/users",
];

/**
 * Surfaces that must never appear for retail, with the reason each is another
 * vertical's. Named individually so a regression says WHY, not just "unexpected".
 */
const DENIED_FOR_RETAIL: Record<string, string> = {
  "/distributors": "distributors are the corporate B2B sector's concept; a merchant has none",
  "/cbn-compliance": "a Nigerian banking-regulator return pack; a merchant answers to card schemes",
  "/woodcore-connector": "onboards bank and MFB clients through a core banking system",
  "/compliance": "NDPA 2023 / NDPR 2019 and CBN retention rules — none of which govern a SHOPLINE merchant",
  "/sample-data": "seeds core_banking, nibss and bank_statement channels: a Nigerian banking demo",
  "/dashboard/auditor": "examination-facing; a merchant has no supervisory examiner",
  "/super-agent": "agent configuration is a platform operating surface, not a merchant workflow",
  "/exception-intelligence": "cross-institution intelligence is not part of the Shopline merchant submission surface",
  "/upload": "Shopline data arrives through authorised API and webhooks, not generic batch upload",
  "/reconciliation": "the merchant uses Settlement Monitor rather than a generic job-control screen",
  "/reports": "the generic reconciliation-job report is not a Shopline merchant report",
  "/schedules": "Shopline synchronisation is managed by the connection, not merchant cron settings",
  "/monitor": "platform-monitoring is not a merchant workflow",
  "/documentation": "Shopline support is supplied through the merchant support route",
  "/channels": "the post-install path uses Shopline sync status rather than multi-channel configuration",
  "/age-tracker": "bank exception ageing is not a Shopline merchant workflow",
  "/review": "bank-style review queues are not part of the merchant product surface",
  "/audit": "audit-trail administration is retained for regulated financial-services deployments",
  "/modules": "module configuration is an enterprise deployment control, not a Shopline merchant control",
  "/email-settings": "generic email configuration is not a Shopline submission workflow",
  "/integrations": "Shopline connection is the dedicated merchant integration surface",
  "/api-ingestion": "generic API ingestion is not used by the Shopline merchant flow",
  "/sftp-config": "SFTP ingestion is outside the Shopline merchant flow",
  "/bucket-config": "bucket-drop ingestion is outside the Shopline merchant flow",
  "/email-forwarding": "email ingestion is outside the Shopline merchant flow",
  "/anomalies": "cross-channel anomaly tooling is not part of the Tier 1 Shopline merchant experience",
};

/** Every role a person inside a merchant's tenant can hold. */
const MERCHANT_ROLES = ["admin", "operations", "cfo", "compliance", "user"] as const;

describe("when anyone views the retail vertical", () => {
  it("should offer exactly the approved set inside a tenant portal", () => {
    // The portal is the widest retail view: role gating is dropped because staff
    // are looking at the tenant's surface rather than exercising their own
    // permissions. If anything is wrong anywhere, it is wrong here.
    const paths = navFor("retail_commerce", "super_admin", { portal: true }).map((e) => e.path);
    expect([...paths].sort()).toEqual([...RETAIL_APPROVED].sort());
  });

  it.each(MERCHANT_ROLES)("should show %s nothing outside the approved set", (role) => {
    const paths = navFor("retail_commerce", role).map((e) => e.path);
    const unexpected = paths.filter((p) => !RETAIL_APPROVED.includes(p));
    expect(unexpected, `not approved for retail: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("should show a super_admin ROLE inside a retail org nothing outside the approved set", () => {
    // A tenant user can be promoted to super_admin without leaving their
    // organisation (admin.updateRole), so this combination is reachable and is
    // the one place role-keyed staff tools could leak into a merchant's sidebar.
    const paths = navFor("retail_commerce", "super_admin", { portal: true }).map((e) => e.path);
    expect(paths.filter((p) => p.startsWith("/admin/super-admin"))).toEqual([]);
    expect(paths).not.toContain("/demo-dashboard");
    expect(paths).not.toContain("/admin/assessments");
  });
});

describe("when a surface belongs to another vertical", () => {
  it.each(Object.entries(DENIED_FOR_RETAIL))("should keep %s out of every retail sidebar (%s)", (path) => {
    for (const role of MERCHANT_ROLES) {
      expect(navFor("retail_commerce", role).map((e) => e.path), role).not.toContain(path);
    }
    expect(navFor("retail_commerce", "super_admin", { portal: true }).map((e) => e.path)).not.toContain(path);
  });

  it.each(Object.keys(DENIED_FOR_RETAIL))("should also make %s unreachable by URL", (path) => {
    // Hiding the link is not the boundary. routeAccess derives from NAV_ITEMS, so
    // this holds automatically — and fails loudly if that derivation is broken.
    expect(canReachPath(path, "retail_commerce", "admin")).toBe(false);
    expect(canReachPath(path, "retail_commerce", "super_admin", { portal: true })).toBe(false);
  });
});

describe("when the rest of the platform is considered", () => {
  it("should not have narrowed any other vertical by accident", () => {
    // Scoping a surface away from retail must not remove it from the verticals
    // that do use it. Data Protection and Sample Data were unscoped before; both
    // must survive for the two verticals named on them.
    for (const path of ["/compliance", "/sample-data"]) {
      const entry = NAV_ITEMS.find((e) => e.path === path)!;
      expect(entry.segments, path).toEqual(["financial_services", "corporate_b2b"]);
      expect(canReachPath(path, "financial_services", "admin"), path).toBe(true);
      expect(canReachPath(path, "corporate_b2b", "admin"), path).toBe(true);
    }
  });

  it("should make every merchant route explicitly retail-scoped", () => {
    const retailEntries = NAV_ITEMS.filter((entry) => entry.segments?.includes("retail_commerce"));
    expect(retailEntries.map((entry) => entry.path).sort()).toEqual([...RETAIL_APPROVED].sort());
  });
});
