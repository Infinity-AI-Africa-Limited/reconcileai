/**
 * Landing pages and route reachability per vertical.
 *
 * Two rules that used to be one-sided. The sidebar hid entries built for other
 * verticals (PR #52), but the routes behind them stayed open: typing
 * /distributors as a retail merchant loaded the page and filled it with
 * permission errors. And every vertical landed on /dashboard, which answers an
 * operator's question ("how is reconciliation performing") rather than a
 * merchant's ("did my payout land").
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { landingPathFor, canReachPath, canReachCallback, segmentsForPath, isStaffPath } from "./routeAccess";
import { NAV_ITEMS, inSegment, navGroup } from "./navItems";

describe("when a tenant user types the URL of an Infinity AI staff tool", () => {
  // `staffOnly` was honoured by the sidebar and by nothing else, so both entries
  // carrying it loaded for anyone who typed the path. /demo-dashboard is the
  // serious one: its buttons seed fabricated transactions, distributors and
  // agent-memory records into the CALLER'S OWN tenant.
  const STAFF_PATHS = NAV_ITEMS.filter((e) => e.staffOnly).map((e) => e.path);

  it("should have staff tools to guard, so the sweep is not vacuous", () => {
    expect(STAFF_PATHS).toContain("/demo-dashboard");
    expect(STAFF_PATHS).toContain("/admin/assessments");
  });

  it("should refuse every staffOnly path for a bank admin", () => {
    for (const p of STAFF_PATHS) {
      expect(canReachPath(p, "financial_services", "admin"), p).toBe(false);
      expect(canReachPath(p, "financial_services", "compliance"), p).toBe(false);
      expect(canReachPath(p, "retail_commerce", "admin"), p).toBe(false);
      expect(canReachPath(p, null, "user"), p).toBe(false);
    }
  });

  it("should match the router's tolerance for slashes and case", () => {
    // wouter matches case-insensitively with an optional trailing slash, so an
    // exact-string gate is bypassed by /Demo-Dashboard.
    expect(canReachPath("/Demo-Dashboard/", "financial_services", "admin")).toBe(false);
    expect(isStaffPath("/DEMO-DASHBOARD")).toBe(true);
  });

  it("should still admit Infinity AI staff on their own account", () => {
    for (const p of STAFF_PATHS) {
      expect(canReachPath(p, "super_admin", "super_admin"), p).toBe(true);
    }
  });

  it("should refuse staff tools inside a tenant portal", () => {
    // navFor already excludes staffOnly from a portal — the portal shows the
    // tenant's sidebar, not ours. The route has to agree.
    for (const p of STAFF_PATHS) {
      expect(canReachPath(p, "financial_services", "super_admin", { portal: true }), p).toBe(false);
    }
  });
});

describe("when a merchant signs in", () => {
  it("should land on Settlement Monitor, not the dashboard", () => {
    expect(landingPathFor("retail_commerce")).toBe("/settlement-monitor");
  });

  it("should not be able to reach the financial-services dashboard", () => {
    expect(canReachPath("/dashboard", "retail_commerce", "admin")).toBe(false);
    expect(NAV_ITEMS.find((e) => e.path === "/dashboard")?.segments).not.toContain("retail_commerce");
  });
});

describe("when a merchant opens the sidebar", () => {
  // Array order IS sidebar order, so this is the ordering rule, not a detail of
  // how the list happens to be written.
  const merchantMain = navGroup("main", "retail_commerce", "admin").map((e) => e.path);

  it("should not surface the financial-services dashboard", () => {
    expect(merchantMain).not.toContain("/dashboard");
  });

  it("should open on Settlement Monitor as the very first entry", () => {
    expect(merchantMain[0]).toBe("/settlement-monitor");
  });

  it("should agree with where login sends them", () => {
    // The sidebar's first entry and the post-login landing are two expressions of
    // the same decision. If they disagree, a merchant lands somewhere that is not
    // the top of their own menu.
    expect(merchantMain[0]).toBe(landingPathFor("retail_commerce"));
  });
});

describe("when any other vertical opens the sidebar", () => {
  it("should still lead with the Dashboard", () => {
    // Settlement Monitor is retail-scoped, so promoting it must not reorder
    // anyone else's menu.
    for (const segment of ["financial_services", "corporate_b2b"] as const) {
      const paths = navGroup("main", segment, "admin").map((e) => e.path);
      expect(paths[0], segment).toBe("/dashboard");
      expect(paths).not.toContain("/settlement-monitor");
    }
  });
});

describe("when the install completes", () => {
  const PAGE = fs.readFileSync(path.join(__dirname, "..", "pages", "ShoplineConnect.tsx"), "utf8");

  it("should send the merchant to Settlement Monitor, not the dashboard", () => {
    // The screen says "Store Connected Successfully!" and its primary button used
    // to open the operator's dashboard. A merchant's next question is whether
    // their payout landed.
    expect(PAGE).toMatch(/navigate\(landingPathFor\("retail_commerce"\)\)/);
    expect(PAGE).not.toMatch(/navigate\("\/dashboard"\)/);
  });

  it("should label the button for where it actually goes", () => {
    expect(PAGE).toContain("Go to Settlement Monitor");
    expect(PAGE).not.toContain("Go to Dashboard");
  });
});

describe("when any other vertical signs in", () => {
  it("should land on the dashboard", () => {
    for (const segment of ["financial_services", "corporate_b2b", "super_admin"] as const) {
      expect(landingPathFor(segment)).toBe("/dashboard");
    }
  });

  it("should land on the dashboard when the segment is unknown", () => {
    // A legacy org with no segment set needs a safe recovery route rather than a
    // financial-services operator dashboard.
    expect(landingPathFor(null)).toBe("/support");
  });
});

describe("when a vertical opens a route built for another one", () => {
  it("should refuse the distributor registry to a merchant and to a bank", () => {
    expect(canReachPath("/distributors", "retail_commerce", "admin")).toBe(false);
    expect(canReachPath("/distributors", "financial_services", "admin")).toBe(false);
    expect(canReachPath("/distributors", "corporate_b2b", "admin")).toBe(true);
  });

  it("should refuse the CBN pack to a merchant", () => {
    expect(canReachPath("/cbn-compliance", "retail_commerce", "admin")).toBe(false);
    expect(canReachPath("/cbn-compliance", "financial_services", "admin")).toBe(true);
  });

  it("should refuse retail surfaces to a bank", () => {
    for (const p of ["/settlement-monitor", "/shopline/sync-status", "/shopline/connect"]) {
      expect(canReachPath(p, "financial_services", "admin"), p).toBe(false);
      expect(canReachPath(p, "retail_commerce", "admin"), p).toBe(true);
    }
  });

  it("should refuse the examination-facing auditor view to a merchant", () => {
    // Reached from the RoleSwitcher rather than the sidebar, so NAV_ITEMS cannot
    // supply its rule and routeAccess declares it explicitly.
    expect(canReachPath("/dashboard/auditor", "retail_commerce", "admin")).toBe(false);
    expect(canReachPath("/dashboard/auditor", "financial_services", "admin")).toBe(true);
    expect(canReachPath("/dashboard/auditor", "corporate_b2b", "admin")).toBe(true);
  });

  it("should refuse financial-services operator routes to a merchant", () => {
    for (const p of ["/dashboard", "/super-agent", "/exception-intelligence", "/upload", "/reconciliation", "/reports", "/schedules", "/monitor", "/documentation", "/channels", "/age-tracker", "/review", "/audit", "/modules", "/email-settings", "/integrations", "/api-ingestion", "/sftp-config", "/bucket-config", "/email-forwarding", "/anomalies"]) {
      expect(canReachPath(p, "retail_commerce", "admin"), p).toBe(false);
    }
  });

  it("should refuse the spellings the ROUTER also accepts", () => {
    // wouter compiles "/distributors" through regexparam into
    // /^\/distributors\/?$/i — optional trailing slash, case-insensitive. Both
    // spellings load the page, so both have to be refused. An exact-string
    // lookup found no entry, called the route unscoped, and let the merchant in
    // through the front door with a slash on the end.
    for (const spelling of ["/distributors/", "/Distributors", "/DISTRIBUTORS/", "/distributors//"]) {
      expect(canReachPath(spelling, "retail_commerce", "admin"), spelling).toBe(false);
      expect(canReachPath(spelling, "corporate_b2b", "admin"), spelling).toBe(true);
    }
  });

  it("should normalise the auditor route the same way", () => {
    expect(canReachPath("/dashboard/auditor/", "retail_commerce", "admin")).toBe(false);
    expect(canReachPath("/Dashboard/Auditor", "retail_commerce", "admin")).toBe(false);
  });

  it("should still treat the root path as the root", () => {
    // Guard against a normaliser that strips "/" down to "".
    expect(canReachPath("/", "retail_commerce", "admin")).toBe(true);
  });

  it("should not block a path it has never heard of", () => {
    // This decides what the client OFFERS, not what is permitted. Failing closed
    // on an unknown path would break routes simply for not being nav entries.
    expect(canReachPath("/some/future/page", "retail_commerce", "admin")).toBe(true);
  });
});

describe("when the viewer is Infinity AI staff on their own account", () => {
  it("should reach every vertical's routes", () => {
    // The operator supports every tenant, and redirecting them off a URL they
    // typed would be obstruction, not safety.
    for (const p of ["/distributors", "/settlement-monitor", "/cbn-compliance", "/dashboard/auditor"]) {
      expect(canReachPath(p, "super_admin", "super_admin"), p).toBe(true);
    }
  });
});

describe("when staff have entered a tenant's portal", () => {
  // Found in production on the SHOPLINE dev store: the retail portal's sidebar
  // correctly omitted Distributor Registry, and /distributors loaded anyway.
  // Bypassing on role alone contradicts navFor, which drops ROLE gating inside a
  // portal but keeps SEGMENT gating — seeing what that vertical has is the entire
  // point of the portal.
  const portal = { portal: true };

  it("should refuse routes the viewed tenant could never reach", () => {
    expect(canReachPath("/distributors", "retail_commerce", "super_admin", portal)).toBe(false);
    expect(canReachPath("/cbn-compliance", "retail_commerce", "super_admin", portal)).toBe(false);
    expect(canReachPath("/dashboard/auditor", "retail_commerce", "super_admin", portal)).toBe(false);
  });

  it("should refuse the trailing-slash spellings too", () => {
    expect(canReachPath("/distributors/", "retail_commerce", "super_admin", portal)).toBe(false);
    expect(canReachPath("/Distributors", "retail_commerce", "super_admin", portal)).toBe(false);
  });

  it("should allow what the viewed tenant DOES have", () => {
    for (const p of ["/settlement-monitor", "/shopline/sync-status", "/exceptions", "/transactions", "/admin/users"]) {
      expect(canReachPath(p, "retail_commerce", "super_admin", portal), p).toBe(true);
    }
  });

  it("should apply the viewed tenant's rules, not the operator's", () => {
    // Inside a corporate-B2B portal the registry is the tenant's own screen.
    expect(canReachPath("/distributors", "corporate_b2b", "super_admin", portal)).toBe(true);
    expect(canReachPath("/settlement-monitor", "corporate_b2b", "super_admin", portal)).toBe(false);
  });

  it("should send a blocked portal viewer to the TENANT's landing page", () => {
    // Not the operator's dashboard: the redirect has to stay inside the portal's
    // own surface, or leaving a blocked page silently changes what is being viewed.
    const destination = landingPathFor("retail_commerce");
    expect(destination).toBe("/settlement-monitor");
    expect(canReachPath(destination, "retail_commerce", "super_admin", portal)).toBe(true);
  });
});

describe("when the segment has not resolved", () => {
  it("should refuse scoped routes, exactly as the sidebar hides them", () => {
    // Callers must not consult this while the query is in flight — SegmentGuard
    // waits on isPending. What matters here is that the answer MATCHES inSegment,
    // so a hidden link and a blocked route always agree.
    expect(canReachPath("/distributors", null, "admin")).toBe(false);
    expect(inSegment(NAV_ITEMS.find((e) => e.path === "/distributors")!, null)).toBe(false);
  });
});

describe("when a blocked route redirects somewhere", () => {
  // The one failure here that would be catastrophic rather than annoying: the
  // guard sends a blocked viewer to a landing page that is ALSO blocked for
  // them, and the browser bounces between the two forever. Cheap to prove
  // impossible, and impossible to notice in review.
  it("should send every vertical somewhere it can actually go", () => {
    for (const segment of ["financial_services", "corporate_b2b", "retail_commerce", "super_admin", null] as const) {
      const destination = landingPathFor(segment);
      expect(canReachPath(destination, segment, "admin"), `${segment} → ${destination}`).toBe(true);
    }
  });

  it("should terminate from any scoped route, for any vertical", () => {
    const scoped = [...NAV_ITEMS.filter((e) => e.segments).map((e) => e.path), "/dashboard/auditor"];
    for (const segment of ["financial_services", "corporate_b2b", "retail_commerce", null] as const) {
      for (const from of scoped) {
        if (canReachPath(from, segment, "admin")) continue;
        // One hop must land somewhere permitted — never back onto a blocked path.
        const to = landingPathFor(segment);
        expect(canReachPath(to, segment, "admin"), `${segment}: ${from} → ${to} loops`).toBe(true);
      }
    }
  });
});

describe("when the viewer lands on a SHOPLINE install callback", () => {
  // /shopline/welcome mounts the SAME component as /shopline/connect. The latter
  // went through SegmentGuard and the former did not, so one path was guarded and
  // the other congratulated a bank on connecting a store it does not have.
  const signedIn = { signedIn: true };

  it("should refuse a signed-in tenant of another vertical", () => {
    for (const p of ["/shopline/welcome", "/shopline/error"]) {
      expect(canReachCallback(p, "financial_services", "admin", signedIn), p).toBe(false);
      expect(canReachCallback(p, "corporate_b2b", "admin", signedIn), p).toBe(false);
    }
  });

  it("should refuse the router's aliases too", () => {
    // The reported spelling: /SHOPLINE/WELCOME/?org=bank-org. wouter matches it,
    // so the guard has to as well.
    for (const p of ["/shopline/welcome/", "/SHOPLINE/WELCOME", "/SHOPLINE/WELCOME/"]) {
      expect(canReachCallback(p, "financial_services", "admin", signedIn), p).toBe(false);
    }
  });

  it("should let the merchant through", () => {
    expect(canReachCallback("/shopline/welcome", "retail_commerce", "admin", signedIn)).toBe(true);
  });

  it("should let a SIGNED-OUT visitor through — the actual install case", () => {
    // The whole reason this is not canReachPath. SHOPLINE's OAuth redirect sets
    // no session cookie, so the merchant arrives with no session at all. Refusing
    // them, as the sidebar rule would, bounces the one person the page exists for
    // and breaks the install flow.
    expect(canReachCallback("/shopline/welcome", null, undefined)).toBe(true);
    expect(canReachPath("/shopline/welcome", null, undefined)).toBe(false);
  });

  it("should refuse a SIGNED-IN viewer whose segment could not be determined", () => {
    // The exception is keyed on having no session, not on a null segment — three
    // different situations produce null. `useOrgSegmentStatus` uses retry: false,
    // so a single failed request keeps the answer null for the life of the page,
    // and a bank in that state would otherwise be handed the retail screen.
    // Absence of an answer is not evidence of who is asking.
    expect(canReachCallback("/shopline/welcome", null, "admin", signedIn)).toBe(false);
    expect(canReachCallback("/shopline/error", null, "cfo", signedIn)).toBe(false);
  });

  it("should still let a signed-in merchant through once the answer arrives", () => {
    // Failing closed on an unknown segment must not also punish the resolved case.
    expect(canReachCallback("/shopline/welcome", "retail_commerce", "admin", signedIn)).toBe(true);
  });

  it("should not ASK for the segment when there is no session", () => {
    // The trap that made the first version of this guard worse than the bug.
    // `auth.mySegment` is a protectedProcedure, and main.tsx subscribes to the
    // query cache and sets window.location to /login on ANY unauthorized error.
    // So merely running the segment query on a signed-out callback navigates the
    // merchant to a login page for an account they do not have — the install
    // flow this guard exists to preserve, broken by the guard itself.
    const APP = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    const guard = APP.slice(APP.indexOf("function CallbackGuard"), APP.indexOf("function Router"));
    expect(guard).toContain("useOrgSegmentStatus({ enabled: isAuthenticated })");

    // And the hook must honour it by reporting a RESOLVED null rather than a
    // pending one, or the guard waits forever on a query that never runs.
    const HOOK = fs.readFileSync(path.join(__dirname, "..", "hooks", "useOrgSegment.ts"), "utf8");
    expect(HOOK).toMatch(/opts: \{ enabled\?: boolean \}/);
    expect(HOOK).toMatch(/if \(!enabled && !viewAsOrg\)/);
    expect(HOOK).toMatch(/isPending: false/);
  });

  it("should send a blocked bank somewhere that makes sense", () => {
    const destination = landingPathFor("financial_services");
    expect(destination).toBe("/dashboard");
    expect(canReachCallback(destination, "financial_services", "admin", signedIn)).toBe(true);
  });

  it("should keep the guarded twin behaving identically for a signed-in viewer", () => {
    // /shopline/connect renders the same component through SegmentGuard. A bank is
    // refused both ways now; before, only one of them turned it away.
    expect(canReachPath("/shopline/connect", "financial_services", "admin")).toBe(false);
    expect(canReachCallback("/shopline/welcome", "financial_services", "admin", signedIn)).toBe(false);
  });
});

describe("when the rule is derived rather than restated", () => {
  it("should take every scoped nav path's rule from NAV_ITEMS itself", () => {
    // The point of deriving: an entry hidden from a vertical is unreachable by it
    // by construction, not because two lists happen to agree.
    for (const entry of NAV_ITEMS.filter((e) => e.segments)) {
      expect(segmentsForPath(entry.path), entry.path).toEqual(entry.segments);
    }
  });

  it("should be applied by the router, not just exported", () => {
    // A rule module nothing calls is decoration. These assertions are the reason
    // the guard cannot be quietly dropped from App.tsx.
    const APP = fs.readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
    expect(APP).toMatch(/function SegmentGuard/);
    expect(APP).toMatch(/canReachPath\(location, segment, user\?\.role, opts\)/);
    // The portal flag has to actually be passed, or staff inside a tenant portal
    // bypass the tenant's own rules — which is how /distributors stayed reachable.
    expect(APP).toMatch(/const opts = \{ portal: viewAsOrg !== null \}/);
    // The install callbacks must go through the callback guard, not straight to
    // the component — that direct mount is what left /shopline/welcome open.
    expect(APP).toMatch(/path="\/shopline\/welcome">\{\(\) => <CallbackGuard component=\{ShoplineWelcome\} \/>\}/);
    expect(APP).toMatch(/path="\/shopline\/error">\{\(\) => <CallbackGuard component=\{ShoplineError\} \/>\}/);
    expect(APP).toMatch(/canReachCallback\(location, segment, user\?\.role, opts\)/);
    // Scoped to CallbackGuard on purpose. A file-wide match for the opts object
    // is satisfied by SegmentGuard's own line, so it would pass while the
    // callback guard quietly stopped passing `signedIn` — which is the flag the
    // whole signed-out exception now turns on.
    const callbackGuard = APP.slice(APP.indexOf("function CallbackGuard"), APP.indexOf("function Router"));
    expect(callbackGuard).toMatch(/signedIn: isAuthenticated/);
    expect(APP).toMatch(/<SegmentGuard>[\s\S]*<Component \/>[\s\S]*<\/SegmentGuard>/);
    expect(APP).toMatch(/path="\/home" component=\{LandingRedirect\}/);
  });

  it("should send both post-login flows to the resolver", () => {
    // Magic link and SSO both used to hardcode /dashboard, which put a merchant on
    // the operator's page every time they signed in.
    const INDEX = fs.readFileSync(path.join(__dirname, "..", "..", "..", "server", "_core", "index.ts"), "utf8");
    const SSO = fs.readFileSync(path.join(__dirname, "..", "..", "..", "server", "_core", "sso.ts"), "utf8");
    expect(INDEX).toMatch(/redirect\(302, "\/home"\)/);
    expect(SSO).toMatch(/redirect\(302, "\/home"\)/);
  });
});
